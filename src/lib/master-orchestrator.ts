import { queryAll } from '@/lib/db';
import type { Agent } from '@/lib/types';

export type MasterOrchestratorResult =
  | { ok: true; agent: Agent }
  | { ok: false; reason: 'none' | 'multiple'; candidates: Agent[] };

/**
 * Resolve the single master orchestrator for a workspace.
 *
 * The roll-call feature (and any future feature that needs a workspace-wide
 * "governing" agent) requires exactly one agent marked `is_master=1`. We
 * return a tagged union so callers can raise the right alert:
 *   - `none`: no master exists → operator must mark one via
 *     `PATCH /api/agents/[id]` with { is_master: true }
 *   - `multiple`: more than one → operator must pick by un-marking the others
 *
 * Non-active agents (`is_active = 0`) and offline agents are excluded from
 * consideration — a disabled orchestrator doesn't count even if its
 * `is_master` flag is still set in the DB.
 */
export function resolveMasterOrchestrator(workspaceId: string): MasterOrchestratorResult {
  const candidates = queryAll<Agent>(
    `SELECT * FROM agents
       WHERE is_master = 1
         AND workspace_id = ?
         AND COALESCE(is_active, 1) = 1
         AND COALESCE(status, 'standby') != 'offline'
       ORDER BY updated_at DESC`,
    [workspaceId]
  );

  if (candidates.length === 0) {
    return { ok: false, reason: 'none', candidates: [] };
  }
  if (candidates.length > 1) {
    return { ok: false, reason: 'multiple', candidates };
  }
  return { ok: true, agent: candidates[0] };
}
