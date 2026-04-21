/**
 * Task status-transition service.
 *
 * Narrow extraction of the core transition block from the PATCH handler in
 * src/app/api/tasks/[id]/route.ts — authz + evidence-gate + status-reason
 * requirement + terminal-state guard + the actual `UPDATE tasks SET status`.
 *
 * Deliberately NOT in scope (kept inline in the HTTP PATCH route, per the
 * PR 2 plan):
 *   - convoy progress + ready-subtask dispatch
 *   - workflow-engine handoff / auto-dispatch
 *   - skill extraction
 *   - agent-status reset
 *   - learner notification
 *   - broadcast
 *
 * These are all post-transition orchestration. The PATCH route runs them
 * after calling this service. The MCP `update_task_status` tool (PR 3)
 * will call this service too; post-transition orchestration for MCP
 * callers is deferred to a follow-up (for v1, MCP-driven status moves
 * apply the transition but don't auto-dispatch downstream — MCP callers
 * can invoke further transitions explicitly).
 *
 * Throws `AuthzError` on authorization failure. Returns a `{ ok: false }`
 * result for policy rejections (evidence gate, taskCanBeDone, etc.) so
 * the caller maps to the right HTTP status without guessing.
 */

import { queryOne, run } from '@/lib/db';
import {
  checkStageEvidence,
  taskCanBeDone,
  isTerminalStatus,
  auditBoardOverride,
} from '@/lib/task-governance';
import { assertAgentCanActOnTask } from '@/lib/authz/agent-task';
import type { Task, TaskStatus } from '@/lib/types';

export interface TransitionTaskStatusInput {
  taskId: string;
  /** `null` for operator-initiated transitions (UI). */
  actingAgentId: string | null;
  newStatus: TaskStatus;
  /** Required when failing backward from a quality stage. */
  statusReason?: string;
  /** When true, skip the evidence gate and taskCanBeDone. Operator-only. */
  boardOverride?: boolean;
  /** Free-form reason persisted by auditBoardOverride. */
  boardOverrideReason?: string;
}

export type TransitionTaskStatusResult =
  | {
      ok: true;
      task: Task;
      previousStatus: string;
    }
  | {
      ok: false;
      code:
        | 'not_found'
        | 'terminal_blocked'
        | 'evidence_gate'
        | 'status_reason_required'
        | 'cannot_mark_done';
      error: string;
      missingDeliverableIds?: string[];
    };

const QUALITY_STAGES = new Set(['testing', 'review', 'verification', 'done']);
const FAIL_SOURCE_STAGES = new Set(['testing', 'review', 'verification']);
const FAIL_TARGET_STAGES = new Set(['in_progress', 'assigned']);

export function transitionTaskStatus(
  input: TransitionTaskStatusInput,
): TransitionTaskStatusResult {
  const {
    taskId,
    actingAgentId,
    newStatus,
    statusReason,
    boardOverride,
    boardOverrideReason,
  } = input;

  const existing = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!existing) {
    return { ok: false, code: 'not_found', error: 'Task not found' };
  }

  if (actingAgentId) {
    assertAgentCanActOnTask(actingAgentId, taskId, 'status');
  }

  // No-op transitions are silently allowed (no guards apply; caller just
  // gets back the unchanged task). Matches pre-refactor PATCH behavior
  // which didn't run the transition block when nextStatus === existing.status.
  if (newStatus === existing.status) {
    return { ok: true, task: existing, previousStatus: existing.status };
  }

  // Cancelled is terminal unless explicitly overridden.
  if (
    isTerminalStatus(existing.status) &&
    existing.status === 'cancelled' &&
    !boardOverride
  ) {
    return {
      ok: false,
      code: 'terminal_blocked',
      error: `Cannot transition cancelled task to ${newStatus}. Create a new task or use board_override.`,
    };
  }

  // Evidence gate for forward moves into quality stages.
  if (QUALITY_STAGES.has(newStatus) && !boardOverride) {
    const evidence = checkStageEvidence(taskId);
    if (!evidence.ok) {
      return {
        ok: false,
        code: 'evidence_gate',
        error: evidence.reason || 'Evidence gate failed',
        missingDeliverableIds: evidence.missingDeliverableIds,
      };
    }
  }

  // Backward-failing transitions must carry a reason.
  const failingBackwards =
    FAIL_SOURCE_STAGES.has(existing.status) && FAIL_TARGET_STAGES.has(newStatus);
  if (failingBackwards && !statusReason) {
    return {
      ok: false,
      code: 'status_reason_required',
      error: 'status_reason is required when failing a stage',
    };
  }

  if (newStatus === 'done' && !boardOverride && !taskCanBeDone(taskId)) {
    return {
      ok: false,
      code: 'cannot_mark_done',
      error: 'Cannot mark done: validation/evidence requirements not met',
    };
  }

  const now = new Date().toISOString();
  const updates: string[] = ['status = ?', 'updated_at = ?'];
  const values: unknown[] = [newStatus, now];
  if (statusReason !== undefined) {
    updates.push('status_reason = ?');
    values.push(statusReason);
  }
  values.push(taskId);
  run(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`, values);

  if (boardOverride) {
    auditBoardOverride(taskId, existing.status, newStatus, boardOverrideReason);
  }

  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  return {
    ok: true,
    task: task ?? existing,
    previousStatus: existing.status,
  };
}
