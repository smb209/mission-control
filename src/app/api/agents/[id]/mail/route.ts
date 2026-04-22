import { NextRequest, NextResponse } from 'next/server';
import { queryOne } from '@/lib/db';
import { getUnreadMail, markAsRead, sendMail } from '@/lib/mailbox';
import { recordRollCallReplyIfMatch } from '@/lib/rollcall';
import { authorizeAgentActive, authorizeAgentForTask } from '@/lib/authz/http';
import type { Agent } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/agents/[id]/mail — Get unread mail for an agent
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const messages = getUnreadMail(id);
    return NextResponse.json(messages);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch mail' }, { status: 500 });
  }
}

/**
 * POST /api/agents/[id]/mail — Send mail to this agent from another.
 *
 * Body: {
 *   from_agent_id: string,
 *   subject?: string,
 *   body: string,
 *   convoy_id?: string,    // optional scope
 *   task_id?: string,      // optional scope
 *   push?: boolean         // if true, also deliver via chat.send immediately
 * }
 *
 * Counterpart to /api/convoy/[convoyId]/mail — this one handles mail that
 * lives outside a convoy (roll-call, help-requests to the master
 * orchestrator, ad-hoc inter-agent messages). Agents reply to mail by
 * POSTing back the other direction.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: toAgentId } = await params;
    const body = await request.json() as {
      from_agent_id?: string;
      subject?: string;
      body?: string;
      convoy_id?: string;
      task_id?: string;
      push?: boolean;
    };

    if (!body.from_agent_id || !body.body) {
      return NextResponse.json(
        { error: 'from_agent_id and body are required' },
        { status: 400 }
      );
    }

    // Authorize the sender: must be an existing, active agent. Replaces the
    // looser "agent row exists" check — disabled agents should not send mail.
    const senderFail = authorizeAgentActive(body.from_agent_id);
    if (senderFail) return senderFail;

    // If the mail is scoped to a task (help_request, task-local coordination),
    // the sender must be on that task. Cross-task probing via mail is a real
    // vector — an agent that learns of a task_id could otherwise use mail to
    // pressure other agents outside its assignment.
    if (body.task_id) {
      const taskFail = authorizeAgentForTask(body.from_agent_id, body.task_id, 'activity');
      if (taskFail) return taskFail;
    }

    // Recipient existence still needs a plain lookup — the recipient doesn't
    // authorize the call; they just need to exist so the FK on agent_mailbox
    // doesn't blow up with an opaque 500.
    const recipient = queryOne<Agent>('SELECT id FROM agents WHERE id = ?', [toAgentId]);
    if (!recipient) {
      return NextResponse.json({ error: `Recipient agent ${toAgentId} not found` }, { status: 404 });
    }

    const result = await sendMail({
      convoyId: body.convoy_id || null,
      taskId: body.task_id || null,
      fromAgentId: body.from_agent_id,
      toAgentId,
      subject: body.subject,
      body: body.body,
      push: Boolean(body.push),
    });

    // If this mail looks like a reply to an open roll-call, record it
    // against the matching rollcall_entries row so the UI's live status
    // view flips from "waiting" to "responded" for this agent. No-op if
    // there's no match — stray replies are just regular mail.
    const rollcallMatch = recordRollCallReplyIfMatch({
      mailId: result.message.id,
      fromAgentId: body.from_agent_id,
      toAgentId,
      subject: body.subject,
      body: body.body,
    });

    return NextResponse.json(
      { ...result, rollcall_matched: rollcallMatch.matched, rollcall_id: rollcallMatch.rollcallId },
      { status: 201 }
    );
  } catch (error) {
    console.error('[POST /api/agents/[id]/mail] failed:', error);
    return NextResponse.json(
      { error: `Failed to send mail: ${(error as Error).message}` },
      { status: 500 }
    );
  }
}

// PATCH /api/agents/[id]/mail?messageId=xxx — Mark message as read
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const messageId = request.nextUrl.searchParams.get('messageId');
    if (!messageId) {
      return NextResponse.json({ error: 'messageId query param is required' }, { status: 400 });
    }

    markAsRead(messageId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to mark message as read' }, { status: 500 });
  }
}
