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
  whyCannotBeDone,
  isTerminalStatus,
  auditBoardOverride,
  pickReviewerForTask,
} from '@/lib/task-governance';
import { assertAgentCanActOnTask } from '@/lib/authz/agent-task';
import { missingAcAcknowledgements } from '@/lib/db/task-ac-ack';
import type { Task, TaskStatus } from '@/lib/types';

/** Slice 1 strict gating is opt-in for one cycle while operators backfill. */
function isStrictReviewGatingEnabled(): boolean {
  return process.env.MC_REVIEW_STRICT_GATING === '1';
}

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
        | 'cannot_mark_done'
        | 'self_review_blocked'
        | 'reviewer_required'
        | 'parent_ac_check_pending';
      error: string;
      missingDeliverableIds?: string[];
      missingAcIndices?: number[];
      acceptanceCriteria?: string[];
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

  // Review-stage gates (Slice 1 of review-stage-robustness).
  // Run before the evidence gate so the rejection reason is unambiguous.
  // Strict mode is opt-in via MC_REVIEW_STRICT_GATING=1 to allow a backfill
  // cycle for in-flight workspaces without reviewer agents.
  if (
    newStatus === 'review' &&
    !boardOverride &&
    isStrictReviewGatingEnabled()
  ) {
    const workspaceId = (existing.workspace_id ?? 'default') as string;
    const completerId = actingAgentId ?? existing.assigned_agent_id ?? null;

    // Self-review interlock. Reviewer must differ from the agent who did
    // the work. Prefer an explicit task_roles reviewer row when present;
    // otherwise auto-pick now and persist the row.
    const explicitReviewer = queryOne<{ agent_id: string }>(
      `SELECT agent_id FROM task_roles WHERE task_id = ? AND role = 'reviewer' LIMIT 1`,
      [taskId],
    );
    let reviewerAgentId: string | null = explicitReviewer?.agent_id ?? null;

    if (!reviewerAgentId) {
      const picked = pickReviewerForTask({
        taskId,
        workspaceId,
        excludeAgentId: completerId,
      });
      reviewerAgentId = picked?.id ?? null;
    }

    if (!reviewerAgentId) {
      return {
        ok: false,
        code: 'reviewer_required',
        error:
          'Cannot enter review: no reviewer agent available in this workspace. Onboard or enable a reviewer-role agent (or use board_override).',
      };
    }

    if (completerId && reviewerAgentId === completerId) {
      return {
        ok: false,
        code: 'self_review_blocked',
        error:
          'Cannot enter review: the agent who did the work cannot also be the reviewer. Onboard or enable a separate reviewer agent.',
      };
    }

    // Idempotent reviewer assignment: only insert if no row exists.
    if (!explicitReviewer) {
      run(
        `INSERT OR IGNORE INTO task_roles (id, task_id, role, agent_id, created_at)
         VALUES (lower(hex(randomblob(16))), ?, 'reviewer', ?, datetime('now'))`,
        [taskId, reviewerAgentId],
      );
    }
  }

  // Evidence gate for forward moves into quality stages.
  if (QUALITY_STAGES.has(newStatus) && !boardOverride) {
    const evidence = checkStageEvidence(taskId, newStatus);
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

  // Forward (non-failing) transitions clear the structured `is_failed` flag
  // and any stale "Failed:" status_reason from a prior loop. The flag is
  // the single source of truth read by `taskCanBeDone` — keeping it in sync
  // with the actual stage progression replaces the brittle substring check
  // we used to do on status_reason.
  const isExistingRow = existing as Task & { is_failed?: number; status_reason?: string };
  const wasMarkedFailed = Number(isExistingRow.is_failed ?? 0) === 1;
  const shouldClearStaleFailure =
    !failingBackwards &&
    statusReason === undefined &&
    typeof isExistingRow.status_reason === 'string' &&
    /^failed:/i.test(isExistingRow.status_reason.trim());

  if (newStatus === 'done' && !boardOverride) {
    const reason = whyCannotBeDone(taskId, {
      // The same UPDATE that performs this transition will clear is_failed,
      // so don't block on it here.
      ignoreFailureFlag: !failingBackwards && wasMarkedFailed,
    });
    if (reason) {
      return {
        ok: false,
        code: 'cannot_mark_done',
        error: `Cannot mark done: ${reason}`,
      };
    }

    // PM convoy mandate (slice 5/7): parent task with a done convoy that
    // carries feature-level acceptance criteria must have every AC
    // explicitly acknowledged before review → done. `board_override`
    // bypasses (same pattern as the evidence gate). Tasks without a
    // convoy / convoys without ACs (coordinator-spawned back-compat) are
    // skipped via the null return from missingAcAcknowledgements.
    const acGate = missingAcAcknowledgements(taskId);
    if (acGate && acGate.missing_indices.length > 0) {
      return {
        ok: false,
        code: 'parent_ac_check_pending',
        error: `Parent task has ${acGate.missing_indices.length} unacknowledged convoy AC(s). Operator must acknowledge each before review → done.`,
        missingAcIndices: acGate.missing_indices,
        acceptanceCriteria: acGate.acceptance_criteria,
      };
    }
  }

  const now = new Date().toISOString();
  const updates: string[] = ['status = ?', 'updated_at = ?'];
  const values: unknown[] = [newStatus, now];
  if (statusReason !== undefined) {
    updates.push('status_reason = ?');
    values.push(statusReason);
  } else if (shouldClearStaleFailure) {
    updates.push('status_reason = NULL');
  }
  if (!failingBackwards && wasMarkedFailed) {
    updates.push('is_failed = 0');
  }
  values.push(taskId);
  run(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`, values);

  if (boardOverride) {
    auditBoardOverride(taskId, existing.status, newStatus, boardOverrideReason);
  }

  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);

  // Convoy + workflow side effects. These used to live only in the
  // /api/tasks/[id] PATCH route, so MCP-driven status changes
  // (`update_task_status`, `update_subtask`) bypassed them entirely. The
  // Builder marking a subtask done would update the row but never bump
  // the parent convoy's completed_subtasks, so checkConvoyCompletion
  // never ran and the parent stayed in convoy_active until the stall
  // scanner flagged it. Run them here so every status mutation gets
  // consistent treatment regardless of caller.
  runPostStatusChangeSideEffects({
    taskId,
    previousStatus: existing.status,
    newStatus,
    workspaceId: existing.workspace_id,
    convoyId: existing.convoy_id ?? null,
  });

  return {
    ok: true,
    task: task ?? existing,
    previousStatus: existing.status,
  };
}

/**
 * Convoy + drain hooks that must fire on every status change, regardless
 * of whether the source is an API PATCH or an MCP tool. Idempotent —
 * safe to call from multiple call sites if a future refactor stacks them.
 */
export function runPostStatusChangeSideEffects(input: {
  taskId: string;
  previousStatus: string;
  newStatus: string;
  workspaceId: string;
  convoyId: string | null;
}): void {
  const { taskId, previousStatus, newStatus, workspaceId, convoyId } = input;
  if (newStatus === previousStatus) return;

  // Lazy imports to avoid pulling convoy + workflow engine into modules
  // that only import the type signatures of task-status.
  if (convoyId) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const convoy = require('@/lib/convoy') as typeof import('@/lib/convoy');
      convoy.updateConvoyProgress(convoyId);
      if (newStatus === 'done') {
        const wasFinal = convoy.checkConvoyCompletion(convoyId);
        if (!wasFinal) {
          convoy.dispatchReadyConvoySubtasks(convoyId).catch((err: unknown) => {
            console.error('[Convoy] auto-dispatch on subtask done failed:', err);
          });
        }
      }
    } catch (err) {
      console.error('[Convoy] progress update failed:', err);
    }
  }

  if (newStatus === 'done') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const wf = require('@/lib/workflow-engine') as typeof import('@/lib/workflow-engine');
      wf.drainQueue(taskId, workspaceId).catch((err: unknown) => {
        console.error('[Workflow] drainQueue after done failed:', err);
      });
    } catch (err) {
      console.error('[Workflow] drainQueue failed:', err);
    }
  }
}
