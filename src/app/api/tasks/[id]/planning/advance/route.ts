/**
 * POST /api/tasks/[id]/planning/advance
 *
 * User-gated phase transition. The planner never advances its own phase —
 * it emits "I'm confident" or "I'm done researching" and waits. This
 * endpoint is what the UI calls when the user clicks "Start research" or
 * "Continue to plan", and it sends the appropriate kickoff prompt to the
 * planner session so the next round of work begins.
 *
 * Request body: { to: 'research' | 'plan' }
 *
 * Legal transitions:
 *   clarify → research     (only if last clarify envelope said needs_research:true
 *                           or the user override-forces it via force:true)
 *   clarify → plan         (default when clarify is done and research isn't needed)
 *   research → plan        (after research_done envelope)
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { broadcast } from '@/lib/events';
import {
  buildResearchKickoffPrompt,
  buildPlanKickoffPrompt,
} from '@/lib/planner-prompt';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const body = await request.json().catch(() => ({}));
    const to = body.to as 'research' | 'plan' | undefined;
    if (to !== 'research' && to !== 'plan') {
      return NextResponse.json(
        { error: 'Invalid advance target — must be "research" or "plan"' },
        { status: 400 }
      );
    }

    const task = queryOne<{
      id: string;
      planning_session_key?: string;
      planning_phase?: string;
      planning_understanding?: string;
      planning_unknowns?: string;
      planning_research?: string;
    }>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    if (!task.planning_session_key) {
      return NextResponse.json({ error: 'Planning has not started' }, { status: 400 });
    }

    const currentPhase = task.planning_phase || 'clarify';

    // Validate transition is legal.
    if (to === 'research' && currentPhase !== 'clarify') {
      return NextResponse.json(
        { error: `Cannot advance to research from phase "${currentPhase}"` },
        { status: 400 }
      );
    }
    if (to === 'plan' && currentPhase !== 'clarify' && currentPhase !== 'research') {
      return NextResponse.json(
        { error: `Cannot advance to plan from phase "${currentPhase}"` },
        { status: 400 }
      );
    }

    const understanding = task.planning_understanding || '(understanding not recorded)';
    const unknowns: string[] = task.planning_unknowns ? JSON.parse(task.planning_unknowns) : [];
    const research = task.planning_research ? JSON.parse(task.planning_research) : null;

    // Build the prompt for the new phase.
    let prompt: string;
    if (to === 'research') {
      prompt = buildResearchKickoffPrompt({ understanding, unknowns });
    } else {
      prompt = buildPlanKickoffPrompt({
        understanding,
        researchSummary: research?.summary,
      });
    }

    // Send the kickoff message. The poll endpoint will pick up whatever the
    // planner emits next.
    const client = getOpenClawClient();
    if (!client.isConnected()) await client.connect();
    await client.call('chat.send', {
      sessionKey: task.planning_session_key,
      message: prompt,
      idempotencyKey: `planning-advance-${to}-${taskId}-${Date.now()}`,
    });

    // Record the transition. We store the "target" phase optimistically so the
    // UI renders the right loader while the planner responds. The poll loop
    // will replace it with 'research' or 'confirm' based on what comes back.
    run(
      `UPDATE tasks SET planning_phase = ?, updated_at = datetime('now') WHERE id = ?`,
      [to, taskId]
    );

    const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (updatedTask) broadcast({ type: 'task_updated', payload: updatedTask });

    return NextResponse.json({ success: true, phase: to });
  } catch (err) {
    console.error('[Planning Advance] Error:', err);
    return NextResponse.json(
      { error: 'Failed to advance planning phase: ' + (err as Error).message },
      { status: 500 }
    );
  }
}
