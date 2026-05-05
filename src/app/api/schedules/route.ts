/**
 * Workspace-scoped schedule list. Drives the hub's "Upcoming" lane.
 *
 *  GET /api/schedules?workspace_id=...&limit=10
 *
 * Filters to research-bound, active rows ordered by `next_run_at` ASC.
 * Limit caps at 100 (DAO enforces). See build-plan §3.
 */

import { NextRequest, NextResponse } from 'next/server';
import { listUpcomingResearch } from '@/lib/db/recurring-jobs';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get('workspace_id');
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspace_id is required' }, { status: 400 });
  }
  const limitRaw = searchParams.get('limit');
  const limit = limitRaw ? parseInt(limitRaw, 10) : 10;
  if (!Number.isFinite(limit) || limit <= 0) {
    return NextResponse.json({ error: 'limit must be a positive integer' }, { status: 400 });
  }
  const rows = listUpcomingResearch(workspaceId, limit);
  return NextResponse.json(rows);
}
