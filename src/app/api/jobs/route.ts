/**
 * GET /api/jobs?workspace_id=…
 *
 * Backs the /jobs page. Returns three buckets in one shot:
 *   - live:      queued+running agent_runs (pm_chat collapsed by scope_key)
 *   - scheduled: active recurring_jobs with next_run_at within 24h
 *   - recent:    terminal agent_runs from the last 24h (ungrouped)
 *
 * See specs/jobs-in-progress.md §API. Polled every 2s by the page;
 * SSE upgrade is a follow-up if cost matters.
 */

import { NextRequest, NextResponse } from 'next/server';
import { listJobs, AgentRunValidationError } from '@/lib/db/agent-runs';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get('workspace_id');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspace_id is required' }, { status: 400 });
    }
    return NextResponse.json(listJobs(workspaceId));
  } catch (error) {
    if (error instanceof AgentRunValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Failed to list jobs:', error);
    return NextResponse.json({ error: 'Failed to list jobs' }, { status: 500 });
  }
}
