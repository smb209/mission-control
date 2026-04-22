/**
 * Task stage-failure service.
 *
 * Wraps the fail-loopback flow (handleStageFailure + drainQueue) with
 * agent-task authorization and the "task must be in testing/review/
 * verification" precondition. HTTP route and (PR 3) MCP tool both call
 * this.
 *
 * Throws `AuthzError` on authz failure. Returns `{ ok: true, ... }` on
 * success and `{ ok: false, ... }` on known failures (no workflow
 * template, already-terminal task, etc.) so the caller can map to
 * appropriate status codes without guessing between 400 and 500.
 */

import { queryOne } from '@/lib/db';
import { handleStageFailure, drainQueue } from '@/lib/workflow-engine';
import { notifyLearner } from '@/lib/learner';
import { assertAgentCanActOnTask } from '@/lib/authz/agent-task';
import type { Task } from '@/lib/types';

export interface FailTaskInput {
  taskId: string;
  /** `null` for operator-initiated failure. */
  actingAgentId: string | null;
  reason: string;
}

export type FailTaskResult =
  | {
      ok: true;
      fromStatus: string;
      newAgentName: string | null;
      message: string;
    }
  | {
      ok: false;
      /** 'bad_state' = task not in a failable stage; 'engine' = workflow engine refused. */
      code: 'not_found' | 'bad_state' | 'engine';
      error: string;
      hint?: string;
      fromStatus?: string;
    };

const FAILABLE_STATUSES = new Set(['testing', 'review', 'verification']);

export async function failTask(input: FailTaskInput): Promise<FailTaskResult> {
  const { taskId, actingAgentId, reason } = input;

  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) {
    return { ok: false, code: 'not_found', error: 'Task not found' };
  }

  if (actingAgentId) {
    assertAgentCanActOnTask(actingAgentId, taskId, 'fail');
  }

  if (!FAILABLE_STATUSES.has(task.status)) {
    return {
      ok: false,
      code: 'bad_state',
      error: `Cannot fail from status: ${task.status}. Must be in ${[...FAILABLE_STATUSES].join(', ')}`,
      fromStatus: task.status,
    };
  }

  // Fire-and-forget learner notification — never block the fail path on it.
  notifyLearner(taskId, {
    previousStatus: task.status,
    newStatus: 'in_progress',
    passed: false,
    failReason: reason,
  }).catch((err) => console.error('[Learner] notification failed:', err));

  let engineResult: Awaited<ReturnType<typeof handleStageFailure>>;
  try {
    engineResult = await handleStageFailure(taskId, task.status, reason);
  } catch (err) {
    return {
      ok: false,
      code: 'engine',
      error: `Stage failure could not be processed: ${(err as Error).message || 'handleStageFailure threw'}`,
      hint: `If the task is stuck, use POST /api/tasks/${taskId}/admin/release-stall.`,
      fromStatus: task.status,
    };
  }

  if (!engineResult.success) {
    const hasRecoveryPath =
      engineResult.error?.includes('No workflow template') ||
      engineResult.error?.includes('No fail target');
    return {
      ok: false,
      code: 'engine',
      error: engineResult.error || 'Failed to process stage failure',
      hint: hasRecoveryPath
        ? `Task has no recovery path. Use POST /api/tasks/${taskId}/admin/release-stall to cancel it.`
        : undefined,
      fromStatus: task.status,
    };
  }

  // Success — freed a slot; drain the queue without blocking the caller.
  drainQueue(taskId, task.workspace_id).catch((err) =>
    console.error('[Workflow] drainQueue after fail failed:', err),
  );

  return {
    ok: true,
    fromStatus: task.status,
    newAgentName: engineResult.newAgentName ?? null,
    message: `Task returned to ${engineResult.newAgentName ?? 'previous stage'} for rework`,
  };
}
