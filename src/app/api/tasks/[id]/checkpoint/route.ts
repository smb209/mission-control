import { NextRequest, NextResponse } from 'next/server';
import { saveCheckpoint, getLatestCheckpoint } from '@/lib/checkpoint';
import { deliverPendingNotesAtCheckpoint } from '@/lib/task-notes';
import { CheckpointSchema } from '@/lib/validation';
import { authorizeAgentForTask } from '@/lib/authz/http';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Save a work-state checkpoint for a long-running task.
 *
 * Agents call this periodically (or before risky operations) so the task can
 * be audited, resumed after a crash, or used as a reference for operator
 * notes delivered at checkpoint boundaries.
 *
 * @openapi
 * @tag Agent Callbacks
 * @auth bearer
 * @pathParams TaskIdParam
 * @body CheckpointSchema
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await request.json();
    const validation = CheckpointSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.issues },
        { status: 400 }
      );
    }
    const { agent_id, checkpoint_type, state_summary, files_snapshot, context_data } = validation.data;

    // Agent-task authorization: agent_id is required on CheckpointSchema, so
    // this always runs (no operator-skip path).
    const authzFail = authorizeAgentForTask(agent_id, id, 'checkpoint');
    if (authzFail) return authzFail;

    const checkpoint = saveCheckpoint({
      taskId: id,
      agentId: agent_id,
      checkpointType: checkpoint_type,
      stateSummary: state_summary,
      filesSnapshot: files_snapshot,
      contextData: context_data,
    });

    // Deliver any pending operator notes at this checkpoint
    deliverPendingNotesAtCheckpoint(id).catch(err => {
      console.warn('[Checkpoint] Failed to deliver pending notes:', err);
    });

    return NextResponse.json(checkpoint, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to save checkpoint' }, { status: 500 });
  }
}

// GET /api/tasks/[id]/checkpoint — Get latest checkpoint
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const checkpoint = getLatestCheckpoint(id);

    if (!checkpoint) {
      return NextResponse.json({ error: 'No checkpoints found' }, { status: 404 });
    }

    return NextResponse.json(checkpoint);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch checkpoint' }, { status: 500 });
  }
}
