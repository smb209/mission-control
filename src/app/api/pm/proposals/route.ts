/**
 * /api/pm/proposals
 *
 *   POST  body { workspace_id, trigger_text, trigger_kind? }
 *         → triggers PM dispatch, returns the new draft proposal.
 *   GET   query { workspace_id?, status?, since?, limit? }
 *         → list proposals.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { listProposals, type PmProposalStatus } from '@/lib/db/pm-proposals';
import { dispatchPm } from '@/lib/agents/pm-dispatch';

export const dynamic = 'force-dynamic';

const PostSchema = z.object({
  workspace_id: z.string().min(1),
  trigger_text: z.string().min(1).max(20000),
  trigger_kind: z
    .enum(['manual', 'scheduled_drift_scan', 'disruption_event', 'status_check_investigation'])
    .optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = PostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    const result = dispatchPm(parsed.data);
    return NextResponse.json(
      {
        proposal: result.proposal,
        awaiting_agent: result.awaiting_agent,
        // Back-compat: flag indicates the *current* row is the synth
        // placeholder. SSE `pm_proposal_replaced` will follow when the
        // agent's proposal supersedes it.
        used_synthesize_fallback: result.used_synthesize_fallback,
      },
      { status: 201 },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to create proposal';
    console.error('Failed to create PM proposal:', error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

const STATUS_VALUES: PmProposalStatus[] = ['draft', 'accepted', 'rejected', 'superseded'];

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const limitRaw = searchParams.get('limit');
    const filters = {
      workspace_id: searchParams.get('workspace_id') || undefined,
      status:
        status && (STATUS_VALUES as string[]).includes(status)
          ? (status as PmProposalStatus)
          : undefined,
      since: searchParams.get('since') || undefined,
      limit: limitRaw ? Math.max(1, parseInt(limitRaw, 10) || 50) : undefined,
    };
    const rows = listProposals(filters);
    // Hide proposals with zero structured changes from the list views.
    // These are pure noise — Mode B placeholders that pre-date PR #234's
    // auto-cleanup, accepted-but-empty rows from older dispatches, etc.
    // Affects both the /pm recents sidebar (status=draft) and the
    // /pm/activity page (status=accepted): a 0-change accepted proposal
    // doesn't represent a roadmap mutation worth surfacing in audit, and
    // a 0-change draft is just dead weight.
    //
    // Operators can still view individual rows via direct
    // /pm/proposals/<id> URLs, and can hard-delete via DELETE
    // /api/pm/proposals/<id> (PR #235).
    const visible = rows.filter((p) => p.proposed_changes.length > 0);
    return NextResponse.json(visible);
  } catch (error) {
    console.error('Failed to list PM proposals:', error);
    const msg = error instanceof Error ? error.message : 'Failed to list proposals';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
