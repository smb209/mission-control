import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { sendChatToAgent, buildAgentSessionKey } from '@/lib/openclaw/send-chat';
import { attachChatListener, expectAgentReply } from '@/lib/chat-listener';
import { broadcast } from '@/lib/events';
import type { Agent, AgentChatMessage } from '@/lib/types';

// Ensure the reply listener is attached even when no SSE subscriber is open,
// so out-of-band agent replies land in agent_chat_messages.
attachChatListener();

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Stable session key for per-agent chat. Unlike task dispatches, there's no
 * task UUID to embed; we derive a deterministic suffix from the agent id so
 * repeat messages reuse the same conversation session. We deliberately avoid
 * embedding a UUID pattern — `extractTaskIdFromSessionKey` would otherwise
 * misattribute these rows to a task that doesn't exist.
 */
function agentChatSessionKey(agent: Pick<Agent, 'session_key_prefix' | 'gateway_agent_id' | 'name' | 'id'>): string {
  return buildAgentSessionKey(agent, `chat-${agent.id.slice(0, 8)}`);
}

// GET /api/agents/[id]/chat — history, oldest first
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const messages = queryAll<AgentChatMessage>(
      `SELECT * FROM agent_chat_messages WHERE agent_id = ? ORDER BY created_at ASC`,
      [id]
    );
    return NextResponse.json(messages);
  } catch (error) {
    console.error('Failed to fetch agent chat:', error);
    return NextResponse.json({ error: 'Failed to fetch chat' }, { status: 500 });
  }
}

// POST /api/agents/[id]/chat — send a message to the agent
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id: agentId } = await params;
    const body = await request.json();
    const { message } = body as { message?: string };

    if (!message || !message.trim()) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const sessionKey = agentChatSessionKey(agent);
    const messageId = uuidv4();

    run(
      `INSERT INTO agent_chat_messages (id, agent_id, role, content, status, session_key)
       VALUES (?, ?, 'user', ?, 'pending', ?)`,
      [messageId, agentId, message.trim(), sessionKey]
    );
    broadcast({ type: 'agent_chat_message', payload: { agentId, messageId } });

    // Try chat.send with a 5s timeout — same pattern as task chat.
    let delivered = false;
    try {
      const client = getOpenClawClient();
      if (client.isConnected()) {
        // Use the shared helper but enforce the same 5s budget by
        // racing against a timeout — sendChatToAgent doesn't expose
        // its own timeout (its only failure modes are no_session /
        // send_failed). The race preserves the previous "if the
        // gateway is mid-turn we still register the user message"
        // semantics.
        const sendPromise = sendChatToAgent({
          agent,
          message: message.trim(),
          idempotencyKey: `agent-chat-${messageId}`,
          sessionSuffix: `chat-${agent.id.slice(0, 8)}`,
        });
        const timeout = new Promise<{ sent: false; reason: 'send_failed'; sessionKey: string; error: Error }>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 5000)
        );
        const result = await Promise.race([sendPromise, timeout]);
        if (result.sent) {
          delivered = true;
          run(
            `UPDATE agent_chat_messages SET status = 'delivered' WHERE id = ?`,
            [messageId]
          );
          expectAgentReply(sessionKey, agentId);
        } else if (result.error) {
          throw result.error;
        }
      }
    } catch (err) {
      console.warn(`[AgentChat] chat.send failed for ${sessionKey}:`, err);
    }

    if (!delivered) {
      console.log(`[AgentChat] Message queued for agent ${agentId} (sessionKey=${sessionKey})`);
    }

    const saved = queryOne<AgentChatMessage>(
      `SELECT * FROM agent_chat_messages WHERE id = ?`,
      [messageId]
    )!;
    return NextResponse.json(saved, { status: 201 });
  } catch (error) {
    console.error('Failed to send agent chat message:', error);
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 });
  }
}
