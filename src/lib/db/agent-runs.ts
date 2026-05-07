/**
 * agent_runs DAO.
 *
 * Schema added in migration 075. The shared dispatch envelope for
 * non-task agent work; per-kind domain tables (briefs first;
 * sweeps/readiness_checks/comms_drafts/workflow_node_runs later) link
 * via agent_run_id. See specs/research-area-build-plan.md §2.2.
 *
 * Lifecycle: queued → running → (complete | failed | cancelled).
 * Each transition stamps started_at / completed_at / updated_at as
 * appropriate. Per-kind output (result_md, citations_json, etc.)
 * lives on the per-kind row, not here.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';

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
       cost_ceiling_cents, started_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`,
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
      input.cost_ceiling_cents ?? null,
    ],
  );
  return id;
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
