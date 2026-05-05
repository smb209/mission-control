import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run, transaction } from '@/lib/db';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { buildAgentSessionKey, sendChatToAgent } from '@/lib/openclaw/send-chat';
import { broadcast } from '@/lib/events';
import { logDebugEvent } from '@/lib/debug-log';
import type { Agent } from '@/lib/types';

export const dynamic = 'force-dynamic';

// POST /api/agents/[id]/reset[?session_suffix=<suffix>]
//
// Reset an agent's session(s). Two modes:
//
//   - Default (no `session_suffix`): wipe ALL openclaw_sessions rows for
//     this agent, then `/reset` the main session. Use when the operator
//     edited the agent's persona files or wants a clean slate.
//
//   - Per-session (with `session_suffix`): wipe ONLY the row matching
//     that suffix's full sessionKey, then `/reset` that one session.
//     The /pm "Reset chat session" button passes
//     `session_suffix=dispatch-main` to clear stale conversation history
//     on the PM dispatch session without re-initialising every other
//     session this agent has (each /reset is a model-init, so bulk
//     reset is real LLM spend).
//
// Returns: { success, deleted, sent, sessionKey, error?, gateway_error? }
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sessionSuffix = new URL(request.url).searchParams.get('session_suffix')?.trim() || null;
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

    const targetSessionKey = sessionSuffix ? buildAgentSessionKey(agent, sessionSuffix) : null;

    // Phase 1: clear MC's session map. Per-session resets touch only the
    // matching row; the broad reset (no suffix) wipes everything for
    // this agent and parks status back at standby so the sidebar
    // doesn't show stale "active" pills until the gateway re-init lands.
    let deleted = 0;
    transaction(() => {
      if (targetSessionKey) {
        // openclaw_sessions stores the full gateway sessionKey in
        // `openclaw_session_id` (see persona-init.ts markSessionInitialized).
        // We may or may not have a row for this specific session — many
        // dispatch sessions (dispatchScope-based) don't go through
        // markSessionInitialized at all. The /reset call below is the
        // authoritative cleanup; this just keeps MC's bookkeeping in
        // sync if we did happen to have a row.
        const result = run(
          'DELETE FROM openclaw_sessions WHERE agent_id = ? AND openclaw_session_id = ?',
          [agent.id, targetSessionKey],
        );
        deleted = result.changes ?? 0;
      } else {
        const result = run('DELETE FROM openclaw_sessions WHERE agent_id = ?', [agent.id]);
        deleted = result.changes ?? 0;
        run('UPDATE agents SET status = ? WHERE id = ?', ['standby', agent.id]);
      }
    });

    logDebugEvent({
      type: 'session.end',
      direction: 'internal',
      agentId: agent.id,
      sessionKey: targetSessionKey,
      metadata: {
        reason: targetSessionKey ? 'agent_session_reset' : 'single_agent_reset',
        deleted,
        session_suffix: sessionSuffix,
      },
    });

    // Phase 2: ask the gateway to re-init the targeted session.
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
      idempotencyKey: `reset-${agent.id}-${sessionSuffix ?? 'main'}-${Date.now()}`,
      sessionSuffix: sessionSuffix ?? undefined,
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
