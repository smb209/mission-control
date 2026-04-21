import { NextResponse } from 'next/server';
import { getAllAgentPings } from '@/lib/agent-pings';

export const dynamic = 'force-dynamic';

// GET /api/agents/activity — Snapshot of per-agent last-sent/last-received
// timestamps. Used by the sidebar to hydrate the ping indicators on mount;
// live updates arrive via SSE `agent_pinged` events.
export async function GET() {
  try {
    return NextResponse.json(getAllAgentPings());
  } catch {
    return NextResponse.json({ error: 'Failed to fetch agent activity' }, { status: 500 });
  }
}
