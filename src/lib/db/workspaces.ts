/**
 * Workspace cascade-delete helper.
 *
 * Mission Control's schema doesn't put `ON DELETE CASCADE` on the FK from
 * workspace-scoped tables (tasks, agents, products, …) back to `workspaces`,
 * and it doesn't always cascade FROM tasks/agents into their dependent
 * tables either (e.g. `events.task_id` is a plain reference). Naively
 * issuing `DELETE FROM workspaces WHERE id = ?` would either fail with a
 * FK constraint, or silently leave orphan rows behind.
 *
 * `deleteWorkspaceCascade` walks the dependency graph in reverse and
 * deletes everything the workspace owns inside a single transaction. We
 * temporarily disable FK checks while doing it (1) so the order of
 * deletions doesn't have to be perfect across edge-case schemas seen in
 * the field, and (2) so cascades from earlier rows don't fight with
 * explicit deletes from later ones.
 *
 * `getWorkspaceCascadeCounts` returns the row counts the operator will
 * see in the confirmation modal, so we can render an honest "this will
 * delete X tasks, Y agents, …" warning before actually destroying
 * anything.
 */

import type Database from 'better-sqlite3';
import { getDb } from './index';

export interface WorkspaceCascadeCounts {
  tasks: number;
  agents: number;
  initiatives: number;
  products: number;
  knowledgeEntries: number;
  workflowTemplates: number;
  pmProposals: number;
  costEvents: number;
  costCaps: number;
  rollcallSessions: number;
}

/** Tables scoped directly by workspace_id. Order matters for FK safety
 *  even with FKs disabled — we keep the same order in the deletion
 *  routine so it's easy to follow. */
const WORKSPACE_SCOPED_TABLES = [
  'pm_proposals',
  'cost_caps',
  'cost_events',
  'rollcall_sessions',
  'knowledge_entries',
  'workflow_templates',
  'products',
  'initiatives',
  'tasks',
  'agents',
] as const;

/**
 * Tables whose rows reference a task via `task_id`. We delete any row
 * that points at one of the workspace's tasks BEFORE we delete the
 * tasks themselves, because the cascade-delete-with-FK-OFF strategy we
 * use means SQLite's ON DELETE CASCADE triggers don't fire — we have
 * to explicitly clean every dependent ourselves.
 *
 * Includes both ON DELETE CASCADE tables (where the cascade would
 * normally fire) and plain references.
 */
const TASK_REF_TABLES = [
  // Cascading children (would auto-delete if FKs were on; we list them
  // anyway because we run with FKs off for atomicity).
  'planning_questions',
  'planning_specs',
  'task_roles',
  'task_activities',
  'task_deliverables',
  'work_checkpoints',
  'task_notes',
  'user_task_reads',
  'task_initiative_history',
  // Non-cascading task references.
  'workspace_ports',
  'workspace_merges',
  'conversations',
  'events',
  'openclaw_sessions',
  'messages',
  'ideas',
  'skill_reports',
  'debug_events',
] as const;

/**
 * Tables whose rows reference an agent via `agent_id` (or similar).
 * Same rationale as TASK_REF_TABLES — we explicitly snipe all
 * referencing rows because cascades don't fire with FKs off.
 */
const AGENT_REF_TABLES = [
  // Cascade-on-delete dependents.
  'agent_health',
  'agent_chat_messages',
  'owner_availability',
  // Plain references.
  'messages',
  'events',
  'openclaw_sessions',
  'agent_mailbox',
  'rollcall_entries',
  'autopilot_activity_log',
  'debug_events',
  'task_initiative_history',
  'initiative_parent_history',
] as const;

/**
 * Tables that reference convoys (id from convoys), which themselves
 * cascade off tasks. With FKs off, we need to clean these too.
 */
const CONVOY_REF_TABLES = ['convoy_subtasks', 'agent_mailbox'] as const;

/**
 * Counts rows the operator will lose when a given workspace is deleted.
 * Cheap to call — one query per table.
 */
export function getWorkspaceCascadeCounts(workspaceId: string): WorkspaceCascadeCounts {
  const db = getDb();
  const count = (sql: string): number => {
    try {
      const row = db.prepare(sql).get(workspaceId) as { c: number } | undefined;
      return row?.c ?? 0;
    } catch {
      // Table may not exist on older databases pre-migration. Treat as 0.
      return 0;
    }
  };

  return {
    tasks: count('SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ?'),
    agents: count('SELECT COUNT(*) as c FROM agents WHERE workspace_id = ?'),
    initiatives: count('SELECT COUNT(*) as c FROM initiatives WHERE workspace_id = ?'),
    products: count('SELECT COUNT(*) as c FROM products WHERE workspace_id = ?'),
    knowledgeEntries: count('SELECT COUNT(*) as c FROM knowledge_entries WHERE workspace_id = ?'),
    workflowTemplates: count('SELECT COUNT(*) as c FROM workflow_templates WHERE workspace_id = ?'),
    pmProposals: count('SELECT COUNT(*) as c FROM pm_proposals WHERE workspace_id = ?'),
    costEvents: count('SELECT COUNT(*) as c FROM cost_events WHERE workspace_id = ?'),
    costCaps: count('SELECT COUNT(*) as c FROM cost_caps WHERE workspace_id = ?'),
    rollcallSessions: count('SELECT COUNT(*) as c FROM rollcall_sessions WHERE workspace_id = ?'),
  };
}

