/**
 * POST /api/tasks/[id]/planning/tweak
 *
 * Free-form spec revision. Once the planner has emitted a plan envelope and
 * the task is sitting in the confirm phase, the user can submit a tweak
 * message (e.g. "add a dark mode toggle to deliverables" or "drop the
 * service worker — PWA is out of scope"). This endpoint forwards the tweak
 * to the planner; the planner responds with a revised plan in a
 * `phase: "confirm"` envelope which the poll endpoint persists as the new
 * spec.
 *
 * Request body: { message: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { sendChatToSession } from '@/lib/openclaw/send-chat';
import { buildTweakPrompt } from '@/lib/planner-prompt';
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
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) {
      return NextResponse.json({ error: 'message is required' }, { status: 400 });
    }

    const task = queryOne<{
      id: string;
      planning_session_key?: string;
      planning_phase?: string;
      planning_complete?: number;
      planning_messages?: string;
    }>('SELECT * FROM tasks WHERE id = ?', [taskId]);

    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    if (!task.planning_session_key) {
      return NextResponse.json({ error: 'Planning has not started' }, { status: 400 });
    }
    if (task.planning_complete) {
      return NextResponse.json(
        { error: 'Planning is already locked — cannot tweak' },
        { status: 400 }
      );
    }
    if (task.planning_phase !== 'confirm' && task.planning_phase !== 'plan') {
      return NextResponse.json(
        { error: `Tweaks only allowed in confirm phase (current: ${task.planning_phase})` },
        { status: 400 }
      );
    }

    const client = getOpenClawClient();
    if (!client.isConnected()) await client.connect();
    const sendResult = await sendChatToSession({
      sessionKey: task.planning_session_key,
      message: buildTweakPrompt(message),
      idempotencyKey: `planning-tweak-${taskId}-${Date.now()}`,
    });
    if (!sendResult.sent) {
      throw sendResult.error ?? new Error(sendResult.reason ?? 'chat.send failed');
    }

    // Append the tweak to the message log so the UI shows the conversation.
    const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];
    messages.push({ role: 'user', content: `Tweak: ${message}`, timestamp: Date.now() });
    run(`UPDATE tasks SET planning_messages = ? WHERE id = ?`, [JSON.stringify(messages), taskId]);

    const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (updatedTask) broadcast({ type: 'task_updated', payload: updatedTask });

    return NextResponse.json({ success: true, messages });
  } catch (err) {
    console.error('[Planning Tweak] Error:', err);
    return NextResponse.json(
      { error: 'Failed to send tweak: ' + (err as Error).message },
      { status: 500 }
    );
  }
}
