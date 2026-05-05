/**
 * recurring_jobs scheduler.
 *
 * Wakes every SWEEP_INTERVAL_MS (default 60s), picks jobs whose
 * next_run_at has elapsed, and dispatches each via dispatchScope.
 * On success: bump run_count + advance next_run_at. On failure:
 * increment consecutive_failures + backoff; pause after 3.
 *
 * Phase E1 of specs/scope-keyed-sessions.md §4.2.
 */

import {
  createNote,
} from '@/lib/db/agent-notes';
import {
  listDueJobs,
  markRunFailure,
  markRunSuccess,
  renderScopeKey,
  type RecurringJob,
} from '@/lib/db/recurring-jobs';
import { createBriefWithRun, type BriefTemplate } from '@/lib/db/briefs';
import { queryOne } from '@/lib/db';
import { runBrief } from '@/lib/research/run-brief';
import { dispatchScope } from './dispatch-scope';
import { getRunnerAgent } from './runner';
import type { BriefingRole } from './briefing';

const SWEEP_INTERVAL_MS = 60_000;
const PAUSE_THRESHOLD = 3;

let timer: NodeJS.Timeout | null = null;

function isBriefingRole(role: string): role is BriefingRole {
  return (
    role === 'pm' ||
    role === 'coordinator' ||
    role === 'builder' ||
    role === 'researcher' ||
    role === 'tester' ||
    role === 'reviewer' ||
    role === 'writer' ||
    role === 'learner'
  );
}

/**
 * Phase 2 research schedules. When a recurring_jobs row has `topic_id`
 * set, the dispatch flow uses the topic + brief_template to spin up a
 * fresh brief row and call `runBrief` (the same orchestrator the
 * /api/briefs POST path uses). The scope-keyed `dispatchScope` path
 * is bypassed entirely — research dispatches are brief-shaped, not
 * task-shaped.
 *
 * On rejected start (topic missing/archived, runner missing,
 * researcher missing) we mark the run failed so the auto-pause logic
 * applies after `PAUSE_THRESHOLD` consecutive failures. On a started
 * dispatch we mark the run successful — the brief itself surfaces
 * its own outcome via `brief_completed` / `brief_failed` SSE events.
 */
