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

  const id = uuidv4();
  const nextRun = input.first_run_at ?? new Date().toISOString();

  run(
    `INSERT INTO recurring_jobs (
       id, workspace_id, name, role, scope_key_template, briefing_template,
       initiative_id, task_id, cadence_seconds, attempt_strategy,
       status, last_run_at, last_run_scope_key, next_run_at,
       consecutive_failures, run_count, created_at, created_by_agent_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?, 0, 0, datetime('now'), ?)`,
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
  run(
    `UPDATE recurring_jobs
        SET last_run_at = datetime('now'),
            last_run_scope_key = ?,
            next_run_at = ?,
            consecutive_failures = 0,
            run_count = run_count + 1
      WHERE id = ?`,
    [scopeKey, next, id],
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
  run(
    `UPDATE recurring_jobs
        SET consecutive_failures = ?,
            status = ?,
            next_run_at = ?,
            last_run_at = datetime('now')
      WHERE id = ?`,
    [newFailures, nextStatus, nextRun, id],
  );
  return getRecurringJob(id);
}

export function setJobStatus(id: string, status: JobStatus): RecurringJob | null {
  run(`UPDATE recurring_jobs SET status = ? WHERE id = ?`, [status, id]);
  return getRecurringJob(id);
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
