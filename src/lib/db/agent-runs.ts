/**
 * agent_runs DAO.
 *
 * Schema added in migration 075. The shared dispatch envelope for
 * non-task agent work; per-kind domain tables (briefs first;
 * sweeps/readiness_checks/comms_drafts/workflow_node_runs later) link
 * via agent_run_id. See docs/archive/research-area-build-plan.md §2.2.
 *
 * Lifecycle: queued → running → (complete | failed | cancelled).
 * Each transition stamps started_at / completed_at / updated_at as
 * appropriate. Per-kind output (result_md, citations_json, etc.)
 * lives on the per-kind row, not here.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run, transaction } from '@/lib/db';

export type AgentRunKind =
  | 'brief'
  | 'pm_chat'
  | 'plan'
  | 'decompose'
  | 'initiative_audit'
  | 'recurring'
  | 'task_coord'
  | 'task_role';
export type AgentRunStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
export type AgentRunSourceKind = 'manual' | 'schedule' | 'event' | 'fanout';

import type { ScopeType } from '@/lib/db/mc-sessions';

export interface AgentRun {
  id: string;
  workspace_id: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  source_kind: AgentRunSourceKind;
  source_ref: string | null;
  scope_key: string | null;
  scope_type: string | null;
  role: string | null;
  agent_id: string | null;
  initiative_id: string | null;
  task_id: string | null;
  parent_run_id: string | null;
  label: string | null;
  openclaw_session_id: string | null;
  model_used: string | null;
  cost_cents: number | null;
  cost_ceiling_cents: number | null;
  error_md: string | null;
  /** Briefing/trigger body sent to the agent at dispatch (PR 5).
   *  Nullable because rows pre-migration-081 don't have it. */
  trigger_body: string | null;
  /** When kind='pm_chat' AND the dispatch was kicked by a pm_proposals
   *  row, this points at that proposal so the cancel cascade can flip
   *  it to `synth_only` (PR 5). */
  pm_proposal_id: string | null;
  /** UUID minted by dispatch-scope; matches the `run_group_id` baked
   *  into the agent's briefing and tagged on every `agent_notes` row
   *  this run produces. Nullable for pre-085 rows and brief dispatches
   *  that skip the agent_runs row. */
  run_group_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Pure mapping from `mc_sessions.scope_type` → `agent_runs.kind`.
 * Used by `dispatchScope` so every dispatch gets a row in agent_runs
 * tagged with the right kind for the Jobs-in-Progress UI.
 */
export function scopeTypeToRunKind(scopeType: ScopeType): AgentRunKind {
  switch (scopeType) {
    case 'pm_chat': return 'pm_chat';
    case 'plan': return 'plan';
    case 'decompose': return 'decompose';
    case 'decompose_story': return 'decompose';
    case 'notes_intake': return 'pm_chat';
    case 'task_coord': return 'task_coord';
    case 'task_role': return 'task_role';
    case 'recurring': return 'recurring';
    case 'heartbeat': return 'task_coord';
    case 'initiative_audit': return 'initiative_audit';
    default: {
      // Exhaustiveness check + runtime guard for unknown ScopeType values.
      const _exhaustive: never = scopeType;
      void _exhaustive;
      throw new Error(`scopeTypeToRunKind: unknown scope_type ${scopeType}`);
    }
  }
}

export class AgentRunValidationError extends Error {
  constructor(public reason: string) {
    super(`agent_run validation: ${reason}`);
    this.name = 'AgentRunValidationError';
  }
}

export class AgentRunTransitionError extends Error {
  constructor(public from: AgentRunStatus, public to: AgentRunStatus) {
    super(`agent_run transition not allowed: ${from} → ${to}`);
    this.name = 'AgentRunTransitionError';
  }
}

const ALLOWED_TRANSITIONS: Record<AgentRunStatus, ReadonlyArray<AgentRunStatus>> = {
  queued:    ['running', 'cancelled', 'failed'],
  running:   ['complete', 'failed', 'cancelled'],
  complete:  [],
  failed:    [],
  cancelled: [],
};