async function dispatchResearchScheduleOnce(job: RecurringJob): Promise<void> {
  if (!job.topic_id || !job.brief_template) {
    // Defensive: caller already gated on these.
    return;
  }

  const topic = queryOne<{ id: string; name: string; description: string; archived_at: string | null }>(
    `SELECT id, name, description, archived_at FROM topics WHERE id = ?`,
    [job.topic_id],
  );
  if (!topic) {
    failResearchSchedule(job, 'topic missing');
    return;
  }
  if (topic.archived_at) {
    failResearchSchedule(job, 'topic archived');
    return;
  }

  // Preflight: matches the API's createBriefWithRun + runBrief flow.
  // Quick checks here let us mark a clean fail-and-pause without
  // creating an orphan brief row.
  const researcher = queryOne<{ id: string }>(
    `SELECT id FROM agents WHERE workspace_id = ? AND role = 'researcher' AND COALESCE(is_active, 1) = 1 LIMIT 1`,
    [job.workspace_id],
  );
  if (!researcher) {
    failResearchSchedule(job, 'no researcher in workspace roster');
    return;
  }
  const runner = getRunnerAgent();
  if (!runner) {
    failResearchSchedule(job, 'no runner agent registered');
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const title = `${topic.name} · ${today}`;
  // The brief's prompt is the topic description by default. If the
  // operator left description empty, a minimal directive keeps the
  // researcher productive.
  const prompt = topic.description.trim()
    ? topic.description
    : `Survey "${topic.name}" and produce a research brief.`;

  let result: { brief_id: string; agent_run_id: string; state: 'started' | 'rejected'; reason?: string };
  try {
    const created = createBriefWithRun({
      workspace_id: job.workspace_id,
      template: job.brief_template as BriefTemplate,
      title,
      prompt,
      topic_id: job.topic_id,
      requested_by: 'schedule',
      source_kind: 'schedule',
      source_ref: job.id,
    });
    result = await runBrief(created.brief.id);
  } catch (err) {
    failResearchSchedule(job, `brief create/run threw: ${(err as Error).message}`);
    return;
  }

  if (result.state === 'rejected') {
    failResearchSchedule(job, `runBrief rejected: ${result.reason ?? 'unknown'}`);
    return;
  }

  markRunSuccess(job.id, `research-brief-${result.brief_id}`);
}

function failResearchSchedule(job: RecurringJob, reason: string): void {
  console.warn(`[recurring/research] job ${job.id}: ${reason}`);
  const next = markRunFailure(job.id, { pauseThreshold: PAUSE_THRESHOLD });
  if (next?.status === 'paused') {
    try {
      createNote({
        workspace_id: job.workspace_id,
        agent_id: null,
        task_id: null,
        initiative_id: null,
        scope_key: 'mc:recurring-scheduler',
        role: 'system',
        run_group_id: `recurring-pause-${job.id}`,
        kind: 'blocker',
        audience: 'pm',
        body:
          `Recurring research schedule "${job.name}" auto-paused after ` +
          `${PAUSE_THRESHOLD} consecutive failures. Last reason: ${reason}.`,
        importance: 2,
      });
    } catch (noteErr) {
      console.warn(
        `[recurring/research] failed to write pause note for job ${job.id}:`,
        (noteErr as Error).message,
      );
    }
  }
}

export async function dispatchRecurringJobOnce(job: RecurringJob): Promise<void> {
  // Phase 2: research-bound rows take a different dispatch path.
  if (job.topic_id) {
    await dispatchResearchScheduleOnce(job);
    return;
  }

  const runner = getRunnerAgent();
  if (!runner) {
    console.warn(`[recurring] job ${job.id}: no runner agent registered; skipping`);
    return;
  }
  if (!isBriefingRole(job.role)) {
    console.warn(`[recurring] job ${job.id}: invalid role "${job.role}"; pausing`);
    markRunFailure(job.id, { pauseThreshold: 1 });
    return;
  }

  const sessionSuffix = renderScopeKey(job)
    .replace(`${(runner as { session_key_prefix?: string | null }).session_key_prefix ?? ''}:`, '');
  // If the template doesn't include the runner prefix, use the entire
  // rendered key as the suffix; dispatchScope then prepends the prefix
  // automatically. We strip-once-if-present to avoid double-prefixing
  // when templates are written like `agent:mc-runner-dev:main:recurring-{job_id}`.

  try {
    const result = await dispatchScope({
      workspace_id: job.workspace_id,
      role: job.role,
      agent: runner,
      session_suffix: sessionSuffix,
      trigger_body: job.briefing_template,
      scope_type: 'recurring',
      task_id: job.task_id ?? null,
      initiative_id: job.initiative_id ?? null,
      attempt_strategy: job.attempt_strategy,
      // Best effort — recurring jobs don't await reply; fire and let the
      // SSE stream surface the agent's notes / proposals as they land.
      timeoutMs: 30_000,
      idempotencyKey: `recurring-${job.id}-${job.run_count + 1}`,
    });
    markRunSuccess(job.id, result.scope_key);
  } catch (err) {
    console.warn(`[recurring] job ${job.id} dispatch failed:`, (err as Error).message);
    const next = markRunFailure(job.id, { pauseThreshold: PAUSE_THRESHOLD });
    if (next?.status === 'paused') {
      // High-importance note so the operator notices the auto-pause.
      try {
        createNote({
          workspace_id: job.workspace_id,
          agent_id: null,
          task_id: job.task_id ?? null,
          initiative_id: job.initiative_id ?? null,
          scope_key: 'mc:recurring-scheduler',
          role: 'system',
          run_group_id: `recurring-pause-${job.id}`,
          kind: 'blocker',
          audience: 'pm',
          body:
            `Recurring job "${job.name}" auto-paused after ${PAUSE_THRESHOLD} consecutive ` +
            `failures. Last error: ${(err as Error).message ?? 'unknown'}.`,
          importance: 2,
        });
      } catch (noteErr) {
        console.warn(
          `[recurring] failed to write pause note for job ${job.id}:`,
          (noteErr as Error).message,
        );
      }
    }
  }
}

async function sweep(): Promise<void> {
  let due: RecurringJob[];
  try {
    due = listDueJobs();
  } catch (err) {
    console.error('[recurring] listDueJobs failed:', (err as Error).message);
    return;
  }
  if (due.length === 0) return;
  for (const job of due) {
    void dispatchRecurringJobOnce(job).catch((err) => {
      console.error(`[recurring] job ${job.id} unhandled error:`, err);
    });
  }
}

/**
 * Idempotent. Hooks the scheduler into the Node process. Safe to call
 * multiple times (the timer is stored in globalThis so HMR / hot
 * reloads in dev don't pile up timers).
 */
export function ensureRecurringSchedulerStarted(): void {
  const g = globalThis as unknown as { __mcRecurringSchedulerTimer?: NodeJS.Timeout };
  if (g.__mcRecurringSchedulerTimer || timer) return;
  timer = setInterval(() => {
    void sweep().catch((err) => console.error('[recurring] sweep error:', err));
  }, SWEEP_INTERVAL_MS);
  g.__mcRecurringSchedulerTimer = timer;
  // Don't fire immediately on startup — give the gateway a chance to
  // connect first. Workspaces with `next_run_at` already in the past
  // will still pick up on the first interval tick.
}

/** Test seam — stop the scheduler so tests don't leak timers. */
export function __stopRecurringSchedulerForTests(): void {
  const g = globalThis as unknown as { __mcRecurringSchedulerTimer?: NodeJS.Timeout };
  if (g.__mcRecurringSchedulerTimer) {
    clearInterval(g.__mcRecurringSchedulerTimer);
    g.__mcRecurringSchedulerTimer = undefined;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
