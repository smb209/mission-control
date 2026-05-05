/**
 * recurring_jobs DAO.
 *
 * Schema added in migration 067. Wired into the scheduler in
 * src/lib/agents/recurring-scheduler.ts. Heartbeat coordinator
 * (Phase E2) auto-creates rows here when a task's coordinator_mode
 * resolves to 'heartbeat'. See specs/scope-keyed-sessions.md §4.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';

export type AttemptStrategy = 'reuse' | 'fresh';
export type JobStatus = 'active' | 'paused' | 'done';

export interface RecurringJob {
  id: string;
  workspace_id: string;
  name: string;
  role: string;
  scope_key_template: string;
  briefing_template: string;
  initiative_id: string | null;
  task_id: string | null;
  cadence_seconds: number;
  attempt_strategy: AttemptStrategy;
  status: JobStatus;
  last_run_at: string | null;
  last_run_scope_key: string | null;
  next_run_at: string;
  consecutive_failures: number;
  run_count: number;
  created_at: string;
  created_by_agent_id: string | null;
  /**
   * Phase-2 research binding (migration 077). When set, this row is a
   * research schedule and the scheduler dispatches via run-brief
   * instead of dispatchScope.
   */
  topic_id: string | null;
  brief_template: string | null;
}

export class RecurringJobValidationError extends Error {
  constructor(public reason: string) {
    super(`recurring_job validation: ${reason}`);
    this.name = 'RecurringJobValidationError';
  }
}

export interface CreateRecurringJobInput {
  workspace_id: string;
  name: string;
  role: string;
  scope_key_template: string;
  briefing_template: string;
  cadence_seconds: number;
  attempt_strategy?: AttemptStrategy;
  initiative_id?: string | null;
  task_id?: string | null;
  /** ISO datetime; defaults to now (fires immediately on first sweep). */
  first_run_at?: string;
  created_by_agent_id?: string | null;
  /**
   * Phase-2 research binding. Set both `topic_id` and `brief_template`
   * to make this a research schedule. The scheduler will dispatch via
   * run-brief; `scope_key_template` is unused in that path but the
   * column remains NOT NULL, so callers can pass any placeholder
   * (`createResearchSchedule` below fills one in for them).
   */
  topic_id?: string | null;
  brief_template?: string | null;
}

export function createRecurringJob(input: CreateRecurringJobInput): RecurringJob {
  if (input.cadence_seconds <= 0) {
    throw new RecurringJobValidationError('cadence_seconds must be > 0');
  }
  if (!input.name.trim()) {
    throw new RecurringJobValidationError('name is required');
  }
  if (!input.role.trim()) {
    throw new RecurringJobValidationError('role is required');
  }
  if (!input.scope_key_template.includes('{job_id}') && !input.scope_key_template.includes('{wsid}')) {
    throw new RecurringJobValidationError(
      'scope_key_template must include {job_id} or {wsid} substitution',
    );
  }
  if (!input.briefing_template.trim()) {
    throw new RecurringJobValidationError('briefing_template is required');
  }
  // Research binding: both fields go together or neither.
  if ((input.topic_id == null) !== (input.brief_template == null)) {
    throw new RecurringJobValidationError(
      'topic_id and brief_template must be set together or both omitted',
    );
  }

  const id = uuidv4();
  const nextRun = input.first_run_at ?? new Date().toISOString();

  run(
    `INSERT INTO recurring_jobs (
       id, workspace_id, name, role, scope_key_template, briefing_template,
       initiative_id, task_id, cadence_seconds, attempt_strategy,
       status, last_run_at, last_run_scope_key, next_run_at,
       consecutive_failures, run_count, created_at, created_by_agent_id,
       topic_id, brief_template
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?, 0, 0, datetime('now'), ?, ?, ?)`,
    [
      id,
      input.workspace_id,
      input.name,
      input.role,
      input.scope_key_template,
      input.briefing_template,
      input.initiative_id ?? null,
      input.task_id ?? null,
      input.cadence_seconds,
      input.attempt_strategy ?? 'reuse',
      nextRun,
      input.created_by_agent_id ?? null,
      input.topic_id ?? null,
      input.brief_template ?? null,
    ],
  );

  const row = queryOne<RecurringJob>(`SELECT * FROM recurring_jobs WHERE id = ?`, [id]);
  if (!row) throw new Error('createRecurringJob: insert succeeded but row missing');
  return row;
}

