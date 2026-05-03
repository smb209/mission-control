/**
 * /api/recurring-jobs
 *
 * GET ?workspace_id=… — list jobs for a workspace.
 * POST                — create a new recurring job.
 *
 * Pause / resume / done go through /api/recurring-jobs/[id] PATCH.
 *
 * See specs/scope-keyed-sessions.md §4.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createRecurringJob,
  listForWorkspace,
  RecurringJobValidationError,
  type AttemptStrategy,
  type JobStatus,
} from '@/lib/db/recurring-jobs';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const workspaceId = searchParams.get('workspace_id');
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  }
  const statusRaw = searchParams.get('status');
  const status: JobStatus | undefined =
    statusRaw === 'active' || statusRaw === 'paused' || statusRaw === 'done'
      ? statusRaw
      : undefined;
  const jobs = listForWorkspace(workspaceId, { status });
  return NextResponse.json({ count: jobs.length, jobs });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  try {
    const job = createRecurringJob({
      workspace_id: String(body.workspace_id ?? ''),
      name: String(body.name ?? ''),
      role: String(body.role ?? ''),
      scope_key_template: String(body.scope_key_template ?? ''),
      briefing_template: String(body.briefing_template ?? ''),
      cadence_seconds: Number(body.cadence_seconds ?? 0),
      attempt_strategy: (body.attempt_strategy as AttemptStrategy | undefined) ?? 'reuse',
      initiative_id: typeof body.initiative_id === 'string' ? body.initiative_id : null,
      task_id: typeof body.task_id === 'string' ? body.task_id : null,
      first_run_at: typeof body.first_run_at === 'string' ? body.first_run_at : undefined,
      created_by_agent_id:
        typeof body.created_by_agent_id === 'string' ? body.created_by_agent_id : null,
    });
    return NextResponse.json(job, { status: 201 });
  } catch (err) {
    if (err instanceof RecurringJobValidationError) {
      return NextResponse.json({ error: 'validation', message: err.message }, { status: 400 });
    }
    console.error('[recurring-jobs] POST error:', err);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
