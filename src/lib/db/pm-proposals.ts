/**
 * PM proposal DB helpers (Phase 5 of the roadmap & PM-agent feature).
 *
 * `pm_proposals` rows are the unit of PM-driven change. Each row carries:
 *
 *   - The trigger that produced it (`trigger_text`, `trigger_kind`).
 *   - A markdown impact summary the operator reads in the chat.
 *   - A typed JSON diff the operator approves; on accept, this module
 *     applies it transactionally.
 *
 * Apply is all-or-nothing in v1 (spec §9.3). The validate-then-apply
 * helper either succeeds completely or leaves the DB untouched.
 *
 * Diff kinds (matches spec §9.3 exactly — schema docs in pm-soul.md):
 *
 *   - `shift_initiative_target` — UPDATE initiatives SET target_*
 *   - `add_availability` — INSERT INTO owner_availability
 *   - `set_initiative_status` — UPDATE initiatives SET status
 *       (planned | in_progress | at_risk | blocked only — done/cancelled
 *       are off-limits for the PM)
 *   - `add_dependency` — INSERT INTO initiative_dependencies
 *   - `remove_dependency` — DELETE by id
 *   - `reorder_initiatives` — UPDATE sort_order across siblings
 *   - `update_status_check` — UPDATE initiatives SET status_check_md
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb, queryAll, queryOne, run } from '@/lib/db';

// ─── Types ──────────────────────────────────────────────────────────

export type PmProposalStatus = 'draft' | 'accepted' | 'rejected' | 'superseded';
export type PmProposalTriggerKind =
  | 'manual'
  | 'scheduled_drift_scan'
  | 'disruption_event'
  | 'status_check_investigation';

export type PmDiff =
  | {
      kind: 'shift_initiative_target';
      initiative_id: string;
      target_start?: string | null;
      target_end?: string | null;
      reason?: string;
    }
  | {
      kind: 'add_availability';
      agent_id: string;
      start: string;
      end: string;
      reason?: string;
    }
  | {
      kind: 'set_initiative_status';
      initiative_id: string;
      status: 'planned' | 'in_progress' | 'at_risk' | 'blocked';
    }
  | {
      kind: 'add_dependency';
      initiative_id: string;
      depends_on_initiative_id: string;
      note?: string;
    }
  | { kind: 'remove_dependency'; dependency_id: string }
  | {
      kind: 'reorder_initiatives';
      parent_id: string | null;
      child_ids_in_order: string[];
    }
  | {
      kind: 'update_status_check';
      initiative_id: string;
      status_check_md: string;
    };

export interface PmProposal {
  id: string;
  workspace_id: string;
  trigger_text: string;
  trigger_kind: PmProposalTriggerKind;
  impact_md: string;
  proposed_changes: PmDiff[];
  status: PmProposalStatus;
  applied_at: string | null;
  applied_by_agent_id: string | null;
  parent_proposal_id: string | null;
  created_at: string;
}

interface PmProposalRow {
  id: string;
  workspace_id: string;
  trigger_text: string;
  trigger_kind: PmProposalTriggerKind;
  impact_md: string;
  proposed_changes: string;
  status: PmProposalStatus;
  applied_at: string | null;
  applied_by_agent_id: string | null;
  parent_proposal_id: string | null;
  created_at: string;
}

// ─── Validation ─────────────────────────────────────────────────────

/** A typed validation error so callers can map to HTTP 400 cleanly. */
export class PmProposalValidationError extends Error {
  constructor(message: string, public readonly hints?: string[]) {
    super(message);
    this.name = 'PmProposalValidationError';
  }
}

const STATUS_ALLOWED_FROM_PM = new Set(['planned', 'in_progress', 'at_risk', 'blocked']);

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function isValidDateString(s: unknown): s is string {
  return typeof s === 'string' && ISO_DATE_RE.test(s) && !Number.isNaN(Date.parse(s));
}