export function getRecurringJob(id: string): RecurringJob | null {
  return queryOne<RecurringJob>(`SELECT * FROM recurring_jobs WHERE id = ?`, [id]) ?? null;
}

export function listForWorkspace(workspaceId: string, opts: { status?: JobStatus } = {}): RecurringJob[] {
  if (opts.status) {
    return queryAll<RecurringJob>(
      `SELECT * FROM recurring_jobs WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC`,
      [workspaceId, opts.status],
    );
  }
  return queryAll<RecurringJob>(
    `SELECT * FROM recurring_jobs WHERE workspace_id = ? ORDER BY created_at DESC`,
    [workspaceId],
  );
}

export function listForTask(taskId: string): RecurringJob[] {
  return queryAll<RecurringJob>(
    `SELECT * FROM recurring_jobs WHERE task_id = ? ORDER BY created_at DESC`,
    [taskId],
  );
}

/**
 * Research phase 2: list every recurring research schedule (topic_id
 * IS NOT NULL) for a topic, newest first.
 */
export function listResearchSchedulesForTopic(topicId: string): RecurringJob[] {
  return queryAll<RecurringJob>(
    `SELECT * FROM recurring_jobs WHERE topic_id = ? ORDER BY created_at DESC`,
    [topicId],
  );
}

/**
 * Research phase 2: the next ~N due research schedules in a workspace
 * (active + topic-bound), ordered by next_run_at ASC. Drives the
 * "Upcoming" lane on /research.
 */
export function listUpcomingResearch(workspaceId: string, limit = 10): RecurringJob[] {
  const cap = Math.min(Math.max(limit, 1), 100);
  return queryAll<RecurringJob>(
    `SELECT * FROM recurring_jobs
       WHERE workspace_id = ?
         AND topic_id IS NOT NULL
         AND status = 'active'
       ORDER BY next_run_at ASC
       LIMIT ${cap}`,
    [workspaceId],
  );
}

export interface CreateResearchScheduleInput {
  workspace_id: string;
  topic_id: string;
  brief_template: string;
  cadence_seconds: number;
  /** Defaults to a topic+template-derived label if omitted. */
  name?: string;
  /**
   * Defaults to `now() + cadence_seconds` (wait one full cadence on
   * first run). Pass an earlier ISO timestamp to fire sooner; the
   * `run-now` endpoint sets this to `now()` to dispatch on the next
   * sweep. See build-plan §3.3.
   */
  first_run_at?: string;
  created_by_agent_id?: string | null;
}

/**
 * Convenience constructor for research schedules. Fills in the
 * NOT-NULL columns (`scope_key_template`, `briefing_template`) that
 * the run-brief dispatch path doesn't actually use, then delegates to
 * `createRecurringJob`.
 */
export function createResearchSchedule(input: CreateResearchScheduleInput): RecurringJob {
  const firstRun = input.first_run_at ?? new Date(Date.now() + input.cadence_seconds * 1000).toISOString();
  return createRecurringJob({
    workspace_id: input.workspace_id,
    name: input.name ?? `research:${input.topic_id}:${input.brief_template}`,
    role: 'researcher',
    // Placeholder — the research dispatch path ignores it but the
    // column is NOT NULL with the {job_id}/{wsid} validator.
    scope_key_template: 'research-brief-{job_id}',
    briefing_template: 'researcher',
    cadence_seconds: input.cadence_seconds,
    first_run_at: firstRun,
    created_by_agent_id: input.created_by_agent_id ?? null,
    topic_id: input.topic_id,
    brief_template: input.brief_template,
  });
}

/**
 * Pick jobs whose next_run_at has elapsed and that are still active.
 * Capped at `limit` so a backlog doesn't stall a sweep tick.
 */
export function listDueJobs(opts: { now?: string; limit?: number } = {}): RecurringJob[] {
  const now = opts.now ?? new Date().toISOString();
  const limit = Math.min(opts.limit ?? 50, 200);
  return queryAll<RecurringJob>(
    `SELECT * FROM recurring_jobs
       WHERE status = 'active' AND next_run_at <= ?
       ORDER BY next_run_at ASC
       LIMIT ${limit}`,
    [now],
  );
}

