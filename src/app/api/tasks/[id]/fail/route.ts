import { NextRequest, NextResponse } from 'next/server';
import { logDebugEvent } from '@/lib/debug-log';
import { FailTaskSchema } from '@/lib/validation';
import { AuthzError } from '@/lib/authz/agent-task';
import { authzErrorResponse } from '@/lib/authz/http';
import { failTask } from '@/lib/services/task-failure';

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

    let result;
    try {
      result = await failTask({
        taskId,
        actingAgentId: agent_id ?? null,
        reason,
      });
    } catch (err) {
      if (err instanceof AuthzError) return authzErrorResponse(err);
      throw err;
    }

    logDebugEvent({
      type: 'agent.fail_post',
      direction: 'inbound',
      taskId,
      requestBody: body,
      metadata: { from_status: result.ok ? result.fromStatus : (result.fromStatus ?? null) },
    });

    if (result.ok) {
      return NextResponse.json({
        success: true,
        message: result.message,
        newAgent: result.newAgentName,
      });
    }

    // Known failures: 404 for missing task, 400 for everything else. Engine
    // errors are rejected transitions, not server crashes — 400 is correct
    // (see the original bug noted in the pre-refactor comment: operators
    // got opaque 500s and assumed the server was broken when the real issue
    // was a missing workflow template).
    const status = result.code === 'not_found' ? 404 : 400;
    return NextResponse.json(
      {
        success: false,
        error: result.error,
        ...(result.hint ? { hint: result.hint } : {}),
      },
      { status }
    );
  } catch (error) {
    console.error('Failed to process stage failure:', error);
    return NextResponse.json(
      { error: `Failed to process stage failure: ${(error as Error).message}` },
      { status: 500 }
    );
  }
}
