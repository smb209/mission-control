/**
 * Runner agent resolution.
 *
 * The mc-runner gateway agent is the org-wide host for scope-keyed
 * sessions (Phase C+ workers, Phase E recurring jobs, eventually
 * Phase F PM). It lives as a single row per environment in the
 * `default` workspace and is referenced from any workspace by its
 * UUID via dispatchScope.
 *
 * See specs/scope-keyed-sessions.md §1, §6 Phase C.
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
 */
export function isScopeKeyedDispatchEnabled(): boolean {
  return process.env.MC_USE_SCOPE_KEYED_DISPATCH === '1';
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