/**
 * Reserve a job for an in-flight dispatch. Advances `next_run_at` by
 * one full cadence immediately so that:
 *   - a slow brief (longer than the sweep interval) can't be re-picked
 *     by an overlapping sweep tick, and
 *   - a server restart mid-brief doesn't see the row as "due" again
 *     (the orphaned brief surfaces via its own brief_failed signal,
 *     not via the scheduler re-firing).
 *
 * Returns the updated row. Does NOT bump run_count or touch
 * last_run_at — that happens on terminal success/failure.
 */
export function markRunInFlight(id: string): RecurringJob | null {
  const job = getRecurringJob(id);
  if (!job) return null;
  const next = new Date(Date.now() + job.cadence_seconds * 1000).toISOString();
  run(`UPDATE recurring_jobs SET next_run_at = ? WHERE id = ?`, [next, id]);
  return getRecurringJob(id);
}

/**
 * Mark a successful run. Bumps run_count, clears consecutive_failures,
 * advances next_run_at by cadence_seconds, records the scope_key
 * actually used.
 */
export function markRunSuccess(id: string, scopeKey: string): RecurringJob | null {
  const job = getRecurringJob(id);
  if (!job) return null;
  const cadenceMs = job.cadence_seconds * 1000;
  const now = Date.now();
  const next = new Date(now + cadenceMs).toISOString();
  // ISO with `Z` so client-side Date.parse() reads as UTC. Bare
  // SQLite `datetime('now')` would produce a tz-naïve string that
  // browsers parse as local time, drifting last_run_at by the user's
  // TZ offset on the rail / topic page.
  run(
    `UPDATE recurring_jobs
        SET last_run_at = ?,
            last_run_scope_key = ?,
            next_run_at = ?,
            consecutive_failures = 0,
            run_count = run_count + 1
      WHERE id = ?`,
    [new Date(now).toISOString(), scopeKey, next, id],
  );
  return getRecurringJob(id);
}

/**
 * Mark a failed run. Increments consecutive_failures; pauses the job
 * after the threshold (default 3). Advances next_run_at to a backoff
 * window so failures don't hammer the gateway.
 */
export function markRunFailure(id: string, opts: { pauseThreshold?: number; backoffSeconds?: number } = {}): RecurringJob | null {
  const job = getRecurringJob(id);
  if (!job) return null;
  const newFailures = job.consecutive_failures + 1;
  const threshold = opts.pauseThreshold ?? 3;
  const backoff = opts.backoffSeconds ?? Math.min(job.cadence_seconds, 600);
  const nextStatus: JobStatus = newFailures >= threshold ? 'paused' : job.status;
  const nextRun = new Date(Date.now() + backoff * 1000).toISOString();
  // ISO with `Z` for last_run_at — see markRunSuccess.
  run(
    `UPDATE recurring_jobs
        SET consecutive_failures = ?,
            status = ?,
            next_run_at = ?,
            last_run_at = ?
      WHERE id = ?`,
    [newFailures, nextStatus, nextRun, new Date().toISOString(), id],
  );
  return getRecurringJob(id);
}

export function setJobStatus(id: string, status: JobStatus): RecurringJob | null {
  // Resuming from paused: clear consecutive_failures and bring next_run_at
  // forward so the resumed job picks up on the next sweep.
  const current = getRecurringJob(id);
  if (!current) return null;
  if (current.status === 'paused' && status === 'active') {
    // Use ISO 8601 with `Z` so JS Date.parse() reads it as UTC. The
    // bare `datetime('now')` SQLite literal omits the timezone marker
    // and gets parsed as local time, drifting next_run_at by the
    // browser's TZ offset on the rail / topic page.
    run(
      `UPDATE recurring_jobs
          SET status = 'active', consecutive_failures = 0, next_run_at = ?
        WHERE id = ?`,
      [new Date().toISOString(), id],
    );
  } else {
    run(`UPDATE recurring_jobs SET status = ? WHERE id = ?`, [status, id]);
  }
  return getRecurringJob(id);
}

/**
 * Adjust cadence on an existing job. Re-anchors `next_run_at` so the
 * new cadence takes effect from `last_run_at` (or `now()` if never
 * run). Throws on invalid input.
 */
export function setJobCadence(id: string, cadenceSeconds: number): RecurringJob | null {
  if (cadenceSeconds <= 0) {
    throw new RecurringJobValidationError('cadence_seconds must be > 0');
  }
  const current = getRecurringJob(id);
  if (!current) return null;
  const anchorMs = current.last_run_at ? Date.parse(current.last_run_at) : Date.now();
  const next = new Date(anchorMs + cadenceSeconds * 1000).toISOString();
  run(
    `UPDATE recurring_jobs SET cadence_seconds = ?, next_run_at = ? WHERE id = ?`,
    [cadenceSeconds, next, id],
  );
  return getRecurringJob(id);
}

