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
 * Ensure the workspace has a PM (role='pm') agent. Idempotent. Reads the
 * soul_md from the .md file next to the pm-agent module so operators can
 * tweak the prompt without redeploying. Safe to call from API routes.
 *
 * The PM is now seeded as a NAMED gateway agent (source='gateway') linked
 * to the openclaw workspace at `~/.openclaw/workspaces/mc-project-manager/`.
 * That workspace ships with full agent files (SOUL.md, IDENTITY.md, etc.)
 * — same pattern as mc-coordinator/mc-builder/etc. The `gateway_agent_id`
 * + `session_key_prefix` are what let `resolveAgentSessionKeyPrefix` route
 * real chat.send traffic to the gateway-hosted PM session.
 *
 * Migration 045 originally seeded PMs as ephemeral source='local' rows
 * with no gateway link; migration 049 backfills those rows so they pick
 * up the new routing.
 *
 * If a PM row already exists for the workspace this function does NOT
 * mutate it — operators may have customised it, and migration 049 owns
 * the backfill for older rows.
 */
export const PM_GATEWAY_AGENT_ID = 'mc-project-manager';
export const PM_SESSION_KEY_PREFIX = `agent:${PM_GATEWAY_AGENT_ID}:main`;
export const PM_NAMED_AGENT_NAME = 'Margaret "Maps" Hamilton';
export const PM_NAMED_AGENT_AVATAR = '🗺️';

export function ensurePmAgent(workspaceId: string): { id: string; created: boolean } {
  const db = getDb();
  const existing = db.prepare(
    `SELECT id FROM agents WHERE workspace_id = ? AND role = 'pm' LIMIT 1`,
  ).get(workspaceId) as { id: string } | undefined;
  if (existing) return { id: existing.id, created: false };

  // Lazy-import to avoid circular deps during migration startup.
  // pm-agent.ts is plain TS with no DB imports so it's safe everywhere.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getPmSoulMd, PM_AGENT_DESCRIPTION } = require('./agents/pm-agent') as typeof import('./agents/pm-agent');

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // source='gateway' matches the convention used by agent-catalog-sync
  // for every gateway-hosted named agent (mc-coordinator, mc-builder, …).
  db.prepare(`
    INSERT INTO agents (
      id, name, role, description, avatar_emoji, status, is_master,
      workspace_id, soul_md, source, gateway_agent_id, session_key_prefix,
      is_active, created_at, updated_at
    ) VALUES (?, ?, 'pm', ?, ?, 'standby', 0, ?, ?, 'gateway', ?, ?, 1, ?, ?)
  `).run(
    id,
    PM_NAMED_AGENT_NAME,
    PM_AGENT_DESCRIPTION,
    PM_NAMED_AGENT_AVATAR,
    workspaceId,
    getPmSoulMd(),
    PM_GATEWAY_AGENT_ID,
    PM_SESSION_KEY_PREFIX,
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