/**
 * Permanently deletes a workspace and every row that belongs to it.
 *
 * Returns the cascade counts (snapshot from before the delete) for the
 * caller to surface in audit logs / response payloads.
 *
 * Throws if the workspace doesn't exist or is the special `default`
 * workspace.
 */
export function deleteWorkspaceCascade(workspaceId: string): WorkspaceCascadeCounts {
  const db = getDb();

  const ws = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId) as
    | { id: string }
    | undefined;
  if (!ws) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  if (workspaceId === 'default') {
    throw new Error('Cannot delete the default workspace');
  }

  const counts = getWorkspaceCascadeCounts(workspaceId);

  // We disable FKs for the duration of the transaction so the explicit
  // deletes can run in any order without tripping pending references.
  // SQLite restores the previous FK state on COMMIT/ROLLBACK boundary
  // because pragmas live on the connection.
  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      // Pre-collect IDs we'll need to scrub from referencing tables.
      const taskIds = (db
        .prepare('SELECT id FROM tasks WHERE workspace_id = ?')
        .all(workspaceId) as { id: string }[]).map(r => r.id);
      const agentIds = (db
        .prepare('SELECT id FROM agents WHERE workspace_id = ?')
        .all(workspaceId) as { id: string }[]).map(r => r.id);
      // Convoys live as parent_task_id → tasks; gather convoy ids so
      // we can scrub their dependents too.
      let convoyIds: string[] = [];
      if (taskIds.length > 0) {
        convoyIds = chunkInQuery(
          db,
          'SELECT id FROM convoys WHERE parent_task_id IN',
          taskIds,
        ).map(r => (r as { id: string }).id);
      }

      // 1. Scrub convoy dependents first (they FK into convoys.id).
      if (convoyIds.length > 0) {
        for (const table of CONVOY_REF_TABLES) {
          deleteByColumnIn(db, table, 'convoy_id', convoyIds);
        }
      }
      // Then drop the convoys themselves so nothing references them.
      if (taskIds.length > 0) {
        deleteByColumnIn(db, 'convoys', 'parent_task_id', taskIds);
      }

      // 2. Scrub all task references. Cascading rows are listed too —
      // since we're running with FKs off, the schema's CASCADE triggers
      // don't fire, so we have to delete them ourselves.
      if (taskIds.length > 0) {
        for (const table of TASK_REF_TABLES) {
          deleteByColumnIn(db, table, 'task_id', taskIds);
        }
      }

      // 3. Scrub all agent references.
      if (agentIds.length > 0) {
        for (const table of AGENT_REF_TABLES) {
          deleteByColumnIn(db, table, 'agent_id', agentIds);
        }
        // Tables with non-`agent_id` agent columns:
        deleteByColumnIn(db, 'agent_mailbox', 'from_agent_id', agentIds);
        deleteByColumnIn(db, 'agent_mailbox', 'to_agent_id', agentIds);
        deleteByColumnIn(db, 'rollcall_sessions', 'initiator_agent_id', agentIds);
        deleteByColumnIn(db, 'rollcall_entries', 'target_agent_id', agentIds);
        deleteByColumnIn(db, 'messages', 'sender_agent_id', agentIds);
      }

      // Delete every workspace-scoped table.
      for (const table of WORKSPACE_SCOPED_TABLES) {
        try {
          db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId);
        } catch (err) {
          // Surface the table name to help diagnose if something does
          // explode — but don't swallow the error. Re-throw so the
          // transaction rolls back.
          console.error(`[deleteWorkspaceCascade] failed deleting from ${table}:`, err);
          throw err;
        }
      }

      // Finally the workspace itself.
      db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
    });

    tx();
  } finally {
    // Re-enable FK enforcement on the connection regardless of outcome.
    db.pragma('foreign_keys = ON');
  }

  return counts;
}

/**
 * Helper: run a `SELECT … WHERE … IN (...)` against a chunked id list
 * and concatenate the rows. Uses parameterized placeholders so we
 * stay under SQLite's ~32k parameter cap.
 */
function chunkInQuery(
  db: Database.Database,
  selectPrefix: string,
  ids: string[],
): unknown[] {
  if (ids.length === 0) return [];
  const CHUNK = 500;
  const out: unknown[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    try {
      const rows = db.prepare(`${selectPrefix} (${placeholders})`).all(...chunk) as unknown[];
      out.push(...rows);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no such (table|column)/i.test(msg)) continue;
      throw err;
    }
  }
  return out;
}

/**
 * Helper: `DELETE FROM <table> WHERE <column> IN (...ids)`. Defends
 * against tables / columns that may not exist on an older database
 * (the catch swallows "no such column" / "no such table" so we don't
 * abort the whole cascade for a missing optional table).
 *
 * Uses a parameterized IN clause to keep it safe.
 */
function deleteByColumnIn(
  db: Database.Database,
  table: string,
  column: string,
  ids: string[],
): void {
  if (ids.length === 0) return;
  // SQLite has a hard parameter cap (~32k); chunk to be safe.
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    try {
      db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`).run(...chunk);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Tolerate schema drift — if the table or column doesn't exist
      // (an older db that hasn't been migrated to add e.g. debug_events),
      // skip it. Anything else re-throws so the transaction rolls back.
      if (/no such (table|column)/i.test(msg)) continue;
      throw err;
    }
  }
}