/**
 * Force the job to run on the next sweep — used by the "Run now"
 * affordance. Leaves cadence_seconds + last_run_at intact so the
 * post-success cadence advancement works as usual.
 */
export function setJobRunNow(id: string): RecurringJob | null {
  // ISO with `Z` so client-side Date.parse() reads it as UTC; bare
  // SQLite `datetime('now')` is naive and ends up local-time-shifted.
  run(`UPDATE recurring_jobs SET next_run_at = ? WHERE id = ?`, [new Date().toISOString(), id]);
  return getRecurringJob(id);
}

export function deleteRecurringJob(id: string): boolean {
  const row = getRecurringJob(id);
  if (!row) return false;
  run(`DELETE FROM recurring_jobs WHERE id = ?`, [id]);
  return true;
}

/**
 * Pause every active research schedule belonging to a topic. Called
 * when a topic is archived so the scheduler stops dispatching against
 * the now-hidden topic. Returns the number of rows paused.
 */
export function pauseSchedulesForTopic(topicId: string): number {
  const result = run(
    `UPDATE recurring_jobs
        SET status = 'paused'
      WHERE topic_id = ? AND status = 'active'`,
    [topicId],
  );
  return result.changes ?? 0;
}

export interface BriefOutcomeUpdate {
  job_id: string;
  status: JobStatus;
  consecutive_failures: number;
}

/**
 * Record the async outcome of a brief produced by a research
 * schedule. Resolves the schedule via `agent_runs.source_kind` +
 * `agent_runs.source_ref`, then:
 *   - on 'completed' clears consecutive_failures (a successful run
 *     after a failure streak resets the counter so a transient
 *     blip doesn't pause an otherwise-healthy schedule).
 *   - on 'failed' bumps consecutive_failures, pauses the row when
 *     it reaches `pauseThreshold` (default 3, matching the synchronous
 *     dispatch-time path).
 *
 * Does NOT touch `next_run_at`: the dispatch path already advanced
 * it by `cadence_seconds` to prevent concurrent runs while the brief
 * was in flight. Returns null if the agent_run isn't schedule-bound
 * or the schedule no longer exists (deleted while in flight).
 */
export function recordBriefOutcome(
  agentRunId: string,
  outcome: 'completed' | 'failed',
  opts: { pauseThreshold?: number } = {},
): BriefOutcomeUpdate | null {
  const sched = queryOne<{ id: string; status: JobStatus; consecutive_failures: number }>(
    `SELECT rj.id, rj.status, rj.consecutive_failures
       FROM recurring_jobs rj
       JOIN agent_runs ar ON ar.source_ref = rj.id
      WHERE ar.id = ? AND ar.source_kind = 'schedule'
      LIMIT 1`,
    [agentRunId],
  );
  if (!sched) return null;

  if (outcome === 'completed') {
    if (sched.consecutive_failures > 0) {
      run(
        `UPDATE recurring_jobs SET consecutive_failures = 0 WHERE id = ?`,
        [sched.id],
      );
    }
    return {
      job_id: sched.id,
      status: sched.status,
      consecutive_failures: 0,
    };
  }

  // outcome === 'failed'
  const newFailures = sched.consecutive_failures + 1;
  const threshold = opts.pauseThreshold ?? 3;
  const nextStatus: JobStatus =
    newFailures >= threshold && sched.status === 'active' ? 'paused' : sched.status;
  run(
    `UPDATE recurring_jobs
        SET consecutive_failures = ?,
            status = ?
      WHERE id = ?`,
    [newFailures, nextStatus, sched.id],
  );
  return {
    job_id: sched.id,
    status: nextStatus,
    consecutive_failures: newFailures,
  };
}

/**
 * Render a scope_key_template by substituting `{wsid}`, `{job_id}`,
 * and `{run_n}` placeholders. Defaults to the job's actual values.
 */
export function renderScopeKey(job: RecurringJob, opts: { run_n?: number } = {}): string {
  const runN = opts.run_n ?? job.run_count + 1;
  return job.scope_key_template
    .replace(/\{wsid\}/g, job.workspace_id)
    .replace(/\{job_id\}/g, job.id)
    .replace(/\{run_n\}/g, String(runN));
}
