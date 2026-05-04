import { NextRequest, NextResponse } from 'next/server';
import { deleteBrief, getBrief } from '@/lib/db/briefs';
import { getAgentRun } from '@/lib/db/agent-runs';
import { broadcast } from '@/lib/events';

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

/**
 * DELETE /api/briefs/[id]
 *
 * Hard-deletes the brief and its 1:1 agent_run. Allowed in any state
 * (incorrect prompt, no longer relevant, mid-flight) — the
 * orchestrator's writes after deletion silently no-op.
 */
export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const brief = getBrief(id);
  if (!brief) return NextResponse.json({ error: 'Brief not found' }, { status: 404 });
  const ok = deleteBrief(id);
  if (!ok) return NextResponse.json({ error: 'Brief not found' }, { status: 404 });
  // Tell the hub + topic detail to refresh.
  try {
    broadcast({
      type: 'brief_failed', // re-using the existing channel to trigger
                            // the hub's "RELEVANT_EVENTS" refetch path
                            // without minting a brand-new event type.
      payload: {
        brief_id: id,
        agent_run_id: brief.agent_run_id,
        workspace_id: brief.workspace_id,
        topic_id: brief.topic_id,
        deleted: true,
      },
    });
  } catch {
    // SSE broadcast failure must not block deletion.
  }
  return NextResponse.json({ deleted: true, brief_id: id });
}
