/**
 * Per-schedule operations.
 *
 *  GET    /api/schedules/[id]
 *  PATCH  /api/schedules/[id]   { cadence_seconds?, status? }
 *  DELETE /api/schedules/[id]
 *
 * Status transitions: 'active' ↔ 'paused'. Resuming clears
 * consecutive_failures and bumps next_run_at to now (per
 * `setJobStatus` in the DAO).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  deleteRecurringJob,
  getRecurringJob,
  RecurringJobValidationError,
  setJobCadence,
  setJobStatus,
} from '@/lib/db/recurring-jobs';

export const dynamic = 'force-dynamic';

const PatchSchema = z.object({
  cadence_seconds: z.number().int().positive().max(60 * 60 * 24 * 365).optional(),
  status: z.enum(['active', 'paused']).optional(),
});

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const job = getRecurringJob(id);
  if (!job) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
  return NextResponse.json(job);
}

export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const job = getRecurringJob(id);
  if (!job) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
  try {
    const body = await request.json();
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    let updated = job;
    if (parsed.data.cadence_seconds !== undefined) {
      const next = setJobCadence(id, parsed.data.cadence_seconds);
      if (next) updated = next;
    }
    if (parsed.data.status !== undefined) {
      const next = setJobStatus(id, parsed.data.status);
      if (next) updated = next;
    }
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof RecurringJobValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Failed to update schedule:', error);
    const msg = error instanceof Error ? error.message : 'Failed to update schedule';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const ok = deleteRecurringJob(id);
  if (!ok) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
  return new NextResponse(null, { status: 204 });
}