function assertInitiativeInWorkspace(
  workspaceId: string,
  initiativeId: string,
  errors: string[],
  initiativeCache: Map<string, boolean>,
) {
  if (initiativeCache.has(initiativeId)) {
    if (!initiativeCache.get(initiativeId)) {
      errors.push(`initiative ${initiativeId} not found in workspace ${workspaceId}`);
    }
    return;
  }
  const row = queryOne<{ id: string }>(
    'SELECT id FROM initiatives WHERE id = ? AND workspace_id = ?',
    [initiativeId, workspaceId],
  );
  initiativeCache.set(initiativeId, !!row);
  if (!row) errors.push(`initiative ${initiativeId} not found in workspace ${workspaceId}`);
}

/**
 * Validate a single proposal's diff list against the workspace state.
 * Returns a list of error strings; empty = OK. Cheap to call from
 * `createProposal` AND `acceptProposal` — both points use it (defence in
 * depth: an initiative might be deleted between draft and accept).
 */
export function validateProposedChanges(
  workspaceId: string,
  changes: PmDiff[],
): string[] {
  const errors: string[] = [];
  const initiativeCache = new Map<string, boolean>();

  if (!Array.isArray(changes)) {
    return ['proposed_changes must be an array'];
  }

  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (!c || typeof c !== 'object' || !('kind' in c)) {
      errors.push(`changes[${i}]: missing kind`);
      continue;
    }
    switch (c.kind) {
      case 'shift_initiative_target': {
        if (!c.initiative_id) {
          errors.push(`changes[${i}]: initiative_id required`);
          break;
        }
        assertInitiativeInWorkspace(workspaceId, c.initiative_id, errors, initiativeCache);
        if (c.target_start != null && !isValidDateString(c.target_start)) {
          errors.push(`changes[${i}]: target_start "${c.target_start}" invalid`);
        }
        if (c.target_end != null && !isValidDateString(c.target_end)) {
          errors.push(`changes[${i}]: target_end "${c.target_end}" invalid`);
        }
        if (c.target_start == null && c.target_end == null) {
          errors.push(`changes[${i}]: at least one of target_start / target_end required`);
        }
        break;
      }
      case 'add_availability': {
        if (!c.agent_id) {
          errors.push(`changes[${i}]: agent_id required`);
          break;
        }
        const a = queryOne<{ id: string }>('SELECT id FROM agents WHERE id = ?', [c.agent_id]);
        if (!a) errors.push(`changes[${i}]: agent ${c.agent_id} not found`);
        if (!isValidDateString(c.start)) errors.push(`changes[${i}]: start "${c.start}" invalid`);
        if (!isValidDateString(c.end)) errors.push(`changes[${i}]: end "${c.end}" invalid`);
        if (isValidDateString(c.start) && isValidDateString(c.end) && c.end < c.start) {
          errors.push(`changes[${i}]: end must be >= start`);
        }
        break;
      }
      case 'set_initiative_status': {
        if (!c.initiative_id) {
          errors.push(`changes[${i}]: initiative_id required`);
          break;
        }
        assertInitiativeInWorkspace(workspaceId, c.initiative_id, errors, initiativeCache);
        if (!STATUS_ALLOWED_FROM_PM.has(c.status)) {
          errors.push(
            `changes[${i}]: status "${c.status}" not allowed from PM (planned/in_progress/at_risk/blocked only)`,
          );
        }
        break;
      }
      case 'add_dependency': {
        if (!c.initiative_id || !c.depends_on_initiative_id) {
          errors.push(`changes[${i}]: initiative_id and depends_on_initiative_id required`);
          break;
        }
        assertInitiativeInWorkspace(workspaceId, c.initiative_id, errors, initiativeCache);
        assertInitiativeInWorkspace(workspaceId, c.depends_on_initiative_id, errors, initiativeCache);
        if (c.initiative_id === c.depends_on_initiative_id) {
          errors.push(`changes[${i}]: cannot depend on itself`);
        }
        break;
      }
      case 'remove_dependency': {
        if (!c.dependency_id) {
          errors.push(`changes[${i}]: dependency_id required`);
          break;
        }
        const dep = queryOne<{ id: string; initiative_id: string }>(
          `SELECT id.id AS id, id.initiative_id AS initiative_id
             FROM initiative_dependencies id
             JOIN initiatives i ON i.id = id.initiative_id
            WHERE id.id = ? AND i.workspace_id = ?`,
          [c.dependency_id, workspaceId],
        );
        if (!dep) {
          errors.push(`changes[${i}]: dependency ${c.dependency_id} not found in workspace`);
        }
        break;
      }
      case 'reorder_initiatives': {
        if (!Array.isArray(c.child_ids_in_order) || c.child_ids_in_order.length === 0) {
          errors.push(`changes[${i}]: child_ids_in_order must be a non-empty array`);
          break;
        }
        for (const cid of c.child_ids_in_order) {
          assertInitiativeInWorkspace(workspaceId, cid, errors, initiativeCache);
        }
        if (c.parent_id) {
          assertInitiativeInWorkspace(workspaceId, c.parent_id, errors, initiativeCache);
        }
        break;
      }
      case 'update_status_check': {
        if (!c.initiative_id) {
          errors.push(`changes[${i}]: initiative_id required`);
          break;
        }
        assertInitiativeInWorkspace(workspaceId, c.initiative_id, errors, initiativeCache);
        if (typeof c.status_check_md !== 'string') {
          errors.push(`changes[${i}]: status_check_md must be a string`);
        }
        break;
      }
      default: {
        const exhaustive: never = c;
        errors.push(`changes[${i}]: unknown kind "${(exhaustive as { kind?: string }).kind ?? '?'}"`);
      }
    }
  }
  return errors;
}

