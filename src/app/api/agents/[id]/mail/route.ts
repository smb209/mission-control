import { NextRequest, NextResponse } from 'next/server';
import { getUnreadMail, markAsRead } from '@/lib/mailbox';
import { AuthzError } from '@/lib/authz/agent-task';
import { authzErrorResponse } from '@/lib/authz/http';
import { sendAgentMail } from '@/lib/services/agent-mailbox';

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

    let result;
    try {
      result = await sendAgentMail({
        fromAgentId: body.from_agent_id,
        toAgentId,
        body: body.body,
        subject: body.subject,
        convoyId: body.convoy_id ?? null,
        taskId: body.task_id ?? null,
        push: body.push,
      });
    } catch (err) {
      if (err instanceof AuthzError) return authzErrorResponse(err);
      throw err;
    }

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        message: result.message,
        push: result.push,
        rollcall_matched: result.rollcallMatched,
        rollcall_id: result.rollcallId,
      },
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
