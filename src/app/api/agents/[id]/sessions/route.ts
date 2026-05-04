import { NextRequest, NextResponse } from 'next/server';
import { queryAll, queryOne } from '@/lib/db';
import { resolveAgentSessionKeyPrefix } from '@/lib/openclaw/session-key';
import type { Agent, OpenClawSession } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

type PrefixSource = 'explicit' | 'gateway_agent_id' | 'runner_fallback';

function derivePrefixSource(agent: Pick<Agent, 'session_key_prefix' | 'gateway_agent_id'>): PrefixSource {
  if (agent.session_key_prefix?.trim()) return 'explicit';
  if (agent.gateway_agent_id) return 'gateway_agent_id';
  return 'runner_fallback';
}

// GET /api/agents/[id]/sessions
// Detailed view used by the AgentModal's "Session info" panel: returns the
// resolved sessionKey prefix (and how it was derived) plus the recent
// openclaw_sessions rows for this agent (active first, then history).
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [id]);
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    const sessions = queryAll<OpenClawSession>(
      `SELECT * FROM openclaw_sessions
       WHERE agent_id = ?
       ORDER BY (status = 'active') DESC, COALESCE(updated_at, created_at) DESC
       LIMIT 25`,
      [id]
    );

    return NextResponse.json({
      agent_id: agent.id,
      source: agent.source,
      gateway_agent_id: agent.gateway_agent_id ?? null,
      session_key_prefix: agent.session_key_prefix ?? null,
      resolved_prefix: resolveAgentSessionKeyPrefix(agent),
      prefix_source: derivePrefixSource(agent),
      sessions,
    });
  } catch (error) {
    console.error('Failed to load agent sessions:', error);
    return NextResponse.json(
      { error: 'Failed to load agent sessions' },
      { status: 500 }
    );
  }
}
