/**
 * Single seam for "which agent is the PM for this workspace?".
 *
 * Phase I: each MC workspace has its own openclaw agent with
 * `gateway_agent_id` shaped `mc-pm-<slug>-(dev)?`. That agent IS
 * the workspace's PM. Memory storage is per-agent in openclaw
 * (`~/.openclaw/memory/<agentId>.sqlite` + LanceDB), giving
 * workspace-scoped isolation by construction.
 *
 * The resolver prefers per-workspace PMs first; it falls back to
 * the legacy paths (Phase H singleton runner, pre-061 placeholders)
 * for DBs that haven't migrated yet.
 */

import { queryOne } from '@/lib/db';
import type { Agent } from '@/lib/types';

export function getPmAgent(workspaceId: string): Agent | null {
  // Phase I: the workspace's own PM (mc-pm-<slug>-(dev)?). Catalog
  // sync sets is_pm=1, is_master=1, workspace_id=<workspace>.
  const wsPm = queryOne<Agent>(
    `SELECT * FROM agents
       WHERE workspace_id = ?
         AND is_pm = 1
         AND is_master = 1
         AND COALESCE(is_active, 1) = 1
       ORDER BY (CASE WHEN gateway_agent_id LIKE 'mc-pm-%' THEN 0 ELSE 1 END),
                created_at ASC
       LIMIT 1`,
    [workspaceId],
  );
  if (wsPm) return wsPm;

  // Backwards-compat: pre-Phase-I singleton runner (Phase H).
  const runner = queryOne<Agent>(
    `SELECT * FROM agents
       WHERE gateway_agent_id IN ('mc-runner', 'mc-runner-dev')
         AND is_pm = 1
         AND is_master = 1
         AND COALESCE(is_active, 1) = 1
       LIMIT 1`,
  );
  if (runner) return runner;

  // Backwards-compat: pre-061 per-workspace placeholders without
  // is_master, just is_pm or LOWER(role)='pm'.
  const flagged = queryOne<Agent>(
    `SELECT * FROM agents
       WHERE workspace_id = ? AND is_pm = 1
       LIMIT 1`,
    [workspaceId],
  );
  if (flagged) return flagged;
  return queryOne<Agent>(
    `SELECT * FROM agents
       WHERE workspace_id = ? AND LOWER(role) = 'pm'
       LIMIT 1`,
    [workspaceId],
  ) ?? null;
}
