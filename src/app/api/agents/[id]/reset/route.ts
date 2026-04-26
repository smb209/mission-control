import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run, transaction } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { sendChatToAgent } from '@/lib/openclaw/send-chat';
import { broadcast } from '@/lib/events';
import { logDebugEvent } from '@/lib/debug-log';
import type { Agent } from '@/lib/types';

export const dynamic = 'force-dynamic';

// POST /api/agents/[id]/reset
//
// Reset a single agent's session — the per-agent equivalent of
// `DELETE /api/openclaw/sessions` (the bulk "Reset all sessions" action in
// the sidebar). Used by the Agent info modal so the operator can re-init
// one agent (e.g., after editing its SOUL.md / AGENTS.md / USER.md) without
// blowing away every session in the workspace.
//
// Two phases, mirroring the bulk reset:
//   1. Wipe this agent's rows in `openclaw_sessions` so MC's session map
//      stops pointing at the soon-to-be-restarted session.
//   2. Send `/reset` via chat to the agent's main session, forcing the
//      gateway to re-init. The agent's next message reloads its persona
//      files. `/reset` is one of OpenClaw's built-in init commands.
//
// Returns: { success, deleted, sent, sessionKey, error?, gateway_error? }
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }
    if (!agent.gateway_agent_id) {
      // Local-only agents have no gateway session to reset — surface a
      // clear error rather than silently doing nothing.
      return NextResponse.json(
        { error: 'Agent has no gateway_agent_id; nothing to reset on the gateway side.' },
        { status: 400 },
      );
    }

    // Phase 1: clear MC's session map for this agent + flip status to
    // standby so the sidebar doesn't show stale "active" pills until the
    // gateway re-init lands.
    let deleted = 0;
    transaction(() => {
      const result = run('DELETE FROM openclaw_sessions WHERE agent_id = ?', [agent.id]);
      deleted = result.changes ?? 0;
      run('UPDATE agents SET status = ? WHERE id = ?', ['standby', agent.id]);
    });

    logDebugEvent({
      type: 'session.end',
      direction: 'internal',
      agentId: agent.id,
      metadata: { reason: 'single_agent_reset', deleted },
    });

    // Phase 2: ask the gateway to re-init the agent's main session.
    const client = getOpenClawClient();
    try {
      if (!client.isConnected()) await client.connect();
    } catch (err) {
      // MC-side already cleared. Operator can fall back to typing `/reset`
      // in that agent's chat once the gateway is reachable again.
      return NextResponse.json({
        success: true,
        deleted,
        sent: false,
        sessionKey: null,
        gateway_error: (err as Error).message,
      });
    }

    const result = await sendChatToAgent({
      agent,
      message: '/reset',
      idempotencyKey: `reset-${agent.id}-${Date.now()}`,
    });

    broadcast({
      type: 'agent_completed',
      payload: {
        reset: true,
        agent_id: agent.id,
        sent: result.sent,
        deleted,
      },
    });

    if (result.sent) {
      return NextResponse.json({
        success: true,
        deleted,
        sent: true,
        sessionKey: result.sessionKey,
      });
    }

    return NextResponse.json(
      {
        success: false,
        deleted,
        sent: false,
        sessionKey: result.sessionKey,
        error: result.error?.message ?? result.reason ?? 'send failed',
      },
      { status: 502 },
    );
  } catch (error) {
    console.error('Failed to reset agent session:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
