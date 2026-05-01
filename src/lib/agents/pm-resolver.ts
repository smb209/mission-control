/**
 * Single seam for "which agent is the PM for this workspace?".
 *
 * Pre-061 every call site grew its own `WHERE workspace_id = ? AND
 * role = 'pm'` query. That broke twice:
 *   - the role match was case-sensitive, so a row persisted with
 *     'PM' (which the API used to allow before normalization) was
 *     invisible to the resolver, and
 *   - prod→dev DB clones kept the prod gateway link on the PM row,
 *     so dispatch chat was silently routed to the prod gateway.
 *
 * The new contract: the operator promotes any agent via the
 * AgentModal "PM for this workspace" checkbox (which sets is_pm=1
 * and clears it on every other agent in the workspace). This
 * resolver prefers is_pm=1 and falls back to LOWER(role)='pm' for
 * rows that pre-date migration 061.
 */

import { queryOne } from '@/lib/db';
import type { Agent } from '@/lib/types';

export function getPmAgent(workspaceId: string): Agent | null {
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
