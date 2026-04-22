import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { handleStageFailure, drainQueue } from '@/lib/workflow-engine';
import { notifyLearner } from '@/lib/learner';
import { logDebugEvent } from '@/lib/debug-log';
import { FailTaskSchema } from '@/lib/validation';
import { authorizeAgentForTask } from '@/lib/authz/http';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Report a stage failure and trigger the fail-loopback.
 *
 * Agents in testing/review/verification call this when the prior stage's work
 * didn't pass. The workflow engine routes the task back to the appropriate
 * earlier stage (usually in_progress/builder) with the reason attached.
 *
 * @openapi
 * @tag Agent Callbacks
 * @auth bearer
 * @pathParams TaskIdParam
 * @body FailTaskSchema
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const body = await request.json();
    const validation = FailTaskSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.issues },
        { status: 400 }
      );
    }
    const { reason, agent_id } = validation.data;

    // Agent-task authorization: enforce when agent_id is provided.
    const authzFail = authorizeAgentForTask(agent_id, taskId, 'fail');
    if (authzFail) return authzFail;

    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    logDebugEvent({
      type: 'agent.fail_post',
      direction: 'inbound',
      taskId,
      requestBody: body,
      metadata: { from_status: task.status },
    });

    // Only allow failure from testing, review, or verification stages
    const failableStatuses = ['testing', 'review', 'verification'];
    if (!failableStatuses.includes(task.status)) {
      return NextResponse.json(
        { error: `Cannot fail from status: ${task.status}. Must be in ${failableStatuses.join(', ')}` },
        { status: 400 }
      );
    }

    // Notify learner about the failure
    notifyLearner(taskId, {
      previousStatus: task.status,
      newStatus: 'in_progress',
      passed: false,
      failReason: reason,
    }).catch(err => console.error('[Learner] notification failed:', err));

    // Trigger the fail-loopback via the workflow engine. Wrap in try/catch so
    // an internal throw (e.g. DB error, dispatch timeout) returns a clean 400
    // instead of the bare 500 "Internal server error" that masked the real
    // problem before. Operators hitting this endpoint for stalled tasks got
    // the opaque 500 and had no path forward — the admin release-stall
    // endpoint now covers the "can't recover" case.
    let result: Awaited<ReturnType<typeof handleStageFailure>>;
    try {
      result = await handleStageFailure(taskId, task.status, reason);
    } catch (err) {
      const message = (err as Error).message || 'handleStageFailure threw';
      console.error('[Fail] handleStageFailure threw:', err);
      return NextResponse.json(
        {
          success: false,
          error: `Stage failure could not be processed: ${message}. If the task is stuck, use POST /api/tasks/${taskId}/admin/release-stall.`,
        },
        { status: 400 }
      );
    }

    if (result.success) {
      // Fail-loopback freed a slot (testing/verification) — drain the queue
      drainQueue(taskId, task.workspace_id).catch(err =>
        console.error('[Workflow] drainQueue after fail failed:', err)
      );

      return NextResponse.json({
        success: true,
        message: `Task returned to ${result.newAgentName ? result.newAgentName : 'previous stage'} for rework`,
        newAgent: result.newAgentName,
      });
    }

    // result.success === false with a structured error — return 400, not 500.
    // A 500 implies the server is broken; the server is fine, the transition
    // is just rejected. This was the original bug: callers saw 500 and
    // assumed the server had crashed when the real issue was a missing
    // workflow template or fail_target.
    return NextResponse.json(
      {
        success: false,
        error: result.error || 'Failed to process stage failure',
        hint: result.error?.includes('No workflow template') || result.error?.includes('No fail target')
          ? `Task has no recovery path. Use POST /api/tasks/${taskId}/admin/release-stall to cancel it.`
          : undefined,
      },
      { status: 400 }
    );
  } catch (error) {
    console.error('Failed to process stage failure:', error);
    return NextResponse.json(
      { error: `Failed to process stage failure: ${(error as Error).message}` },
      { status: 500 }
    );
  }
}
