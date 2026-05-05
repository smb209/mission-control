/**
 * Schedules attached to a topic.
 *
 *  GET  /api/topics/[id]/schedules — list all schedules (any status).
 *  POST /api/topics/[id]/schedules — create a research schedule.
 *
 * Schedules live on the shared `recurring_jobs` table; topic-scoped
 * helpers in `recurring-jobs.ts` filter to research rows. See
 * specs/research-phase-2-schedules-build-plan.md §3.1.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getTopic } from '@/lib/db/topics';
import {
  createResearchSchedule,
  listResearchSchedulesForTopic,
  RecurringJobValidationError,
} from '@/lib/db/recurring-jobs';

export const dynamic = 'force-dynamic';

// Brief templates legal in phase 2. Widening this also requires the
// `briefs.template` CHECK constraint in migration 075.
const ALLOWED_TEMPLATES = ['general_brief'] as const;

const CreateScheduleSchema = z.object({
  brief_template: z.enum(ALLOWED_TEMPLATES).default('general_brief'),
  cadence_seconds: z.number().int().positive().max(60 * 60 * 24 * 365),
  /** Override default name; omit for auto-generated. */
  name: z.string().min(1).max(200).optional(),
  /** ISO datetime; omit to wait one cadence (default per build-plan §3.3). */
  first_run_at: z.string().datetime().optional(),
});

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const topic = getTopic(id);
  if (!topic) return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
  const schedules = listResearchSchedulesForTopic(id);
  return NextResponse.json(schedules);
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const topic = getTopic(id);
  if (!topic) return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
  if (topic.archived_at) {
    return NextResponse.json(
      { error: 'Cannot create a schedule on an archived topic' },
      { status: 400 },
    );
  }
  try {
    const body = await request.json();
    const parsed = CreateScheduleSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    const created = createResearchSchedule({
      workspace_id: topic.workspace_id,
      topic_id: id,
      brief_template: parsed.data.brief_template,
      cadence_seconds: parsed.data.cadence_seconds,
      name: parsed.data.name,
      first_run_at: parsed.data.first_run_at,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof RecurringJobValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Failed to create schedule:', error);
    const msg = error instanceof Error ? error.message : 'Failed to create schedule';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
