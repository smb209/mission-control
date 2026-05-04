import { NextRequest, NextResponse } from 'next/server';
import { getBrief } from '@/lib/db/briefs';
import { getAgentRun } from '@/lib/db/agent-runs';

export const dynamic = 'force-dynamic';

/**
 * GET /api/briefs/[id]
 *
 * Returns the brief plus its 1:1 agent_run envelope so a single
 * fetch hydrates everything the brief detail UI needs (status,
 * timestamps, error_md, etc.). Cheaper than two round-trips.
 */
export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const brief = getBrief(id);
  if (!brief) return NextResponse.json({ error: 'Brief not found' }, { status: 404 });
  const agent_run = getAgentRun(brief.agent_run_id);
  return NextResponse.json({ brief, agent_run });
}
