import { NextRequest, NextResponse } from 'next/server';
import { runBrief } from '@/lib/research/run-brief';
import { logApiError } from '@/lib/debug-log';

export const dynamic = 'force-dynamic';

/**
 * POST /api/briefs/[id]/run
 *
 * Kicks the brief orchestrator and returns immediately. Brief progress
 * comes through SSE (brief_started / brief_progress / brief_completed /
 * brief_failed) — clients should subscribe before POSTing.
 */
export async function POST(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const result = await runBrief(id);
    if (result.state === 'rejected') {
      const status = result.reason === 'brief_not_found' ? 404 : 409;
      return NextResponse.json({ error: result.reason }, { status });
    }
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    logApiError({ route: '/api/briefs/[id]/run', method: 'POST', status: 500, error });
    const msg = error instanceof Error ? error.message : 'Failed to run brief';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