export interface CreateAgentRunInput {
  workspace_id: string;
  kind: AgentRunKind;
  source_kind?: AgentRunSourceKind;
  source_ref?: string | null;
  cost_ceiling_cents?: number | null;
}

export function createAgentRun(input: CreateAgentRunInput): AgentRun {
  if (!input.workspace_id.trim()) {
    throw new AgentRunValidationError('workspace_id is required');
  }
  const id = uuidv4();
  run(
    `INSERT INTO agent_runs (
       id, workspace_id, kind, status, source_kind, source_ref,
       cost_ceiling_cents, created_at, updated_at
     ) VALUES (?, ?, ?, 'queued', ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      id,
      input.workspace_id,
      input.kind,
      input.source_kind ?? 'manual',
      input.source_ref ?? null,
      input.cost_ceiling_cents ?? null,
    ],
  );
  const row = queryOne<AgentRun>(`SELECT * FROM agent_runs WHERE id = ?`, [id]);
  if (!row) throw new Error('createAgentRun: insert succeeded but row missing');
  return row;
}

export function getAgentRun(id: string): AgentRun | null {
  return queryOne<AgentRun>(`SELECT * FROM agent_runs WHERE id = ?`, [id]) ?? null;
}

export interface ListAgentRunsOptions {
  kind?: AgentRunKind;
  status?: AgentRunStatus;
  limit?: number;
}

export function listAgentRuns(workspaceId: string, opts: ListAgentRunsOptions = {}): AgentRun[] {
  const where: string[] = ['workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (opts.kind) {
    where.push('kind = ?');
    params.push(opts.kind);
  }
  if (opts.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  const limit = Math.min(opts.limit ?? 100, 500);
  return queryAll<AgentRun>(
    // rowid DESC tiebreaks created_at — see briefs.ts listBriefs.
    `SELECT * FROM agent_runs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`,
    params,
  );
}

function assertTransition(from: AgentRunStatus, to: AgentRunStatus): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new AgentRunTransitionError(from, to);
  }
}

export interface MarkRunningInput {
  openclaw_session_id?: string | null;
  model_used?: string | null;
}

export function markRunning(id: string, input: MarkRunningInput = {}): AgentRun {
  const current = getAgentRun(id);
  if (!current) throw new Error(`markRunning: agent_run ${id} not found`);
  assertTransition(current.status, 'running');
  run(
    `UPDATE agent_runs SET
       status = 'running',
       openclaw_session_id = COALESCE(?, openclaw_session_id),
       model_used = COALESCE(?, model_used),
       started_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ?`,
    [input.openclaw_session_id ?? null, input.model_used ?? null, id],
  );
  return getAgentRun(id)!;
}

export interface MarkCompleteInput {
  cost_cents?: number | null;
}

export function markComplete(id: string, input: MarkCompleteInput = {}): AgentRun {
  const current = getAgentRun(id);
  if (!current) throw new Error(`markComplete: agent_run ${id} not found`);
  assertTransition(current.status, 'complete');
  run(
    `UPDATE agent_runs SET
       status = 'complete',
       cost_cents = COALESCE(?, cost_cents),
       completed_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ?`,
    [input.cost_cents ?? null, id],
  );
  return getAgentRun(id)!;
}

export interface MarkFailedInput {
  error_md: string;
  cost_cents?: number | null;
}

export function markFailed(id: string, input: MarkFailedInput): AgentRun {
  const current = getAgentRun(id);
  if (!current) throw new Error(`markFailed: agent_run ${id} not found`);
  assertTransition(current.status, 'failed');
  run(
    `UPDATE agent_runs SET
       status = 'failed',
       error_md = ?,
       cost_cents = COALESCE(?, cost_cents),
       completed_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ?`,
    [input.error_md, input.cost_cents ?? null, id],
  );
  return getAgentRun(id)!;
}

export function markCancelled(id: string, reasonMd?: string): AgentRun {
  const current = getAgentRun(id);
  if (!current) throw new Error(`markCancelled: agent_run ${id} not found`);
  assertTransition(current.status, 'cancelled');
  run(
    `UPDATE agent_runs SET
       status = 'cancelled',
       error_md = COALESCE(?, error_md),
       completed_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ?`,
    [reasonMd ?? null, id],
  );
  return getAgentRun(id)!;
}

/**
 * Reap stale `running` rows whose started_at is older than `staleSeconds`
 * and mark them failed. The dispatch orchestrator updates `updated_at`
 * on progress events; jobs whose updated_at hasn't moved in that window
 * are presumed dead. Used by the dispatch failure recovery path.
 */
// ─── Jobs-in-Progress helpers (PR 1) ────────────────────────────────
//
// startAgentRun / completeAgentRun / failAgentRun are the high-level
// API used by `dispatchScope` so every dispatch path lands in the
// agent_runs table with the same shape. See specs/jobs-in-progress.md
// §"Single write site".

export interface StartAgentRunInput {
  workspace_id: string;
  kind: AgentRunKind;
  scope_key: string;
  scope_type: ScopeType | string;
  role: string;
  agent_id: string;
  initiative_id?: string | null;
  task_id?: string | null;
  parent_run_id?: string | null;
  source_kind?: AgentRunSourceKind;
  source_ref?: string | null;
  cost_ceiling_cents?: number | null;
  label?: string | null;
  /** Briefing/trigger body sent to the agent (PR 5 — surfaced in the
   *  /jobs drill-down). Optional; existing callers don't set it. */
  trigger_body?: string | null;
  /** Optional pm_proposals.id this dispatch is wired up to. Used by
   *  the cancel cascade to flip `pending_agent` → `synth_only` when
   *  an in-flight PM chat is killed before the agent replies. */
  pm_proposal_id?: string | null;
  /** UUID minted by dispatch-scope and baked into the agent's
   *  briefing. Persisted here so tools (e.g. take_note) can map a
   *  caller's run_group_id back to its agent_runs row and refuse
   *  writes from a worker whose run was already cancelled.
   *  See docs/archive/dedupe-investigations.md. */
  run_group_id?: string | null;
}

/**
 * Insert a new agent_runs row in `running` state and return its id.
 * Skips the queued→running two-step because in practice every caller
 * we have today goes from "decided to dispatch" straight to "sent" with
 * no queue in between.
 */
export function startAgentRun(input: StartAgentRunInput): string {
  if (!input.workspace_id.trim()) {
    throw new AgentRunValidationError('workspace_id is required');
  }
  const id = uuidv4();
  run(
    `INSERT INTO agent_runs (
       id, workspace_id, kind, status, source_kind, source_ref,
       scope_key, scope_type, role, agent_id,
       initiative_id, task_id, parent_run_id, label,
       trigger_body, pm_proposal_id, run_group_id,
       cost_ceiling_cents, started_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`,
    [
      id,
      input.workspace_id,
      input.kind,
      input.source_kind ?? 'manual',
      input.source_ref ?? null,
      input.scope_key,
      input.scope_type,
      input.role,
      input.agent_id,
      input.initiative_id ?? null,
      input.task_id ?? null,
      input.parent_run_id ?? null,
      input.label ?? null,
      input.trigger_body ?? null,
      input.pm_proposal_id ?? null,
      input.run_group_id ?? null,
      input.cost_ceiling_cents ?? null,
    ],
  );
  return id;
}

/**
 * Look up an agent_run by its dispatch-time `run_group_id`. Returns
 * the matching row, or null if none. Used by MCP tools (currently
 * `take_note`) to gate writes on run status — a worker whose run was
 * cancelled while it was mid-flight should not be able to persist
 * orphan rows. See docs/archive/dedupe-investigations.md.
 */
export function getRunByGroupId(run_group_id: string): AgentRun | null {
  if (!run_group_id) return null;
  return (
    queryOne<AgentRun>(
      `SELECT * FROM agent_runs
       WHERE run_group_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [run_group_id],
    ) ?? null
  );
}