// ─── Row mapping ────────────────────────────────────────────────────

function rowToProposal(row: PmProposalRow): PmProposal {
  let parsed: PmDiff[] = [];
  try {
    parsed = JSON.parse(row.proposed_changes) as PmDiff[];
    if (!Array.isArray(parsed)) parsed = [];
  } catch {
    parsed = [];
  }
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    trigger_text: row.trigger_text,
    trigger_kind: row.trigger_kind,
    impact_md: row.impact_md,
    proposed_changes: parsed,
    status: row.status,
    applied_at: row.applied_at,
    applied_by_agent_id: row.applied_by_agent_id,
    parent_proposal_id: row.parent_proposal_id,
    created_at: row.created_at,
  };
}

// ─── Public helpers ─────────────────────────────────────────────────

export interface CreateProposalInput {
  workspace_id: string;
  trigger_text: string;
  trigger_kind?: PmProposalTriggerKind;
  impact_md: string;
  proposed_changes: PmDiff[];
  parent_proposal_id?: string | null;
}

export function createProposal(input: CreateProposalInput): PmProposal {
  if (!input.workspace_id) throw new PmProposalValidationError('workspace_id required');
  if (!input.trigger_text) throw new PmProposalValidationError('trigger_text required');
  if (typeof input.impact_md !== 'string') {
    throw new PmProposalValidationError('impact_md required');
  }

  const errors = validateProposedChanges(input.workspace_id, input.proposed_changes ?? []);
  if (errors.length > 0) {
    throw new PmProposalValidationError(
      `Invalid proposed_changes: ${errors.length} error(s)`,
      errors,
    );
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  run(
    `INSERT INTO pm_proposals (
       id, workspace_id, trigger_text, trigger_kind, impact_md,
       proposed_changes, status, parent_proposal_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    [
      id,
      input.workspace_id,
      input.trigger_text,
      input.trigger_kind ?? 'manual',
      input.impact_md,
      JSON.stringify(input.proposed_changes ?? []),
      input.parent_proposal_id ?? null,
      now,
    ],
  );
  return getProposal(id)!;
}

export function getProposal(id: string): PmProposal | undefined {
  const row = queryOne<PmProposalRow>('SELECT * FROM pm_proposals WHERE id = ?', [id]);
  return row ? rowToProposal(row) : undefined;
}

export interface ListProposalFilters {
  workspace_id?: string;
  status?: PmProposalStatus;
  since?: string;
  limit?: number;
}

export function listProposals(filters: ListProposalFilters = {}): PmProposal[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.workspace_id) {
    where.push('workspace_id = ?');
    params.push(filters.workspace_id);
  }
  if (filters.status) {
    where.push('status = ?');
    params.push(filters.status);
  }
  if (filters.since) {
    where.push('created_at >= ?');
    params.push(filters.since);
  }
  const sql =
    'SELECT * FROM pm_proposals ' +
    (where.length ? `WHERE ${where.join(' AND ')} ` : '') +
    'ORDER BY created_at DESC' +
    (filters.limit ? ` LIMIT ${Math.max(1, Math.min(500, filters.limit | 0))}` : '');
  return queryAll<PmProposalRow>(sql, params).map(rowToProposal);
}

// ─── Apply (acceptProposal) ─────────────────────────────────────────

export interface AcceptProposalResult {
  proposal: PmProposal;
  changes_applied: number;
  /** True when the proposal was already accepted — the second call is a no-op. */
  idempotent_noop: boolean;
}

/**
 * Apply a draft proposal's diff list transactionally.
 *
 *   - Validates referenced ids again (defence-in-depth).
 *   - Wraps every mutation + the status flip in a single transaction.
 *   - Marks the proposal `accepted` with `applied_at` and
 *     `applied_by_agent_id`.
 *   - Emits one `events` row of type `pm_proposal_accepted` with a
 *     summary metadata blob.
 *
 * Idempotent: applying an already-accepted proposal is a no-op (returns
 * `idempotent_noop: true`). Rejected / superseded proposals can't be
 * applied — throws.
 */
export function acceptProposal(
  id: string,
  applied_by_agent_id: string | null = null,
): AcceptProposalResult {
  const existing = getProposal(id);
  if (!existing) throw new PmProposalValidationError(`proposal ${id} not found`);

  if (existing.status === 'accepted') {
    return { proposal: existing, changes_applied: 0, idempotent_noop: true };
  }
  if (existing.status === 'rejected' || existing.status === 'superseded') {
    throw new PmProposalValidationError(
      `proposal ${id} cannot be accepted from status=${existing.status}`,
    );
  }

  // Re-validate against current DB state — initiatives could've been
  // deleted between draft and accept.
  const errors = validateProposedChanges(existing.workspace_id, existing.proposed_changes);
  if (errors.length > 0) {
    throw new PmProposalValidationError(
      `Cannot apply proposal ${id}: ${errors.length} validation error(s)`,
      errors,
    );
  }

  const db = getDb();
  let changesApplied = 0;
  const now = new Date().toISOString();

  db.transaction(() => {
    for (const change of existing.proposed_changes) {
      applyDiff(change, now);
      changesApplied++;
    }

    // Flip the proposal row.
    db.prepare(
      `UPDATE pm_proposals
          SET status = 'accepted', applied_at = ?, applied_by_agent_id = ?
        WHERE id = ?`,
    ).run(now, applied_by_agent_id, id);

    // Emit a single audit event so the live feed shows the accept.
    db.prepare(
      `INSERT INTO events (id, type, agent_id, message, metadata, created_at)
       VALUES (?, 'pm_proposal_accepted', ?, ?, ?, ?)`,
    ).run(
      uuidv4(),
      applied_by_agent_id,
      `PM proposal accepted (${changesApplied} change${changesApplied === 1 ? '' : 's'})`,
      JSON.stringify({
        proposal_id: id,
        workspace_id: existing.workspace_id,
        trigger_kind: existing.trigger_kind,
        change_kinds: existing.proposed_changes.map(c => c.kind),
      }),
      now,
    );
  })();

  const updated = getProposal(id)!;
  return { proposal: updated, changes_applied: changesApplied, idempotent_noop: false };
}

/**
 * Apply one diff. Caller wraps in a transaction.
 *
 * `now` lets the caller pass a single timestamp so all mutations within
 * one accept share an `updated_at` value (cleaner audit story).
 */
function applyDiff(diff: PmDiff, now: string): void {
  switch (diff.kind) {
    case 'shift_initiative_target': {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (diff.target_start !== undefined) {
        sets.push('target_start = ?');
        params.push(diff.target_start);
      }
      if (diff.target_end !== undefined) {
        sets.push('target_end = ?');
        params.push(diff.target_end);
      }
      sets.push('updated_at = ?');
      params.push(now);
      params.push(diff.initiative_id);
      run(`UPDATE initiatives SET ${sets.join(', ')} WHERE id = ?`, params);
      return;
    }
    case 'add_availability': {
      run(
        `INSERT INTO owner_availability (id, agent_id, unavailable_start, unavailable_end, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), diff.agent_id, diff.start, diff.end, diff.reason ?? null, now],
      );
      return;
    }
    case 'set_initiative_status': {
      run(
        `UPDATE initiatives SET status = ?, updated_at = ? WHERE id = ?`,
        [diff.status, now, diff.initiative_id],
      );
      return;
    }
    case 'add_dependency': {
      try {
        run(
          `INSERT INTO initiative_dependencies (id, initiative_id, depends_on_initiative_id, kind, note, created_at)
           VALUES (?, ?, ?, 'finish_to_start', ?, ?)`,
          [uuidv4(), diff.initiative_id, diff.depends_on_initiative_id, diff.note ?? null, now],
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // SQLite throws SQLITE_CONSTRAINT_UNIQUE on duplicate edges. Treat
        // as idempotent — the desired state already exists.
        if (/UNIQUE constraint failed/i.test(msg)) return;
        throw err;
      }
      return;
    }
    case 'remove_dependency': {
      run(`DELETE FROM initiative_dependencies WHERE id = ?`, [diff.dependency_id]);
      return;
    }
    case 'reorder_initiatives': {
      // Bulk update sort_order. Validation already confirmed every id
      // exists in this workspace.
      let order = 0;
      for (const cid of diff.child_ids_in_order) {
        run(
          `UPDATE initiatives SET sort_order = ?, updated_at = ? WHERE id = ?`,
          [order, now, cid],
        );
        order++;
      }
      return;
    }
    case 'update_status_check': {
      run(
        `UPDATE initiatives SET status_check_md = ?, updated_at = ? WHERE id = ?`,
        [diff.status_check_md, now, diff.initiative_id],
      );
      return;
    }
    default: {
      const exhaustive: never = diff;
      throw new Error(`Unknown diff kind: ${(exhaustive as { kind?: string }).kind ?? '?'}`);
    }
  }
}

