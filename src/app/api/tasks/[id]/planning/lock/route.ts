/**
 * POST /api/tasks/[id]/planning/lock
 *
 * Final confirmation step of the enhanced planning flow. Moves a task whose
 * planner has produced a spec (phase = 'confirm') into 'complete' status and
 * fires the dispatch endpoint. This is the one and only place where planning
 * commits — no other route auto-dispatches.
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { lockAndDispatch } from '@/lib/planning-persist';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const task = queryOne<{
      id: string;
      planning_phase?: string;
      planning_complete?: number;
      planning_spec?: string;
    }>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    if (task.planning_complete) {
      return NextResponse.json({ error: 'Planning already locked' }, { status: 400 });
    }
    if (task.planning_phase !== 'confirm') {
      return NextResponse.json(
        { error: `Can only lock from confirm phase (current: ${task.planning_phase})` },
        { status: 400 }
      );
    }
    if (!task.planning_spec) {
      return NextResponse.json(
        { error: 'No spec to lock — planner has not produced a plan yet' },
        { status: 400 }
      );
    }

    const { firstAgentId, dispatchError } = await lockAndDispatch(taskId);

    return NextResponse.json({
      success: !dispatchError,
      firstAgentId,
      dispatchError,
    });
  } catch (err) {
    console.error('[Planning Lock] Error:', err);
    return NextResponse.json(
      { error: 'Failed to lock planning: ' + (err as Error).message },
      { status: 500 }
    );
  }
}
