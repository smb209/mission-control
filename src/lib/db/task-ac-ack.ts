/**
 * PM convoy mandate — operator acknowledgement of parent convoy acceptance
 * criteria (slice 5 of 7).
 *
 * Each `create_convoy_under_initiative` proposal carries a feature-level
 * `parent_acceptance_criteria` array. When the convoy's subtasks all reach
 * `done` and `checkConvoyCompletion` flips the parent task to `review`,
 * the operator-driven `review → done` click runs through an AC gate —
 * each AC must be explicitly acknowledged (with an optional free-text
 * rationale) before the transition is allowed.
 *
 * This module owns the per-AC ack rows in `task_ac_acknowledgements`
 * (migration 096) and the projection consumed by the UI / gate.
 *
 * NULL `acceptance_criteria` on the convoy row = coordinator-spawned
 * (back-compat) convoy with no ACs — `getParentConvoyAcs` returns null
 * and the gate is a no-op. Same for tasks with no convoy at all.
 *
 * See docs/proposals/pm-convoy-mandate.md "Gate at parent review → done".
 */

import { queryOne, queryAll, run } from '@/lib/db';

export interface AcStatus {
  ac_index: number;
  ac_text: string;
  acknowledged: boolean;
  rationale?: string;
  acknowledged_by?: string;
  acknowledged_at?: string;
}

/**
 * Returns the per-AC status for a task's done-state parent convoy, or
 * `null` if the task has no convoy with ACs (coordinator-spawned convoy
 * or no convoy at all).
 */
export function getParentConvoyAcs(taskId: string): AcStatus[] | null {
  const convoy = queryOne<{ acceptance_criteria: string | null }>(
    `SELECT acceptance_criteria FROM convoys WHERE parent_task_id = ? AND status = 'done'`,
    [taskId],
  );
  if (!convoy?.acceptance_criteria) return null;
  let acs: unknown;
  try {
    acs = JSON.parse(convoy.acceptance_criteria);
  } catch {
    return null;
  }
  if (!Array.isArray(acs) || acs.length === 0) return null;

  const acks = queryAll<{
    ac_index: number;
    rationale: string | null;
    acknowledged_by: string | null;
    acknowledged_at: string;
  }>(
    `SELECT ac_index, rationale, acknowledged_by, acknowledged_at
       FROM task_ac_acknowledgements
      WHERE task_id = ?`,
    [taskId],
  );
  const ackByIndex = new Map(acks.map(a => [a.ac_index, a]));

  return acs.map((text, i) => {
    const ack = ackByIndex.get(i);
    return {
      ac_index: i,
      ac_text: typeof text === 'string' ? text : String(text),
      acknowledged: Boolean(ack),
      rationale: ack?.rationale ?? undefined,
      acknowledged_by: ack?.acknowledged_by ?? undefined,
      acknowledged_at: ack?.acknowledged_at,
    };
  });
}

/**
 * Records (or replaces) an acknowledgement for a single AC index.
 * `INSERT ... ON CONFLICT` upserts so the operator can revise the rationale
 * without first calling `unacknowledgeAc`.
 *
 * Snapshots the AC text at ack time — later edits to the convoy row
 * don't silently rewrite the audit trail.
 */
export function acknowledgeAc(
  taskId: string,
  acIndex: number,
  opts: { rationale?: string; acknowledgedBy?: string } = {},
): void {
  const convoy = queryOne<{ acceptance_criteria: string | null }>(
    `SELECT acceptance_criteria FROM convoys WHERE parent_task_id = ? AND status = 'done'`,
    [taskId],
  );
  if (!convoy?.acceptance_criteria) {
    throw new Error(`No done-state convoy with acceptance criteria for task ${taskId}`);
  }
  let acs: unknown;
  try {
    acs = JSON.parse(convoy.acceptance_criteria);
  } catch {
    throw new Error(`Convoy acceptance_criteria for task ${taskId} is not valid JSON`);
  }
  if (!Array.isArray(acs) || acIndex < 0 || acIndex >= acs.length) {
    throw new Error(`AC index ${acIndex} out of range for task ${taskId}`);
  }
  const acText = typeof acs[acIndex] === 'string' ? (acs[acIndex] as string) : String(acs[acIndex]);
  const rationale = opts.rationale ?? null;
  const ackedBy = opts.acknowledgedBy ?? 'operator';

  run(
    `INSERT INTO task_ac_acknowledgements (task_id, ac_index, ac_text, rationale, acknowledged_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(task_id, ac_index) DO UPDATE SET
       ac_text = excluded.ac_text,
       rationale = excluded.rationale,
       acknowledged_by = excluded.acknowledged_by,
       acknowledged_at = CURRENT_TIMESTAMP`,
    [taskId, acIndex, acText, rationale, ackedBy],
  );
}

/** Operator changed their mind — removes a single ack row. Idempotent. */
export function unacknowledgeAc(taskId: string, acIndex: number): void {
  run(
    `DELETE FROM task_ac_acknowledgements WHERE task_id = ? AND ac_index = ?`,
    [taskId, acIndex],
  );
}

/**
 * Returns the AC indices that lack an ack row, or null if the task has no
 * AC-carrying convoy (gate is a no-op). Used by the review → done gate
 * to compute its rejection payload without round-tripping through
 * `getParentConvoyAcs`'s richer projection.
 */
export function missingAcAcknowledgements(taskId: string): {
  missing_indices: number[];
  acceptance_criteria: string[];
} | null {
  const convoy = queryOne<{ acceptance_criteria: string | null }>(
    `SELECT acceptance_criteria FROM convoys WHERE parent_task_id = ? AND status = 'done'`,
    [taskId],
  );
  if (!convoy?.acceptance_criteria) return null;
  let acs: unknown;
  try {
    acs = JSON.parse(convoy.acceptance_criteria);
  } catch {
    return null;
  }
  if (!Array.isArray(acs) || acs.length === 0) return null;
  const acStrings = acs.map(v => (typeof v === 'string' ? v : String(v)));

  const acks = queryAll<{ ac_index: number }>(
    `SELECT ac_index FROM task_ac_acknowledgements WHERE task_id = ?`,
    [taskId],
  );
  const acked = new Set(acks.map(a => a.ac_index));
  const missing = acStrings.map((_, i) => i).filter(i => !acked.has(i));
  return { missing_indices: missing, acceptance_criteria: acStrings };
}
