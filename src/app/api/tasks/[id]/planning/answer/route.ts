import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { sendChatToSession } from '@/lib/openclaw/send-chat';
import { buildClarifyAnswerPrompt } from '@/lib/planner-prompt';

export const dynamic = 'force-dynamic';
// POST /api/tasks/[id]/planning/answer - Submit an answer and get next question
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const body = await request.json();
    const { answer, otherText } = body;

    if (!answer) {
      return NextResponse.json({ error: 'Answer is required' }, { status: 400 });
    }

    // Get task
    const task = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as {
      id: string;
      title: string;
      description: string;
      planning_session_key?: string;
      planning_messages?: string;
    } | undefined;

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    if (!task.planning_session_key) {
      return NextResponse.json({ error: 'Planning not started' }, { status: 400 });
    }

    // Build the answer message
    const answerText = answer?.toLowerCase() === 'other' && otherText
      ? `Other: ${otherText}`
      : answer;

    // In the enhanced flow, /answer is ONLY called during the clarify phase.
    // Other transitions (start research, move to plan, submit a tweak, lock &
    // dispatch) have dedicated endpoints so the state machine stays explicit.
    const answerPrompt = buildClarifyAnswerPrompt(answerText);

    // Parse existing messages
    const messages = task.planning_messages ? JSON.parse(task.planning_messages) : [];
    messages.push({ role: 'user', content: answerText, timestamp: Date.now() });

    // Connect to OpenClaw and send the answer
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      console.log('[Planning Answer] Connecting to OpenClaw...');
      await client.connect();
    }

    console.log('[Planning Answer] Sending answer to OpenClaw, session:', task.planning_session_key);
    console.log('[Planning Answer] Answer text:', answerText);

    const sendResult = await sendChatToSession({
      sessionKey: task.planning_session_key,
      message: answerPrompt,
      idempotencyKey: `planning-answer-${taskId}-${Date.now()}`,
    });
    if (!sendResult.sent) {
      console.error('[Planning Answer] Failed to send to OpenClaw:', sendResult.error ?? sendResult.reason);
      return NextResponse.json(
        { error: 'Failed to send answer to orchestrator: ' + (sendResult.error?.message ?? sendResult.reason ?? 'unknown') },
        { status: 500 },
      );
    }
    console.log('[Planning Answer] Send successful, response:', sendResult.response);

    // Update messages in DB
    getDb().prepare(`
      UPDATE tasks SET planning_messages = ? WHERE id = ?
    `).run(JSON.stringify(messages), taskId);

    // Poll for response via OpenClaw API - removed aggressive polling
    // Return immediately and let frontend poll for updates
    // This eliminates 30 OpenClaw API calls per answer submission


    return NextResponse.json({
      success: true,
      messages,
      note: 'Answer submitted. Poll GET endpoint for updates.',
    });
  } catch (error) {
    console.error('Failed to submit answer:', error);
    return NextResponse.json({ error: 'Failed to submit answer: ' + (error as Error).message }, { status: 500 });
  }
}
