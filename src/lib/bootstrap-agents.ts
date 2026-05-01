/**
 * Workspace bootstrap helpers.
 *
 * Worker agents (Builder, Tester, Reviewer, Learner, Researcher, Writer,
 * main) are gateway-synced from openclaw and arrive via
 * `agent-catalog-sync.ts` once the gateway is connected. The PM agent is
 * MC-side and is created/linked by `ensurePmAgent` (further down in this
 * file).
 *
 * The legacy `bootstrapCoreAgents` / `bootstrapCoreAgentsRaw` previously
 * inserted four hardcoded `source='local'` rows (Builder Agent /
 * Tester Agent / Reviewer Agent / Learner Agent) for any new workspace.
 * That ran before gateway sync had a chance to populate the same roles,
 * leaving the operator with duplicate rows on `/agents` (one local, one
 * gateway-linked) on every fresh DB.
 *
 * The functions are kept as no-ops so existing call sites and migration
 * 013 don't need to be patched. The new architectural rule:
 *
 *   - Worker roster: gateway sync only (mc-builder / mc-coordinator /
 *     mc-learner / mc-researcher / mc-reviewer / mc-tester / mc-writer /
 *     main).
 *   - PM agent: `ensurePmAgent(workspaceId)` (called from
 *     `POST /api/workspaces` and migration 049).
 *   - Workflow templates: `cloneWorkflowTemplates` (still active).
 */

import Database from 'better-sqlite3';
import { getDb } from '@/lib/db';

// ── Public API ──────────────────────────────────────────────────────

/**
 * No-op kept for back-compat with `POST /api/workspaces`. Worker agents
 * arrive via gateway sync; the PM is created by `ensurePmAgent`.
 */
export function bootstrapCoreAgents(_workspaceId: string): void {
  // Intentional no-op. See the file header for the rationale.
}

/**
 * No-op kept for back-compat with migration 013. The original behavior
 * (inserting four hardcoded local-source agent rows) caused duplicate
 * rows once gateway sync layered the real roles on top.
 */
export function bootstrapCoreAgentsRaw(
  _db: Database.Database,
  _workspaceId: string,
  _missionControlUrl: string,
): void {
  // Intentional no-op.
}

/**
 * Ensure the workspace has a PM agent. Idempotent.
 *
 * Pre-061 this seeded a hardcoded `mc-project-manager` gateway link with
 * a default name ("Margaret 'Maps' Hamilton"). That bound the PM identity
 * to a specific gateway agent, which broke when a dev DB cloned from
 * prod via `db:import-from-prod --agent-suffix=-dev` ended up routing
 * chat to the still-prod gateway session. The fix is to let operators
 * promote ANY existing agent via the AgentModal "PM for this workspace"
 * checkbox — `getPmAgent` resolves the chosen one.
 *
 * What this function still does on a fresh workspace: insert a generic
 * placeholder PM (local source, no gateway link, name "PM") so the /pm
 * UI has something to render before the operator promotes a real agent.
 * If a PM already exists (via is_pm=1 OR LOWER(role)='pm'), it's left
 * untouched — operators may have customized it, and migration 061
 * backfilled is_pm for legacy rows.
 */
export function ensurePmAgent(workspaceId: string): { id: string; created: boolean } {
  const db = getDb();
  const existing = db.prepare(
    `SELECT id FROM agents
       WHERE workspace_id = ? AND (is_pm = 1 OR LOWER(role) = 'pm')
       LIMIT 1`,
  ).get(workspaceId) as { id: string } | undefined;
  if (existing) return { id: existing.id, created: false };

  // Lazy-import to avoid circular deps during migration startup.
  // pm-agent.ts is plain TS with no DB imports so it's safe everywhere.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getPmSoulMd, PM_AGENT_DESCRIPTION } = require('./agents/pm-agent') as typeof import('./agents/pm-agent');

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // source='local', no gateway link — a placeholder. The operator
  // either edits this row to point at a gateway PM, or (more likely)
  // promotes a different existing gateway agent via the AgentModal
  // checkbox, which clears is_pm here and sets it on the new target.
  db.prepare(`
    INSERT INTO agents (
      id, name, role, description, avatar_emoji, status, is_master, is_pm,
      workspace_id, soul_md, source,
      is_active, created_at, updated_at
    ) VALUES (?, 'PM', 'pm', ?, '📋', 'standby', 0, 1, ?, ?, 'local', 1, ?, ?)
  `).run(
    id,
    PM_AGENT_DESCRIPTION,
    workspaceId,
    getPmSoulMd(),
    now,
    now,
  );
  return { id, created: true };
}

/**
 * Clone workflow templates from the default workspace into a new workspace.
 */
export function cloneWorkflowTemplates(db: Database.Database, targetWorkspaceId: string): void {
  const templates = db.prepare(
    "SELECT * FROM workflow_templates WHERE workspace_id = 'default'"
  ).all() as { id: string; name: string; description: string; stages: string; fail_targets: string; is_default: number }[];

  if (templates.length === 0) return;

  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO workflow_templates (id, workspace_id, name, description, stages, fail_targets, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const tpl of templates) {
    const newId = `${tpl.id}-${targetWorkspaceId}`;
    insert.run(newId, targetWorkspaceId, tpl.name, tpl.description, tpl.stages, tpl.fail_targets, tpl.is_default, now, now);
  }

  console.log(`[Bootstrap] Cloned ${templates.length} workflow template(s) to workspace ${targetWorkspaceId}`);
}
