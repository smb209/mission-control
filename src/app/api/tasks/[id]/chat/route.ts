import { NextRequest, NextResponse } from 'next/server';
import { createNote, getTaskNotes, getActiveSessionForTask, markNotesDelivered } from '@/lib/task-notes';
import { sendChatToSession } from '@/lib/openclaw/send-chat';
import { internalDispatch } from '@/lib/internal-dispatch';
import { attachChatListener, expectReply } from '@/lib/chat-listener';
import { queryOne } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Ensure reply listener is attached even when the task chat UI is used without
// an SSE subscriber. TaskChatTab polls /api/tasks/:id/chat directly and may
// never open /api/events/stream, so relying on the SSE route to attach the
// listener causes agent replies to be missed.
attachChatListener();

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/tasks/[id]/chat — Get chat history
export async function GET(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { id } = await params;
    const notes = getTaskNotes(id);
    return NextResponse.json(notes);
  } catch (error) {
    console.error('Failed to fetch task notes:', error);
    return NextResponse.json({ error: 'Failed to fetch task notes' }, { status: 500 });
  }
}

// POST /api/tasks/[id]/chat — Send a message to the agent
export async function POST(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { id: taskId } = await params;
    const body = await request.json();
    const { message } = body as { message?: string };

    if (!message || !message.trim()) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    // Check task exists and is in a dispatchable state
    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Store the user message
    const note = createNote(taskId, message.trim(), 'direct', 'user');
    broadcast({ type: 'note_queued', payload: { taskId, noteId: note.id } });

    // Try to deliver to the agent
    let delivered = false;
    const sessionInfo = getActiveSessionForTask(taskId);

    if (sessionInfo) {
      // Try chat.send with a 5s timeout — if agent is mid-turn this
      // works quickly. The helper folds in the timeout race that used
      // to live here.
      const result = await sendChatToSession({
        sessionKey: sessionInfo.sessionKey,
        message: message.trim(),
        idempotencyKey: `chat-${note.id}`,
        timeoutMs: 5_000,
      });
      if (result.sent) {
        delivered = true;
        markNotesDelivered([note.id]);
        expectReply(sessionInfo.sessionKey, taskId);
        console.log(`[Chat] Message delivered via chat.send to ${sessionInfo.sessionKey}`);
      } else if (result.reason === 'timeout') {
        console.log('[Chat] chat.send timed out — will try dispatch fallback');
      } else if (result.reason === 'send_failed') {
        console.log('[Chat] chat.send failed — will try dispatch fallback:', result.error?.message);
      }
    }

    // Fall back to dispatch only if:
    // 1. Message wasn't delivered via chat.send
    // 2. Task is in a state where dispatch makes sense (not done, not already in_progress)
    if (!delivered && ['assigned', 'inbox', 'testing', 'review', 'verification'].includes(task.status)) {
      const result = await internalDispatch(taskId, { caller: 'chat-fallback' });
      if (result.success) {
        delivered = true;
        markNotesDelivered([note.id]);
        const freshSession = getActiveSessionForTask(taskId);
        if (freshSession) expectReply(freshSession.sessionKey, taskId);
        console.log(`[Chat] Message delivered via dispatch for task ${taskId}`);
      } else {
        console.warn(`[Chat] Dispatch fallback failed:`, result.error);
      }
    }

    if (!delivered) {
      console.log(`[Chat] Message queued as pending note for task ${taskId} (status: ${task.status})`);
    }

    // Return the saved note
    const updatedNote = getTaskNotes(taskId).find(n => n.id === note.id) || note;
    return NextResponse.json(updatedNote, { status: 201 });
  } catch (error) {
    console.error('Failed to send chat message:', error);
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 });
  }
}
