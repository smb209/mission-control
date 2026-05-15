/**
 * Runner agent resolution.
 *
 * The mc-runner gateway agent is the org-wide host for scope-keyed
 * sessions (Phase C+ workers, Phase E recurring jobs, eventually
 * Phase F PM). It lives as a single row per environment in the
 * `default` workspace and is referenced from any workspace by its
 * UUID via dispatchScope.
 *
 * See docs/reference/scope-keyed-sessions.md §1, §6 Phase C.
 */

import { queryAll, queryOne } from '@/lib/db';
import type { Agent } from '@/lib/types';

/**
 * Look up the runner agent for the current environment. We pick the
 * `-dev` variant when MC_RUNNER_GATEWAY_ID is unset and the dev
 * variant exists, else the explicit override, else the prod-style
 * `mc-runner`.
 *
 * Returns null when no runner is registered yet (pre-Phase-C dev
 * environments without `mc-runner-dev` in the gateway). Callers must
 * tolerate that and fall back to the legacy dispatch path.
 */
export function getRunnerAgent(): Agent | null {
  const explicit = process.env.MC_RUNNER_GATEWAY_ID;
  if (explicit) {
    const row = queryOne<Agent>(
      `SELECT * FROM agents WHERE gateway_agent_id = ? LIMIT 1`,
      [explicit],
    );
    if (row) return row;
  }

  // Prefer the -dev variant in development. Identify "dev" by NODE_ENV
  // or MC_ENV; production runs without these and picks `mc-runner`.
  const isDev = process.env.NODE_ENV === 'development' || process.env.MC_ENV === 'dev';
  const candidates = isDev ? ['mc-runner-dev', 'mc-runner'] : ['mc-runner', 'mc-runner-dev'];

  for (const id of candidates) {
    const row = queryOne<Agent>(
      `SELECT * FROM agents WHERE gateway_agent_id = ? LIMIT 1`,
      [id],
    );
    if (row) return row;
  }
  return null;
}

/**
 * Cheap check used by request handlers and middleware.
 *
 * Phase F default: ON. Set MC_USE_SCOPE_KEYED_DISPATCH=0 to opt back
 * into the legacy per-role dispatch path (preserved as a fallback in
 * dispatch/route.ts). This lever exists so an emergency rollback
 * doesn't require a code revert; expect to remove it once we've run
 * Phase F in production for a release cycle.
 */
export function isScopeKeyedDispatchEnabled(): boolean {
  const v = process.env.MC_USE_SCOPE_KEYED_DISPATCH;
  if (v === '0' || v === 'false') return false;
  return true;
}

/**
 * Phase J2: feature flag for the openclaw `sessions_spawn`-based
 * worker dispatch path. Default OFF. Set MC_USE_SUBAGENT_SPAWN=1 to
 * route worker dispatches via the workspace PM's per-task coord
 * session (which then calls openclaw's sessions_spawn) instead of the
 * Phase C scope-keyed sibling-session path.
 *
 * Flips to default-on in Phase K once we've validated against
 * spark-lb/agent.
 */
export function isSubagentSpawnEnabled(): boolean {
  return process.env.MC_USE_SUBAGENT_SPAWN === '1' ||
    process.env.MC_USE_SUBAGENT_SPAWN === 'true';
}

/**
 * Compute the scope_suffix for a worker dispatch.
 *
 * Format: `ws-<wsid>:task-<task_id>:<role>:<attempt>`
 *
 * Each colon-separated segment must match openclaw's
 * `[a-z0-9][a-z0-9_-]{0,63}` per session-key.ts. UUIDs (36 chars) fit
 * comfortably. We return the combined string; the caller appends it
 * to the runner's `session_key_prefix` via dispatchScope.
 */
export function computeWorkerScopeSuffix(input: {
  workspace_id: string;
  task_id: string;
  role: string;
  attempt: number;
}): string {
  return `ws-${input.workspace_id}:task-${input.task_id}:${input.role}:${input.attempt}`;
}

/**
 * Compute the next attempt number for a (task, role) pair.
 *
 * Counts active+closed sessions for the task at this role; the next
 * attempt is `count + 1`. Used by the `fresh` attempt strategy where
 * each retry mints a new scope_key segment so the session starts
 * with a clean trajectory.
 *
 * For `reuse` strategy (researcher / learner), callers always pass
 * attempt=1 instead.
 */
export function nextWorkerAttempt(taskId: string, role: string): number {
  const rows = queryAll<{ n: number }>(
    `SELECT COUNT(*) AS n FROM mc_sessions
      WHERE task_id = ? AND role = ?`,
    [taskId, role],
  );
  return (rows[0]?.n ?? 0) + 1;
}

/**
 * Resolve the MCP server namespace prefix that appears in front of every
 * mission-control tool name in the dispatched agent's catalog.
 *
 * Background: the agent's tool catalog enumerates tools as
 * `<server>__<tool>` (e.g. `sc-mission-control-dev__register_deliverable`)
 * because openclaw mounts each MCP server under its declared name from
 * `~/.openclaw/openclaw.json` and namespaces all of its tools. If the
 * dispatch briefing emits the bare tool name (`register_deliverable(...)`),
 * the LLM looks for an exact match in the catalog, doesn't find one, and
 * either falls back to built-in shell tools or silently no-ops. Observed
 * symptom: 30 tool calls of `exec`/`read`/`write`/`edit` and zero MC tools,
 * task stuck `in_progress` because `register_deliverable` was never
 * called → autobouncer marks the session `failed` after the no-progress
 * timeout.
 *
 * The mapping mirrors the per-agent `tools.alsoAllow` rules in
 * `~/.openclaw/openclaw.json`:
 *   - `mc-runner-dev`         → `sc-mission-control-dev`
 *   - `mc-runner`             → `sc-mission-control`
 *   - `mc-pm-*-dev`           → `sc-mission-control-pm-dev`
 *   - `mc-pm-*`               → `sc-mission-control-pm`
 *   - anything else           → defaults to the dev namespace, since
 *                               unknown gateways in dev environments are
 *                               expected to mount the dev MCP server.
 *
 * Pass the agent that will actually execute the dispatch — for
 * scope-keyed dispatch that's the runner (`getRunnerAgent()`); legacy
 * direct dispatch passes the assigned agent.
 */
export function mcpToolPrefix(agent: { gateway_agent_id?: string | null } | null | undefined): string {
  const gw = agent?.gateway_agent_id ?? '';
  if (gw === 'mc-runner-dev') return 'sc-mission-control-dev';
  if (gw === 'mc-runner') return 'sc-mission-control';
  if (gw.startsWith('mc-pm-') && gw.endsWith('-dev')) return 'sc-mission-control-pm-dev';
  if (gw.startsWith('mc-pm-')) return 'sc-mission-control-pm';
  // Sensible default for dev environments where the runner hasn't been
  // resolved yet (e.g. the assigned agent is a role-template row with
  // `gateway_agent_id = NULL`). Production would flip this to
  // `sc-mission-control` via NODE_ENV — see the runner-resolution logic
  // in `getRunnerAgent` for the same pattern.
  const isDev = process.env.NODE_ENV === 'development' || process.env.MC_ENV === 'dev';
  return isDev ? 'sc-mission-control-dev' : 'sc-mission-control';
}
