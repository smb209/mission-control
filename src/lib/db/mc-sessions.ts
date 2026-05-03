/**
 * mc_sessions bookkeeping.
 *
 * Openclaw owns the trajectory file; MC owns the metadata so we can
 * list "active sessions for task X" or reap stale scopes. See
 * specs/scope-keyed-sessions.md §1.3.
 *
 * Phase A added the table; Phase B starts populating it via
 * `dispatchScope`. Phase E uses it for cleanup on task completion.
 */

import { queryOne, run } from '@/lib/db';

export type ScopeType =
  | 'pm_chat'
  | 'plan'
  | 'decompose'
  | 'decompose_story'
  | 'notes_intake'
  | 'task_coord'
  | 'task_role'
  | 'recurring'
  | 'heartbeat';

export type SessionStatus = 'active' | 'idle' | 'closed' | 'failed';

export interface McSession {
  scope_key: string;
  workspace_id: string;
  role: string;
  scope_type: ScopeType;
  task_id: string | null;
  initiative_id: string | null;
  recurring_job_id: string | null;
  attempt: number;
  status: SessionStatus;
  last_used_at: string;
  created_at: string;
  closed_at: string | null;
}

export interface UpsertSessionInput {
  scope_key: string;
  workspace_id: string;
  role: string;
  scope_type: ScopeType;
  task_id?: string | null;
  initiative_id?: string | null;
  recurring_job_id?: string | null;
  attempt?: number;
}

/**
 * Insert or touch the row for `scope_key`. On insert, sets all the
 * scope metadata. On touch, bumps `last_used_at` and flips
 * `status='active'` (recovers a previously closed/failed scope).
 *
 * Returns whether this was the first time we've seen this scope key —
 * `is_new = true` means the trajectory file is empty; `false` means
 * the agent's session has prior context to replay (resume case).
 */
export function upsertSession(input: UpsertSessionInput): { session: McSession; is_new: boolean } {
  const existing = queryOne<McSession>(
    `SELECT * FROM mc_sessions WHERE scope_key = ?`,
    [input.scope_key],
  );

  if (existing) {
    run(
      `UPDATE mc_sessions
          SET status = 'active',
              last_used_at = datetime('now'),
              closed_at = NULL
        WHERE scope_key = ?`,
      [input.scope_key],
    );
    const refreshed = queryOne<McSession>(
      `SELECT * FROM mc_sessions WHERE scope_key = ?`,
      [input.scope_key],
    );
    return { session: refreshed ?? existing, is_new: false };
  }

  run(
    `INSERT INTO mc_sessions (
       scope_key, workspace_id, role, scope_type,
       task_id, initiative_id, recurring_job_id,
       attempt, status, last_used_at, created_at, closed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active',
              datetime('now'), datetime('now'), NULL)`,
    [
      input.scope_key,
      input.workspace_id,
      input.role,
      input.scope_type,
      input.task_id ?? null,
      input.initiative_id ?? null,
      input.recurring_job_id ?? null,
      input.attempt ?? 1,
    ],
  );

  const inserted = queryOne<McSession>(
    `SELECT * FROM mc_sessions WHERE scope_key = ?`,
    [input.scope_key],
  );
  if (!inserted) throw new Error('upsertSession: insert succeeded but row missing');
  return { session: inserted, is_new: true };
}

export function getSession(scopeKey: string): McSession | null {
  return queryOne<McSession>(`SELECT * FROM mc_sessions WHERE scope_key = ?`, [scopeKey]) ?? null;
}

export function setSessionStatus(scopeKey: string, status: SessionStatus): McSession | null {
  if (status === 'closed' || status === 'failed') {
    run(
      `UPDATE mc_sessions
          SET status = ?,
              closed_at = datetime('now')
        WHERE scope_key = ?`,
      [status, scopeKey],
    );
  } else {
    run(
      `UPDATE mc_sessions
          SET status = ?,
              closed_at = NULL,
              last_used_at = datetime('now')
        WHERE scope_key = ?`,
      [status, scopeKey],
    );
  }
  return getSession(scopeKey);
}

/**
 * Touch a session's `last_used_at` without changing status. Use after
 * a successful dispatch turn so reap heuristics can tell active vs
 * idle scopes apart.
 */
export function touchSession(scopeKey: string): void {
  run(
    `UPDATE mc_sessions SET last_used_at = datetime('now') WHERE scope_key = ?`,
    [scopeKey],
  );
}