export interface CompleteAgentRunInput {
  openclaw_session_id?: string | null;
  model_used?: string | null;
  cost_cents?: number | null;
}

export function completeAgentRun(id: string, opts: CompleteAgentRunInput = {}): void {
  run(
    `UPDATE agent_runs SET
       status = 'complete',
       openclaw_session_id = COALESCE(?, openclaw_session_id),
       model_used = COALESCE(?, model_used),
       cost_cents = COALESCE(?, cost_cents),
       completed_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ? AND status NOT IN ('complete','failed','cancelled')`,
    [opts.openclaw_session_id ?? null, opts.model_used ?? null, opts.cost_cents ?? null, id],
  );
}

export function failAgentRun(id: string, errorMd: string): void {
  run(
    `UPDATE agent_runs SET
       status = 'failed',
       error_md = ?,
       completed_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ? AND status NOT IN ('complete','failed','cancelled')`,
    [errorMd, id],
  );
}

/**
 * Roll up a fan-out parent based on its children's outcomes.
 *
 * Used by orchestrators (today: subtree audit) that create a synthetic
 * root agent_runs row before fanning out leaves. After all children
 * settle, call this to flip the parent to `complete` (≤ failureThreshold
 * fraction failed) or `failed` (> threshold) in one shot.
 *
 * The default 0.5 threshold mirrors `SUBTREE_FAILURE_THRESHOLD` in
 * subtree-audit.ts — kept as a parameter so other fan-outs can tune it.
 *
 * No-ops if the parent is already terminal.
 */
