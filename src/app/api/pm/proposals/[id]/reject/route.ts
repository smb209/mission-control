/**
 * POST /api/pm/proposals/[id]/reject — mark proposal rejected.
 */

import { NextRequest, NextResponse } from 'next/server';
import { rejectProposal, PmProposalValidationError } from '@/lib/db/pm-proposals';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  try {
    const proposal = rejectProposal(id);
    return NextResponse.json({ proposal });
  } catch (err) {
    if (err instanceof PmProposalValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const msg = err instanceof Error ? err.message : 'Failed to reject proposal';
    console.error('Failed to reject proposal:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