// ─── Reject / refine ────────────────────────────────────────────────

export function rejectProposal(id: string): PmProposal {
  const existing = getProposal(id);
  if (!existing) throw new PmProposalValidationError(`proposal ${id} not found`);
  if (existing.status === 'rejected') return existing;
  if (existing.status === 'accepted' || existing.status === 'superseded') {
    throw new PmProposalValidationError(
      `proposal ${id} cannot be rejected from status=${existing.status}`,
    );
  }
  run(`UPDATE pm_proposals SET status = 'rejected' WHERE id = ?`, [id]);
  return getProposal(id)!;
}

export interface RefineProposalResult {
  parent: PmProposal;
  /** The new (still-empty) draft slot. The dispatch path fills it. */
  child: PmProposal;
}

/**
 * Mark a proposal `superseded` and create a new draft proposal that
 * inherits its trigger context. The dispatch path is responsible for
 * regenerating impact_md + proposed_changes with the additional
 * constraint applied.
 *
 * In v1 the new draft starts with empty impact + empty changes — the
 * caller (`/api/pm/proposals/[id]/refine` route) then triggers the
 * synthesize/LLM path which rewrites both fields.
 */
export function refineProposal(
  parentId: string,
  additionalConstraint: string,
): RefineProposalResult {
  const parent = getProposal(parentId);
  if (!parent) throw new PmProposalValidationError(`proposal ${parentId} not found`);
  if (parent.status === 'accepted') {
    throw new PmProposalValidationError(
      `proposal ${parentId} already accepted; cannot refine`,
    );
  }

  const childId = uuidv4();
  const now = new Date().toISOString();
  const triggerText = `${parent.trigger_text}\n\n[refine] ${additionalConstraint}`;

  const db = getDb();
  db.transaction(() => {
    if (parent.status === 'draft') {
      run(`UPDATE pm_proposals SET status = 'superseded' WHERE id = ?`, [parentId]);
    }
    run(
      `INSERT INTO pm_proposals (
         id, workspace_id, trigger_text, trigger_kind, impact_md,
         proposed_changes, status, parent_proposal_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      [
        childId,
        parent.workspace_id,
        triggerText,
        parent.trigger_kind,
        '_(refining…)_',
        '[]',
        parentId,
        now,
      ],
    );
  })();

  return { parent: getProposal(parentId)!, child: getProposal(childId)! };
}