export interface RollupChildResult {
  status: 'ok' | 'failed';
  error?: string | null;
}

export function markRunRollup(
  parentId: string,
  childResults: ReadonlyArray<RollupChildResult>,
  failureThreshold = 0.5,
): void {
  const total = childResults.length;
  const failedCount = childResults.filter((c) => c.status === 'failed').length;
  // Empty fan-outs (no children dispatched) are treated as a successful
  // no-op rather than NaN > threshold = false. Caller probably doesn't
  // want a "failed" parent for a tree with no non-terminal descendants.
  const failRatio = total === 0 ? 0 : failedCount / total;
  if (failRatio > failureThreshold) {
    const sample = childResults
      .filter((c) => c.status === 'failed' && c.error)
      .slice(0, 3)
      .map((c, i) => `${i + 1}. ${c.error}`)
      .join('\n');
    failAgentRun(
      parentId,
      `Subtree audit: ${failedCount}/${total} children failed (>${(
        failureThreshold * 100
      ).toFixed(0)}%).${sample ? `\n\nFirst failures:\n${sample}` : ''}`,
    );
  } else {
    completeAgentRun(parentId);
  }
}

// ─── Jobs-in-Progress: /api/jobs read model (PR 2) ─────────────────
//
// listJobs() backs the GET /api/jobs route. Three buckets in one call:
// live (queued+running, with pm_chat collapsed by scope_key),
// scheduled (active recurring_jobs ≤24h horizon), recent (terminal in
// last 24h, ungrouped). See specs/jobs-in-progress.md §API.

export interface JobsLiveItem {
  /** When `group_count > 1`, this id refers to the most-recent run in the group. */
  id: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  scope_key: string | null;
  scope_type: string | null;
  role: string | null;
  agent_id: string | null;
  initiative_id: string | null;
  task_id: string | null;
  parent_run_id: string | null;
  label: string | null;
  /** Server-derived fallback label when `label` is null (e.g. "PM chat",
   *  "Audit: <initiative title>"). UI can prefer this when label is null. */
  derived_label: string;
  started_at: string | null;
  /** 1 for ungrouped rows; N for collapsed pm_chat groups. */
  group_count: number;
}

export interface JobsRecentItem extends JobsLiveItem {
  completed_at: string | null;
  cost_cents: number | null;
  model_used: string | null;
  error_md: string | null;
}

