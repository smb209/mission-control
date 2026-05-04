import { NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { sendChatToSession } from '@/lib/openclaw/send-chat';
import { resolveAgentSessionKeyPrefix } from '@/lib/openclaw/session-key';
import { logDebugEvent } from '@/lib/debug-log';
import type { Agent, OpenClawSession } from '@/lib/types';

/**
 * `openclaw_sessions.openclaw_session_id` is overloaded across the
 * codebase: some writers store the literal gateway sessionKey
 * (`agent:<gateway_id>:<suffix>`), others store just the suffix
 * (`mission-control-<slug>-<task>`) and reconstruct the full key on
 * send via `prefix + suffix`. Reset has to send `/reset` to the
 * actual gateway sessionKey, so we detect the format here:
 *   - starts with `agent:` → already a full sessionKey, use directly.
 *   - else → treat as a suffix, look up the agent, compose
 *     `resolvedPrefix + suffix`.
 *
 * If the row's agent has been deleted we can't reconstruct, so we
 * fall back to the stored value as-is — better to attempt a /reset
 * that the gateway 404s than to silently no-op.
 */
function resolveResetSessionKey(session: OpenClawSession): string {
  const stored = session.openclaw_session_id;
  if (stored.startsWith('agent:')) return stored;
  const agent = queryOne<Agent>(
    'SELECT session_key_prefix, gateway_agent_id, name FROM agents WHERE id = ?',
    [session.agent_id],
  );
  if (!agent) return stored;
  return `${resolveAgentSessionKeyPrefix(agent)}${stored}`;
}

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/openclaw/sessions/[id]/reset
//
// Reset a single openclaw_sessions row (by internal id OR
// openclaw_session_id). Two phases, mirroring the per-agent reset
// route but scoped to one session:
//
//   1. Send `/reset` to the session's gateway sessionKey so the agent
//      re-init's its persona files / role briefing on the next turn.
//   2. Delete the MC-side row so the chat-route's persona-init guard
//      treats the next message as a fresh session and (for direct
//      chat) prepends the persona block again.
//
// Returns: { success, sent, sessionKey, deleted, error?, gateway_error? }
export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;

    let session = queryOne<OpenClawSession>(
      'SELECT * FROM openclaw_sessions WHERE id = ?',
      [id],
    );
    if (!session) {
      session = queryOne<OpenClawSession>(
        'SELECT * FROM openclaw_sessions WHERE openclaw_session_id = ?',
        [id],
      );
    }
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const sessionKey = resolveResetSessionKey(session);
    let sent = false;
    let gatewayError: string | undefined;

    const client = getOpenClawClient();
    try {
      if (!client.isConnected()) await client.connect();
      const result = await sendChatToSession({
        sessionKey,
        message: '/reset',
        idempotencyKey: `reset-session-${session.id}-${Date.now()}`,
      });
      sent = result.sent;
      if (!result.sent) {
        gatewayError = result.error?.message ?? result.reason ?? 'send failed';
      }
    } catch (err) {
      gatewayError = err instanceof Error ? err.message : String(err);
    }

    // Always clear the MC-side row, even if the gateway didn't ack —
    // the operator can retry the gateway side via the agent-level
    // reset / next chat. Leaving a stale row marks the session
    // "active" and would suppress persona-init injection.
    const result = run('DELETE FROM openclaw_sessions WHERE id = ?', [session.id]);
    const deleted = result.changes ?? 0;

    logDebugEvent({
      type: 'session.end',
      direction: 'internal',
      agentId: session.agent_id,
      taskId: session.task_id ?? undefined,
      sessionKey,
      metadata: { reason: 'single_session_reset', sent, gatewayError },
    });

    if (sent) {
      return NextResponse.json({ success: true, sent: true, sessionKey, deleted });
    }
    return NextResponse.json(
      {
        success: false,
        sent: false,
        sessionKey,
        deleted,
        error: gatewayError ?? 'send failed',
      },
      { status: 502 },
    );
  } catch (error) {
    console.error('Failed to reset session:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
