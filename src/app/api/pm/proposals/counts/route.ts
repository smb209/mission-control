/**
 * GET /api/pm/proposals/counts?workspace_id=…
 *
 * Returns per-status counts for the workspace's pm_proposals. Drives
 * the /pm sidebar's "Delete proposals…" modal so the operator sees how
 * many rows each status-checkbox would remove.
 *
 * Response: { draft, accepted, rejected, superseded }
 */

import { NextRequest, NextResponse } from 'next/server';
import { countProposalsByStatus } from '@/lib/db/pm-proposals';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const workspaceId = request.nextUrl.searchParams.get('workspace_id');
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  }
  try {
    const counts = countProposalsByStatus(workspaceId);
    return NextResponse.json(counts);
  } catch (err) {
    console.error('[proposals/counts] failed:', err);
    return NextResponse.json({ error: 'count failed' }, { status: 500 });
  }
}
