/**
 * Defer-and-replay queue for `propose_from_notes` requests.
 *
 * When the openclaw gateway is unreachable, the MCP tool enqueues a
 * pending row here instead of failing. A drain worker
 * (`pm-pending-drain.ts`) picks rows up on gateway reconnect / periodic
 * tick and dispatches them through `dispatchPm`.
 *
 * Mirrors the `task_notes` pending pattern (migration 017).
 */

import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';

export type PmPendingNoteStatus = 'pending' | 'dispatched' | 'failed';

export interface PmPendingNote {
  id: string;
  workspace_id: string;
  agent_id: string;
  notes_text: string;
  scope_hint: Record<string, unknown> | null;
  status: PmPendingNoteStatus;
  proposal_id: string | null;
  error: string | null;
  attempts: number;
  created_at: string;
  dispatched_at: string | null;
}

interface PmPendingNoteRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  notes_text: string;
  scope_hint: string | null;
  status: PmPendingNoteStatus;
  proposal_id: string | null;
  error: string | null;
  attempts: number;
  created_at: string;
  dispatched_at: string | null;
}

function rowToNote(row: PmPendingNoteRow): PmPendingNote {
  let scope: Record<string, unknown> | null = null;
  if (row.scope_hint) {
    try { scope = JSON.parse(row.scope_hint) as Record<string, unknown>; } catch { scope = null; }
  }
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    agent_id: row.agent_id,
    notes_text: row.notes_text,
    scope_hint: scope,
    status: row.status,
    proposal_id: row.proposal_id,
    error: row.error,
    attempts: row.attempts,
    created_at: row.created_at,
    dispatched_at: row.dispatched_at,
  };
}

export interface EnqueuePendingNoteInput {
  workspace_id: string;
  agent_id: string;
  notes_text: string;
  scope_hint?: Record<string, unknown> | null;
}

export function enqueuePendingNote(input: EnqueuePendingNoteInput): PmPendingNote {
  const id = uuidv4();
  const now = new Date().toISOString();
  run(
    `INSERT INTO pm_pending_notes (id, workspace_id, agent_id, notes_text, scope_hint, status, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
    [
      id,
      input.workspace_id,
      input.agent_id,
      input.notes_text,
      input.scope_hint ? JSON.stringify(input.scope_hint) : null,
      now,
    ],
  );
  return getPendingNote(id)!;
}

export function getPendingNote(id: string): PmPendingNote | undefined {
  const row = queryOne<PmPendingNoteRow>(`SELECT * FROM pm_pending_notes WHERE id = ?`, [id]);
  return row ? rowToNote(row) : undefined;
}

/**
 * Pending rows ordered by created_at. Filters out rows that have
 * exceeded `maxAttempts` so the drain worker doesn't retry them
 * forever — they remain in the table for operator review.
 */
export function listPendingNotes(opts: { maxAttempts?: number } = {}): PmPendingNote[] {
  const maxAttempts = opts.maxAttempts ?? 5;
  return queryAll<PmPendingNoteRow>(
    `SELECT * FROM pm_pending_notes
      WHERE status = 'pending' AND attempts < ?
      ORDER BY created_at ASC, id ASC`,
    [maxAttempts],
  ).map(rowToNote);
}

export function markDispatched(id: string, proposal_id: string): void {
  const now = new Date().toISOString();
  run(
    `UPDATE pm_pending_notes
        SET status = 'dispatched', proposal_id = ?, dispatched_at = ?, error = NULL
      WHERE id = ?`,
    [proposal_id, now, id],
  );
}

export function markFailed(id: string, errorMsg: string): void {
  // Increment attempts and stash the latest error. Status stays
  // 'pending' until attempts >= cap (then list filter excludes it).
  run(
    `UPDATE pm_pending_notes
        SET attempts = attempts + 1, error = ?
      WHERE id = ?`,
    [errorMsg.slice(0, 500), id],
  );
}

export function incrementAttempt(id: string): void {
  run(`UPDATE pm_pending_notes SET attempts = attempts + 1 WHERE id = ?`, [id]);
}
