/**
 * workspace-export — dump every workspace-scoped table for a given
 * workspace_id to an in-memory JSON-shaped object. Shared by the
 * settings-page download button and the `scripts/export-workspace.ts`
 * CLI so both stay aligned on what "export everything" means.
 *
 * The output is INSERT-shaped: { tables: { name: [rows] } }. Rows are
 * unmodified — JSON-serialised SQLite values. A future
 * `import-workspace` can iterate `tables` in dependency order and
 * INSERT row-by-row.
 *
 * What's included:
 *   - Direct workspace_id-scoped tables (workspaces row, agents,
 *     tasks, initiatives, products, knowledge, PM proposals, …).
 *   - Tables linked to workspace via a parent (task_activities,
 *     task_deliverables, initiative_dependencies, etc.).
 *
 * What's NOT included by default (transient/large):
 *   - agent_mailbox, agent_chat_messages, agent_health
 *   - openclaw_sessions
 *   These are gated behind `includeTransient: true`.
 *
 * What's never included:
 *   - Truly global tables (debug_events, businesses, …) — they aren't
 *     workspace-scoped and don't belong in a workspace export.
 */

import type Database from 'better-sqlite3';

export interface ExportOptions {
  includeTransient?: boolean;
}

export interface ExportOutput {
  version: 1;
  workspace_id: string;
  exported_at: string;
  schema_migration: string | null;
  include_transient: boolean;
  table_counts: Record<string, number>;
  tables: Record<string, unknown[]>;
}

/**
 * Tables with a direct workspace_id column.
 */
const DIRECT_TABLES = [
  'workspaces',           // the row itself
  'agents',
  'tasks',
  'workflow_templates',
  'knowledge_entries',
  'rollcall_sessions',
  'products',
  'cost_events',
  'cost_caps',
  'initiatives',
  'pm_proposals',
  'pm_pending_notes',
] as const;

interface IndirectTable {
  table: string;
  joinSql: string;
  transient?: boolean;
}

/**
 * Tables linked to a workspace via a parent table. The query joins
 * through the parent column to filter by workspace_id.
 */
const INDIRECT_TABLES: IndirectTable[] = [
  // Task-linked
  { table: 'task_roles',                joinSql: 'SELECT t.* FROM task_roles t JOIN tasks p ON t.task_id = p.id WHERE p.workspace_id = ?' },
  { table: 'task_activities',           joinSql: 'SELECT t.* FROM task_activities t JOIN tasks p ON t.task_id = p.id WHERE p.workspace_id = ?' },
  { table: 'task_deliverables',         joinSql: 'SELECT t.* FROM task_deliverables t JOIN tasks p ON t.task_id = p.id WHERE p.workspace_id = ?' },
  { table: 'task_notes',                joinSql: 'SELECT t.* FROM task_notes t JOIN tasks p ON t.task_id = p.id WHERE p.workspace_id = ?' },
  { table: 'task_initiative_history',   joinSql: 'SELECT t.* FROM task_initiative_history t JOIN tasks p ON t.task_id = p.id WHERE p.workspace_id = ?' },
  { table: 'user_task_reads',           joinSql: 'SELECT t.* FROM user_task_reads t JOIN tasks p ON t.task_id = p.id WHERE p.workspace_id = ?' },
  { table: 'work_checkpoints',          joinSql: 'SELECT t.* FROM work_checkpoints t JOIN tasks p ON t.task_id = p.id WHERE p.workspace_id = ?' },

  // Initiative-linked
  { table: 'initiative_dependencies',   joinSql: 'SELECT t.* FROM initiative_dependencies t JOIN initiatives p ON t.initiative_id = p.id WHERE p.workspace_id = ?' },
  { table: 'initiative_parent_history', joinSql: 'SELECT t.* FROM initiative_parent_history t JOIN initiatives p ON t.initiative_id = p.id WHERE p.workspace_id = ?' },

  // Rollcall-linked. FK column on rollcall_entries is rollcall_id.
  { table: 'rollcall_entries',          joinSql: 'SELECT t.* FROM rollcall_entries t JOIN rollcall_sessions p ON t.rollcall_id = p.id WHERE p.workspace_id = ?' },

  // Agent-linked
  { table: 'owner_availability',        joinSql: 'SELECT t.* FROM owner_availability t JOIN agents p ON t.agent_id = p.id WHERE p.workspace_id = ?' },

  // Convoy chains (task-rooted via parent_task_id)
  { table: 'convoys',                   joinSql: 'SELECT t.* FROM convoys t JOIN tasks p ON t.parent_task_id = p.id WHERE p.workspace_id = ?' },
  { table: 'convoy_subtasks',           joinSql: 'SELECT t.* FROM convoy_subtasks t JOIN convoys c ON t.convoy_id = c.id JOIN tasks p ON c.parent_task_id = p.id WHERE p.workspace_id = ?' },

  // Transient: chat / mailbox / sessions. agent_mailbox has from_/to_
  // agent ids — pick rows where either endpoint belongs to this
  // workspace (DISTINCT in case both endpoints match).
  { table: 'agent_mailbox',             joinSql: 'SELECT DISTINCT t.* FROM agent_mailbox t JOIN agents p ON (t.from_agent_id = p.id OR t.to_agent_id = p.id) WHERE p.workspace_id = ?', transient: true },
  { table: 'agent_health',              joinSql: 'SELECT t.* FROM agent_health t JOIN agents p ON t.agent_id = p.id WHERE p.workspace_id = ?', transient: true },
  { table: 'agent_chat_messages',       joinSql: 'SELECT t.* FROM agent_chat_messages t JOIN agents p ON t.agent_id = p.id WHERE p.workspace_id = ?', transient: true },
  { table: 'openclaw_sessions',         joinSql: 'SELECT t.* FROM openclaw_sessions t JOIN agents p ON t.agent_id = p.id WHERE p.workspace_id = ?', transient: true },
];

