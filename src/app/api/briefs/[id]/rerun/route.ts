import { NextRequest, NextResponse } from 'next/server';
import { logApiError } from '@/lib/debug-log';
import {
  BriefValidationError,
  createBriefWithRun,
  getBrief,
} from '@/lib/db/briefs';
import { runBrief } from '@/lib/research/run-brief';

export const dynamic = 'force-dynamic';

/**
 * POST /api/briefs/[id]/rerun
 *
 * Clones a brief and dispatches the clone. The original brief stays
 * put as audit evidence (we never mutate completed/failed briefs in
 * place). Returns the new {brief, agent_run} envelope plus the run
 * dispatch state, so the UI can navigate to the new brief and start
 * tailing SSE.
 *
 * Allowed when the original is in a terminal state (complete /
 * failed / cancelled). Refuses to rerun queued/running because the
 * caller should wait for that one to finish first.
 */
export async function POST(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const original = getBrief(id);
  if (!original) {
    return NextResponse.json({ error: 'Brief not found' }, { status: 404 });
  }

  try {
    const { brief, agent_run } = createBriefWithRun({
      workspace_id: original.workspace_id,
      template: original.template,
      title: original.title,
      prompt: original.prompt,
      topic_id: original.topic_id,
      // Carry initiative_id from the original so the rerun's auto-note
      // (slice 3 of initiative-research-loop) lands on the same
      // initiative and replaces the prior auto-note via chain dedupe.
      initiative_id: original.initiative_id,
      requested_by: `rerun:${original.id}`,
      source_kind: 'manual',
      source_ref: `brief:${original.id}`,
    });

    const dispatch = await runBrief(brief.id);
    if (dispatch.state === 'rejected') {
      return NextResponse.json({
        brief,
        agent_run,
        dispatch_state: 'rejected',
        dispatch_reason: dispatch.reason,
      }, { status: 202 });
    }

    return NextResponse.json({
      brief,
      agent_run,
      dispatch_state: 'started',
      cloned_from: original.id,
    }, { status: 202 });
  } catch (error) {
    if (error instanceof BriefValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logApiError({ route: '/api/briefs/[id]/rerun', method: 'POST', status: 500, error });
    const msg = error instanceof Error ? error.message : 'Failed to rerun brief';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
