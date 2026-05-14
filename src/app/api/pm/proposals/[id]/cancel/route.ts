/**
 * POST /api/pm/proposals/[id]/cancel — cancel a draft proposal's dispatch
 * (flip dispatch_state to 'cancelled', rejecting the synth placeholder).
 *
 * Broadcasts `pm_proposal_dispatch_state_changed` so the frontend SSE
 * handler can hide the InFlightProposalCard.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cancelProposal, PmProposalValidationError } from '@/lib/db/pm-proposals';
import { logApiError } from '@/lib/debug-log';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  try {
    // cancelProposal flips dispatch_state to 'cancelled' AND broadcasts
    // pm_proposal_dispatch_state_changed so the in-flight card hides
    // via SSE and the dispatcher poll loop short-circuits.
    const proposal = cancelProposal(id);
    return NextResponse.json({ proposal });
  } catch (err) {
    if (err instanceof PmProposalValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const msg = err instanceof Error ? err.message : 'Failed to cancel proposal';
    logApiError({ route: '/api/pm/proposals/[id]/cancel', method: 'POST', status: 500, error: err, metadata: { proposal_id: id } });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