export interface JobsScheduledItem {
  job_id: string;
  name: string;
  next_run_at: string;
  last_run_at: string | null;
  consecutive_failures: number;
  role: string;
  /**
   * error_md from the most recent failed `recurring` agent_runs row
   * for this job_id. Populated only when consecutive_failures > 0;
   * null otherwise. UI uses it as the failure-chip tooltip (PR 3).
   */
  last_failure_md: string | null;
}

export interface JobsListResponse {
  live: JobsLiveItem[];
  scheduled: JobsScheduledItem[];
  recent: JobsRecentItem[];
}

/**
 * Lightweight live count using the same collapse rules as listJobs:
 * pm_chat collapsed by scope_key (one entry per session), every other
 * kind one-per-row. Backs the AppNav badge — polled at a slower rate
 * than the page so we keep this query cheap.
 */
export function countLiveJobs(workspaceId: string): number {
  if (!workspaceId.trim()) {
    throw new AgentRunValidationError('workspace_id is required');
  }
  const row = queryOne<{ live: number }>(
    `SELECT
       (SELECT COUNT(*) FROM agent_runs
          WHERE workspace_id = ?
            AND status IN ('queued','running')
            AND (kind != 'pm_chat' OR scope_key IS NULL))
       +
       (SELECT COUNT(*) FROM (
          SELECT 1 FROM agent_runs
           WHERE workspace_id = ?
             AND status IN ('queued','running')
             AND kind = 'pm_chat'
             AND scope_key IS NOT NULL
           GROUP BY scope_key
        ))
       AS live`,
    [workspaceId, workspaceId],
  );
  return row?.live ?? 0;
}

interface RawAgentRunRow extends AgentRun {
  initiative_title: string | null;
}

function deriveLabel(row: { kind: AgentRunKind; label: string | null; initiative_title: string | null; scope_key: string | null }): string {
  if (row.label && row.label.trim()) return row.label;
  switch (row.kind) {
    case 'pm_chat': return 'PM chat';
    case 'plan': return row.initiative_title ? `Plan: ${row.initiative_title}` : 'Plan';
    case 'decompose': return row.initiative_title ? `Decompose: ${row.initiative_title}` : 'Decompose';
    case 'initiative_audit': return row.initiative_title ? `Audit: ${row.initiative_title}` : 'Audit';
    case 'recurring': return 'Recurring tick';
    case 'task_coord': return 'Task coordinator';
    case 'task_role': return 'Task role';
    case 'brief': return 'Brief';
    default: return row.kind;
  }
}

export interface ListJobsOptions {
  /**
   * When set, restrict live + recent buckets to runs whose
   * `initiative_id` matches. Scheduled bucket is excluded under this
   * filter (recurring_jobs aren't initiative-scoped today; revisit if
   * that changes). See specs/audit-actions-and-tracking.md PR 2.
   */
  initiative_id?: string;
}