export class WorkspaceNotFoundError extends Error {
  constructor(public workspaceId: string) {
    super(`No workspace with id "${workspaceId}"`);
    this.name = 'WorkspaceNotFoundError';
  }
}

/**
 * Run the export against an open SQLite handle. The handle is used
 * read-only — only `prepare().all()` is called.
 */
export function exportWorkspace(
  db: Database.Database,
  workspaceId: string,
  opts: ExportOptions = {},
): ExportOutput {
  const includeTransient = opts.includeTransient ?? false;

  // Sanity-check the workspace exists.
  const workspaceRow = db
    .prepare('SELECT id FROM workspaces WHERE id = ?')
    .get(workspaceId) as { id: string } | undefined;
  if (!workspaceRow) {
    throw new WorkspaceNotFoundError(workspaceId);
  }

  // Best-effort schema version capture.
  let migration: string | null = null;
  try {
    const row = db
      .prepare('SELECT name FROM migrations ORDER BY id DESC LIMIT 1')
      .get() as { name?: string } | undefined;
    if (row?.name) migration = row.name;
  } catch {
    // migrations table may not exist or have a different schema; keep null
  }

  // Existing-tables set so optional tables don't blow up.
  const existingTables = new Set(
    (db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>).map((r) => r.name),
  );

  const out: ExportOutput = {
    version: 1,
    workspace_id: workspaceId,
    exported_at: new Date().toISOString(),
    schema_migration: migration,
    include_transient: includeTransient,
    table_counts: {},
    tables: {},
  };

  for (const table of DIRECT_TABLES) {
    if (!existingTables.has(table)) continue;
    const sql =
      table === 'workspaces'
        ? `SELECT * FROM workspaces WHERE id = ?`
        : `SELECT * FROM ${table} WHERE workspace_id = ?`;
    const rows = db.prepare(sql).all(workspaceId);
    out.tables[table] = rows;
    out.table_counts[table] = rows.length;
  }

  for (const def of INDIRECT_TABLES) {
    if (!existingTables.has(def.table)) continue;
    if (def.transient && !includeTransient) continue;
    const rows = db.prepare(def.joinSql).all(workspaceId);
    out.tables[def.table] = rows;
    out.table_counts[def.table] = rows.length;
  }

  return out;
}

/**
 * Suggested filename for a workspace export, used by both the API
 * route's Content-Disposition header and the CLI's default `--out`.
 */
export function defaultExportFilename(workspaceId: string, exportedAt: string): string {
  return `mc-workspace-${workspaceId}-${exportedAt.replace(/[:.]/g, '-')}.json`;
}
