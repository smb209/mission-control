/**
 * Workspace cascade-delete helper.
 *
 * As of migration 048, every FK that targets `workspaces`, `tasks`,
 * `agents`, `initiatives`, `products`, `ideas`, etc. carries an explicit
 * `ON DELETE CASCADE` or `ON DELETE SET NULL` rule (see
 * `schema-cascade.test.ts` for the guardrail). Deleting a workspace
 * triggers a transitive cascade through the FK graph that empties:
 *
 *   workspace → tasks → (planning_*, task_*, work_checkpoints,
 *                        workspace_ports, workspace_merges,
 *                        skill_reports, openclaw_sessions, …)
 *   workspace → agents → (agent_health, agent_chat_messages,
 *                         agent_mailbox, rollcall_sessions, …)
 *   workspace → initiatives → (initiative_dependencies,
 *                              initiative_parent_history,
 *                              task_initiative_history)
 *   workspace → products → (research_cycles, ideas, ideation_cycles,
 *                           product_skills, content_inventory, …)
 *   workspace → workflow_templates / knowledge_entries / pm_proposals /
 *               cost_caps / cost_events / rollcall_sessions
 *
 * The helper here therefore collapses to a single `DELETE FROM workspaces`
 * inside a transaction. We still snapshot the cascade counts up front so
 * the caller can show "this will delete N tasks / M agents / …" in the UI
 * confirm modal.
 *
 * `getWorkspaceCascadeCounts` walks the workspace-scoped tables to render
 * the operator's confirmation modal — that's a read concern, decoupled
 * from how the delete actually executes.
 */

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

  // Single DELETE; the FK graph (migration 048) cascades through every
  // dependent table. Wrapping in a transaction keeps the cascade atomic
  // and gives us a clean rollback if any FK trigger throws.
  db.transaction(() => {
    const result = db
      .prepare('DELETE FROM workspaces WHERE id = ?')
      .run(workspaceId);
    if (result.changes === 0) {
      // Could happen in a TOCTOU race with another deleter — surface as
      // an error so the caller can refresh.
      throw new Error(`Workspace not found at delete time: ${workspaceId}`);
    }
  })();

  return counts;
}