export function listJobs(
  workspaceId: string,
  options: ListJobsOptions = {},
): JobsListResponse {
  if (!workspaceId.trim()) {
    throw new AgentRunValidationError('workspace_id is required');
  }

  const initiativeFilter = options.initiative_id?.trim() || undefined;

  // Live: queued + running. Join initiatives.title for derived_label fallback.
  const liveRows = queryAll<RawAgentRunRow>(
    `SELECT ar.*, i.title AS initiative_title
       FROM agent_runs ar
       LEFT JOIN initiatives i ON i.id = ar.initiative_id
      WHERE ar.workspace_id = ?
        ${initiativeFilter ? 'AND ar.initiative_id = ?' : ''}
        AND ar.status IN ('queued','running')
      ORDER BY ar.started_at DESC, ar.created_at DESC, ar.rowid DESC`,
    initiativeFilter ? [workspaceId, initiativeFilter] : [workspaceId],
  );

  // Collapse pm_chat by scope_key. Other kinds pass through.
  const live: JobsLiveItem[] = [];
  const pmGroups = new Map<string, { rep: RawAgentRunRow; count: number }>();
  for (const row of liveRows) {
    if (row.kind === 'pm_chat' && row.scope_key) {
      const g = pmGroups.get(row.scope_key);
      if (g) {
        g.count += 1;
        // Keep most-recent started_at as representative (ORDER BY DESC means first seen wins).
        continue;
      }
      pmGroups.set(row.scope_key, { rep: row, count: 1 });
    } else {
      live.push({
        id: row.id,
        kind: row.kind,
        status: row.status,
        scope_key: row.scope_key,
        scope_type: row.scope_type,
        role: row.role,
        agent_id: row.agent_id,
        initiative_id: row.initiative_id,
        task_id: row.task_id,
        parent_run_id: row.parent_run_id,
        label: row.label,
        derived_label: deriveLabel(row),
        started_at: row.started_at,
        group_count: 1,
      });
    }
  }
  for (const { rep, count } of pmGroups.values()) {
    live.push({
      id: rep.id,
      kind: rep.kind,
      status: rep.status,
      scope_key: rep.scope_key,
      scope_type: rep.scope_type,
      role: rep.role,
      agent_id: rep.agent_id,
      initiative_id: rep.initiative_id,
      task_id: rep.task_id,
      parent_run_id: rep.parent_run_id,
      label: rep.label,
      derived_label: deriveLabel(rep),
      started_at: rep.started_at,
      group_count: count,
    });
  }
  // Final sort: most recent started_at first.
  live.sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''));

  // Scheduled: recurring_jobs active in next 24h. For rows with a
  // failure streak, attach the most recent matching failed agent_runs
  // row's error_md as `last_failure_md` for the chip tooltip (PR 3).
  //
  // When filtering by initiative_id, scheduled is suppressed —
  // recurring_jobs aren't initiative-scoped today, and showing all of a
  // workspace's recurring jobs on every initiative page would be noisy.
  // If recurring_jobs grow an initiative_id column later, revisit.
  const scheduledRaw = initiativeFilter
    ? []
    : queryAll<Omit<JobsScheduledItem, 'last_failure_md'>>(
        `SELECT id AS job_id, name, next_run_at, last_run_at, consecutive_failures, role
           FROM recurring_jobs
          WHERE workspace_id = ?
            AND status = 'active'
            AND next_run_at <= datetime('now', '+24 hours')
          ORDER BY next_run_at ASC`,
        [workspaceId],
      );
  const scheduled: JobsScheduledItem[] = scheduledRaw.map((row) => {
    let last_failure_md: string | null = null;
    if (row.consecutive_failures > 0) {
      const last = queryOne<{ error_md: string | null }>(
        `SELECT error_md FROM agent_runs
          WHERE workspace_id = ?
            AND kind = 'recurring'
            AND status = 'failed'
            AND source_ref = ?
          ORDER BY completed_at DESC, rowid DESC
          LIMIT 1`,
        [workspaceId, row.job_id],
      );
      last_failure_md = last?.error_md ?? null;
    }
    return { ...row, last_failure_md };
  });

  // Recent: terminal in last 24h, individual rows (NOT grouped). Cap 100.
  const recentRows = queryAll<RawAgentRunRow>(
    `SELECT ar.*, i.title AS initiative_title
       FROM agent_runs ar
       LEFT JOIN initiatives i ON i.id = ar.initiative_id
      WHERE ar.workspace_id = ?
        ${initiativeFilter ? 'AND ar.initiative_id = ?' : ''}
        AND ar.status IN ('complete','failed','cancelled')
        AND ar.completed_at >= datetime('now', '-24 hours')
      ORDER BY ar.completed_at DESC, ar.rowid DESC
      LIMIT 100`,
    initiativeFilter ? [workspaceId, initiativeFilter] : [workspaceId],
  );
  const recent: JobsRecentItem[] = recentRows.map(row => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    scope_key: row.scope_key,
    scope_type: row.scope_type,
    role: row.role,
    agent_id: row.agent_id,
    initiative_id: row.initiative_id,
    task_id: row.task_id,
    parent_run_id: row.parent_run_id,
    label: row.label,
    derived_label: deriveLabel(row),
    started_at: row.started_at,
    group_count: 1,
    completed_at: row.completed_at,
    cost_cents: row.cost_cents,
    model_used: row.model_used,
    error_md: row.error_md,
  }));

  return { live, scheduled, recent };
}

