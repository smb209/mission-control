/**
 * workspace-import — counterpart to workspace-export. Reads a JSON
 * dump produced by `exportWorkspace` and INSERTs its rows into a
 * target workspace in an open SQLite handle.
 *
 * Two modes:
 *   - Import into an EXISTING workspace (rows from the export adopt
 *     that workspace_id; row PKs are kept as-is so a re-run is a
 *     no-op via INSERT OR IGNORE).
 *   - Import into a NEW workspace, created up-front from
 *     {id, slug, name, icon, description}. The workspace row from the
 *     export itself is never imported — we always materialise a fresh
 *     workspaces row so slugs/ids stay under the operator's control.
 *
 * Cross-table FKs that point at things we DON'T import (agents,
 * products, ideas, source workspaces) are NULLed on insert so the
 * imported rows don't dangle into resources from the source DB.
 *
 * Insert order respects parent → child FKs. Tables not in the export
 * (or filtered out via `tables`) are silently skipped.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface ImportInput {
  version: number;
  workspace_id: string;
  tables: Record<string, unknown[]>;
  table_counts?: Record<string, number>;
  schema_migration?: string | null;
  include_transient?: boolean;
}

export interface ImportOptions {
  /**
   * Target workspace id. Required when `createWorkspace` is false.
   * When `createWorkspace` is true, this becomes the new workspace's id;
   * if omitted, a UUID is generated.
   */
  workspaceId?: string;
  /**
   * If set, the import creates a fresh workspaces row before inserting.
   * The row from the export is discarded.
   */
  createWorkspace?: {
    name: string;
    slug?: string;
    icon?: string | null;
    description?: string | null;
  };
  /**
   * Restrict the import to this set of table names (still in dependency
   * order). Omit to import every non-transient table present in the
   * export.
   */
  tables?: string[];
  /**
   * Include transient tables (chat / mailbox / sessions / health) if the
   * export carried them. Default false.
   */
  includeTransient?: boolean;
  /**
   * Don't actually write — just compute and return what would happen.
   */
  dryRun?: boolean;
}

export interface ImportResult {
  workspace_id: string;
  created_workspace: boolean;
  inserted: Record<string, number>;
  skipped: Record<string, number>;
  /** Tables present in the export but not loaded (filtered out, transient, missing in target schema). */
  ignored_tables: string[];
  /** Per-table count of FK columns NULLed because the referent wasn't in the target. */
  fk_nulled: Record<string, number>;
}

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

/**
 * Tables we know how to import, in parent→child order so FKs satisfy
 * within a single transaction. Keep aligned with workspace-export's
 * DIRECT_TABLES / INDIRECT_TABLES; tables not in this list are
 * silently skipped (see `ignored_tables` in the result).
 *
 * `workspaces` is intentionally absent — we materialise that row
 * outside the row-import loop.
 */
const ORDERED_TABLES: ReadonlyArray<{ table: string; transient?: boolean }> = [
  // Direct
  { table: 'agents' },
  { table: 'products' },
  { table: 'workflow_templates' },
  { table: 'knowledge_entries' },
  { table: 'cost_caps' },
  { table: 'cost_events' },
  { table: 'rollcall_sessions' },
  { table: 'tasks' },
  { table: 'initiatives' },
  { table: 'pm_proposals' },
  { table: 'pm_pending_notes' },
  // Indirect — task-linked
  { table: 'task_roles' },
  { table: 'task_activities' },
  { table: 'task_deliverables' },
  { table: 'task_notes' },
  { table: 'task_initiative_history' },
  { table: 'user_task_reads' },
  { table: 'work_checkpoints' },
  // Indirect — initiative-linked
  { table: 'initiative_dependencies' },
  { table: 'initiative_parent_history' },
  // Rollcall-linked
  { table: 'rollcall_entries' },
  // Agent-linked
  { table: 'owner_availability' },
  // Convoys
  { table: 'convoys' },
  { table: 'convoy_subtasks' },
  // Transient
  { table: 'agent_mailbox', transient: true },
  { table: 'agent_health', transient: true },
  { table: 'agent_chat_messages', transient: true },
  { table: 'openclaw_sessions', transient: true },
];

function generateSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base.length > 0 ? base : 'workspace';
}

interface FkInfo {
  from: string;
  to: string;
  table: string;
}

interface TableMeta {
  cols: string[];
  pk: string | null;
  fks: FkInfo[];
}

function readTableMeta(db: Database.Database, table: string): TableMeta {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    pk: number;
  }>);
  const pkRow = cols.find((c) => c.pk > 0);
  const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as FkInfo[];
  return {
    cols: cols.map((c) => c.name),
    pk: pkRow?.name ?? null,
    fks,
  };
}

/**
 * For each FK column on `table` that points at a table outside our
 * import set, return a check that returns true when the value exists in
 * the target DB. Used to NULL dangling refs (e.g. owner_agent_id on
 * initiatives when we're not importing agents).
 *
 * FKs that point at tables we ARE importing are left alone — those
 * rows get inserted in the same transaction and will resolve.
 */
function buildFkNullers(
  db: Database.Database,
  meta: TableMeta,
  importedTables: Set<string>,
): Map<string, (value: unknown) => boolean> {
  const out = new Map<string, (value: unknown) => boolean>();
  for (const fk of meta.fks) {
    if (importedTables.has(fk.table)) continue; // self-resolves in this batch
    if (fk.table === 'workspaces') continue; // handled by workspace_id rewrite
    // Probe the target DB to see if the value exists.
    const stmt = db.prepare(`SELECT 1 FROM ${fk.table} WHERE "${fk.to}" = ? LIMIT 1`);
    out.set(fk.from, (value) => {
      if (value === null || value === undefined) return true;
      return stmt.get(value) !== undefined;
    });
  }
  return out;
}

/**
 * The export serialises each row as an object (SELECT * .all()), so
 * that's what we expect on the way back in.
 */
function isRowObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function importWorkspace(
  db: Database.Database,
  input: ImportInput,
  opts: ImportOptions = {},
): ImportResult {
  if (input.version !== 1) {
    throw new ImportError(`Unsupported export version: ${input.version}`);
  }
  if (!input.tables || typeof input.tables !== 'object') {
    throw new ImportError('Export is missing `tables`');
  }

  // Decide target workspace.
  let createdWorkspace = false;
  let targetWorkspaceId: string;
  if (opts.createWorkspace) {
    targetWorkspaceId = opts.workspaceId ?? randomUUID();
    createdWorkspace = true;
  } else {
    if (!opts.workspaceId) {
      throw new ImportError('workspaceId is required when not creating a new workspace');
    }
    targetWorkspaceId = opts.workspaceId;
    const exists = db
      .prepare('SELECT id FROM workspaces WHERE id = ?')
      .get(targetWorkspaceId);
    if (!exists) {
      throw new ImportError(
        `Target workspace "${targetWorkspaceId}" does not exist. Pass createWorkspace to materialise it.`,
      );
    }
  }

  // Resolve which tables to actually import.
  const includeTransient = opts.includeTransient ?? false;
  const filter = opts.tables ? new Set(opts.tables) : null;
  const existingTables = new Set(
    (db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>).map((r) => r.name),
  );

  const tablesToImport: string[] = [];
  const ignored: string[] = [];
  for (const def of ORDERED_TABLES) {
    if (def.transient && !includeTransient) {
      if (input.tables[def.table]?.length) ignored.push(def.table);
      continue;
    }
    if (filter && !filter.has(def.table)) continue;
    if (!input.tables[def.table]) continue;
    if (!existingTables.has(def.table)) {
      ignored.push(def.table);
      continue;
    }
    tablesToImport.push(def.table);
  }

  // Anything in the export that we didn't recognise (or that's the
  // workspaces row we deliberately skip) — note it for the operator.
  for (const t of Object.keys(input.tables)) {
    if (t === 'workspaces') continue;
    if (tablesToImport.includes(t)) continue;
    if (!ignored.includes(t)) ignored.push(t);
  }

  const importedSet = new Set(tablesToImport);
  const inserted: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const fkNulled: Record<string, number> = {};

  if (opts.dryRun) {
    for (const t of tablesToImport) {
      const rows = input.tables[t] ?? [];
      inserted[t] = rows.length; // optimistic estimate
      skipped[t] = 0;
    }
    return {
      workspace_id: targetWorkspaceId,
      created_workspace: createdWorkspace,
      inserted,
      skipped,
      ignored_tables: ignored,
      fk_nulled: fkNulled,
    };
  }

  const tx = db.transaction(() => {
    db.pragma('foreign_keys = OFF');

    // 1. Materialise the workspace row if asked.
    if (createdWorkspace) {
      const cw = opts.createWorkspace!;
      const slug = cw.slug ?? generateSlug(cw.name);
      const slugCollision = db
        .prepare('SELECT id FROM workspaces WHERE slug = ?')
        .get(slug);
      if (slugCollision) {
        throw new ImportError(`Workspace slug "${slug}" already exists`);
      }
      const idCollision = db
        .prepare('SELECT id FROM workspaces WHERE id = ?')
        .get(targetWorkspaceId);
      if (idCollision) {
        throw new ImportError(`Workspace id "${targetWorkspaceId}" already exists`);
      }
      db.prepare(
        `INSERT INTO workspaces (id, name, slug, description, icon)
           VALUES (?, ?, ?, ?, ?)`,
      ).run(targetWorkspaceId, cw.name, slug, cw.description ?? null, cw.icon ?? '📁');
    }

    // 2. Insert each imported table.
    for (const table of tablesToImport) {
      const rows = (input.tables[table] ?? []).filter(isRowObject);
      if (rows.length === 0) {
        inserted[table] = 0;
        skipped[table] = 0;
        continue;
      }

      const meta = readTableMeta(db, table);
      const fkNullers = buildFkNullers(db, meta, importedSet);
      const hasWorkspaceCol = meta.cols.includes('workspace_id');

      // Restrict inserted columns to those that still exist in the
      // target schema (export may pre-date a column drop, etc.).
      const exportCols = Object.keys(rows[0]!);
      const useCols = exportCols.filter((c) => meta.cols.includes(c));
      if (useCols.length === 0) {
        skipped[table] = rows.length;
        inserted[table] = 0;
        continue;
      }

      const placeholders = useCols.map(() => '?').join(', ');
      // INSERT OR IGNORE — re-runs are a no-op for unchanged rows.
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO ${table} (${useCols
          .map((c) => `"${c}"`)
          .join(', ')}) VALUES (${placeholders})`,
      );

      let ins = 0;
      let skip = 0;
      let nulled = 0;
      for (const row of rows) {
        const vals: unknown[] = useCols.map((c) => {
          if (c === 'workspace_id' && hasWorkspaceCol) return targetWorkspaceId;
          let v = row[c];
          const check = fkNullers.get(c);
          if (check && !check(v)) {
            nulled++;
            v = null;
          }
          return v ?? null;
        });
        const r = stmt.run(...vals);
        if (r.changes > 0) ins++;
        else skip++;
      }
      inserted[table] = ins;
      skipped[table] = skip;
      if (nulled > 0) fkNulled[table] = nulled;
    }

    db.pragma('foreign_keys = ON');
  });
  tx();

  return {
    workspace_id: targetWorkspaceId,
    created_workspace: createdWorkspace,
    inserted,
    skipped,
    ignored_tables: ignored,
    fk_nulled: fkNulled,
  };
}
