/**
 * POST /api/tasks/[id]/planning/clarify-add
 *
 * User injects additional context during the clarify phase. Unlike /answer
 * (which replies to a specific planner question) this is an unsolicited
 * clarification the planner should fold into its understanding.
 *
 * Body: { clarification: string }
 *
 * Only legal while planning_phase is 'clarify'. Sends a dedicated prompt
 * to the planner session; the poll endpoint picks up the next envelope.
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { sendChatToSession } from '@/lib/openclaw/send-chat';
import { buildClarifyAddonPrompt } from '@/lib/planner-prompt';
import { broadcast } from '@/lib/events';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const body = await request.json().catch(() => ({}));
    const clarification = typeof body.clarification === 'string' ? body.clarification.trim() : '';
    if (!clarification) {
      return NextResponse.json({ error: 'clarification is required' }, { status: 400 });
    }

    const task = queryOne<{
      id: string;
      planning_session_key?: string;
      planning_phase?: string;
      planning_messages?: string;
    }>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    if (!task.planning_session_key) {
      return NextResponse.json({ error: 'Planning has not started' }, { status: 400 });
    }
    if (task.planning_phase !== 'clarify') {
      return NextResponse.json(
        { error: `Clarifications only accepted during the clarify phase (current: ${task.planning_phase})` },
        { status: 400 }
      );
    }

    const client = getOpenClawClient();
    if (!client.isConnected()) await client.connect();
    const sendResult = await sendChatToSession({
      sessionKey: task.planning_session_key,
      message: buildClarifyAddonPrompt(clarification),
      idempotencyKey: `planning-clarify-add-${taskId}-${Date.now()}`,
    });
    if (!sendResult.sent) {
      throw sendResult.error ?? new Error(sendResult.reason ?? 'chat.send failed');
    }

    // Append the user's clarification to the visible conversation log.
    const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];
    messages.push({
      role: 'user',
      content: `Clarification: ${clarification}`,
      timestamp: Date.now(),
    });
    run(`UPDATE tasks SET planning_messages = ? WHERE id = ?`, [JSON.stringify(messages), taskId]);

    const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (updatedTask) broadcast({ type: 'task_updated', payload: updatedTask });

    return NextResponse.json({ success: true, messages });
  } catch (err) {
    console.error('[Planning Clarify-Add] Error:', err);
    return NextResponse.json(
      { error: 'Failed to add clarification: ' + (err as Error).message },
      { status: 500 }
    );
  }
}
