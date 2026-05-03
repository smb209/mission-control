/**
 * /api/recurring-jobs/[id]
 *
 * GET    — single job.
 * PATCH  — { status: 'active' | 'paused' | 'done' } to pause/resume/complete.
 * DELETE — drop the row entirely. Cascades nothing (table has no
 *          dependents); operator-driven cleanup only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { run } from '@/lib/db';
import {
  getRecurringJob,
  setJobStatus,
  type JobStatus,
} from '@/lib/db/recurring-jobs';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;
  const job = getRecurringJob(id);
  if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json(job);
}

export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;
  const job = getRecurringJob(id);
  if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const status = body.status;
  if (status !== 'active' && status !== 'paused' && status !== 'done') {
    return NextResponse.json(
      { error: 'invalid status; must be active|paused|done' },
      { status: 400 },
    );
  }
  const updated = setJobStatus(id, status as JobStatus);
  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, { params }: RouteParams): Promise<NextResponse> {
  const { id } = await params;
  const job = getRecurringJob(id);
  if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  run(`DELETE FROM recurring_jobs WHERE id = ?`, [id]);
  return NextResponse.json({ deleted: id });
}