// ─── Jobs-in-Progress: cancel (PR 4) ───────────────────────────────
//
// cancelAgentRun flips a queued/running row → cancelled and cascades
// to any non-terminal direct children (parent_run_id = id). Used by
// POST /api/jobs/:id/cancel. Gateway session-close is best-effort and
// happens in the route, not here — DAO stays pure.

export class AgentRunNotFoundError extends Error {
  constructor(id: string) {
    super(`agent_run ${id} not found`);
    this.name = 'AgentRunNotFoundError';
  }
}

export class AgentRunNotCancellableError extends Error {
  constructor(public id: string, public status: AgentRunStatus) {
    super(`agent_run ${id} is ${status}, not cancellable`);
    this.name = 'AgentRunNotCancellableError';
  }
}

export interface CancelAgentRunResult {
  id: string;
  status: 'cancelled';
  children_cancelled: number;
  /** The openclaw_session_id the row had at cancel time, if any.
   *  Returned so the route can fire a best-effort gateway abort. */
  openclaw_session_id: string | null;
}

/**
 * Cancel an agent_runs row and any non-terminal direct children.
 *
 * Throws AgentRunNotFoundError if the id doesn't exist.
 * Throws AgentRunNotCancellableError if the row is already terminal
 * (complete/failed/cancelled) — caller maps to 409.
 *
 * Children are matched by `parent_run_id = id` and cancelled with
 * 'Parent cancelled by operator'. The whole thing runs in one
 * transaction so a partial cascade can't strand children.
 */
export function cancelAgentRun(id: string): CancelAgentRunResult {
  return transaction(() => {
    const row = getAgentRun(id);
    if (!row) throw new AgentRunNotFoundError(id);
    if (row.status !== 'queued' && row.status !== 'running') {
      throw new AgentRunNotCancellableError(id, row.status);
    }
    run(
      `UPDATE agent_runs SET
         status = 'cancelled',
         error_md = COALESCE(error_md, ?),
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ?`,
      ['Cancelled by operator', id],
    );
    const result = run(
      `UPDATE agent_runs SET
         status = 'cancelled',
         error_md = COALESCE(error_md, ?),
         completed_at = datetime('now'),
         updated_at = datetime('now')
       WHERE parent_run_id = ?
         AND status IN ('queued','running')`,
      ['Parent cancelled by operator', id],
    );
    // PR 5: if this was a PM-chat dispatch tied to a still-pending
    // pm_proposals row, flip that proposal to `synth_only` so the
    // existing fallback fires instead of leaving operators staring at
    // a placeholder card forever. Best-effort — don't unwind the
    // cancel if this throws.
    if (row.pm_proposal_id) {
      try {
        run(
          `UPDATE pm_proposals
              SET dispatch_state = 'synth_only'
            WHERE id = ?
              AND dispatch_state = 'pending_agent'`,
          [row.pm_proposal_id],
        );
      } catch (err) {
        console.warn(
          '[cancelAgentRun] pm_proposal flip to synth_only failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return {
      id,
      status: 'cancelled' as const,
      children_cancelled: result.changes,
      openclaw_session_id: row.openclaw_session_id,
    };
  });
}

export function reapStaleRunning(staleSeconds: number, errorMd: string): number {
  const result = run(
    `UPDATE agent_runs SET
       status = 'failed',
       error_md = ?,
       completed_at = datetime('now'),
       updated_at = datetime('now')
     WHERE status = 'running'
       AND updated_at < datetime('now', ?)`,
    [errorMd, `-${staleSeconds} seconds`],
  );
  return result.changes;
}
