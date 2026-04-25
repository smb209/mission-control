/**
 * GET /api/pm/proposals/[id] — fetch one proposal.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getProposal } from '@/lib/db/pm-proposals';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const proposal = getProposal(id);
  if (!proposal) {
    return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
  }
  return NextResponse.json(proposal);
}
