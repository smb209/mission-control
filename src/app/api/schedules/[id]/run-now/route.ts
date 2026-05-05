/**
 * Force a schedule to fire on the next sweep.
 *
 *  POST /api/schedules/[id]/run-now
 *
 * Sets `next_run_at = now()` so the recurring sweep picks it up
 * within `SWEEP_INTERVAL_MS` (60s default). Cadence + last_run_at are
 * untouched, so the post-success advancement still works as usual.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getRecurringJob,
  setJobRunNow,
} from '@/lib/db/recurring-jobs';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const job = getRecurringJob(id);
  if (!job) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
  if (job.status === 'paused') {
    return NextResponse.json(
      { error: 'Schedule is paused; resume it before running on demand' },
      { status: 400 },
    );
  }
  const updated = setJobRunNow(id);
  return NextResponse.json(updated);
}
