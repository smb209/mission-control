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
 *       (any of planned | in_progress | at_risk | blocked | done | cancelled;
 *       operator approves at the proposal level — see
 *       docs/archive/initiative-investigate.md §"Schema gap" for why the prior
 *       PM-side `done`/`cancelled` block was lifted)
 *   - `add_dependency` — INSERT INTO initiative_dependencies
 *   - `remove_dependency` — DELETE by id
 *   - `reorder_initiatives` — UPDATE sort_order across siblings
 *   - `update_status_check` — UPDATE initiatives SET status_check_md
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb, queryAll, queryOne, run } from '@/lib/db';
import { createTaskFromInitiative } from './promotion';
import { transitionTaskStatus } from '@/lib/services/task-status';

// ─── Types ──────────────────────────────────────────────────────────

export type PmProposalStatus = 'draft' | 'accepted' | 'rejected' | 'superseded';
export type PmProposalDispatchState = 'pending_agent' | 'agent_complete' | 'synth_only';
export type PmProposalTriggerKind =
  | 'manual'
  | 'scheduled_drift_scan'
  | 'disruption_event'
  | 'status_check_investigation'
  | 'plan_initiative'
  | 'decompose_initiative'
  | 'decompose_story'
  | 'notes_intake'
  | 'revert';

/**
 * Capture state recorded at apply time onto each accepted diff (slice 1 of
 * revertable PM proposals). The field is optional on the type because (a)
 * draft proposals don't have it yet and (b) accepted proposals predating
 * the capture pattern won't either — the revert UI surfaces a "limited"
 * tooltip for those.
 *
 * Per-kind shapes are documented inline on each variant below.
 */
export interface PmDiffCapture {
  /** Set by `applyDiff` for `set_initiative_status`. */
  prev_status?: 'planned' | 'in_progress' | 'at_risk' | 'blocked' | 'done' | 'cancelled';
  /** Set by `applyDiff` for `update_status_check`. */
  prev_status_check_md?: string | null;
  /** Set by `applyDiff` for `shift_initiative_target`. */
  prev_target_start?: string | null;
  /** Set by `applyDiff` for `shift_initiative_target`. */
  prev_target_end?: string | null;
  /** Set by `applyDiff` for `add_dependency` — id of the inserted edge. */
  created_dependency_id?: string;
  /** Set by `applyDiff` for `remove_dependency` — full row prior to delete. */
  removed_dependency_row?: {
    id: string;
    initiative_id: string;
    depends_on_initiative_id: string;
    kind: string;
    note: string | null;
    created_at: string;
  };
  /** Set by `applyDiff` for `reorder_initiatives`. */
  prev_child_ids_in_order?: string[];
  /** Set by `applyCreateChildInitiative` — id of the inserted initiative. */
  created_initiative_id?: string;
  /** Set by the create_task_under_initiative apply pass — id of the new task. */
  created_task_id?: string;
  /** Set by `applyDiff` for `add_availability` — id of the inserted row. */
  created_availability_id?: string;
  /** Set by `applyDiff` for `set_task_status` AND by the
   *  `confirm_task_done` apply pass — task status before the transition,
   *  captured for revert. */
  prev_task_status?: string;
}

export type PmDiff =
  | ({
      kind: 'shift_initiative_target';
      initiative_id: string;
      target_start?: string | null;
      target_end?: string | null;
      reason?: string;
    } & PmDiffCapture)
  | ({
      kind: 'add_availability';
      agent_id: string;
      start: string;
      end: string;
      reason?: string;
    } & PmDiffCapture)
  | ({
      kind: 'set_initiative_status';
      initiative_id: string;
      // Forward proposals are PM-restricted to planned|in_progress|at_risk|blocked
      // (validated when trigger_kind != 'revert'). Revert proposals may
      // restore done/cancelled if that was the captured prev_status, so
      // the diff shape covers all six values.
      status: 'planned' | 'in_progress' | 'at_risk' | 'blocked' | 'done' | 'cancelled';
    } & PmDiffCapture)
  | ({
      kind: 'add_dependency';
      initiative_id: string;
      depends_on_initiative_id: string;
      note?: string;
    } & PmDiffCapture)
  | ({ kind: 'remove_dependency'; dependency_id: string } & PmDiffCapture)
  | ({
      kind: 'reorder_initiatives';
      parent_id: string | null;
      child_ids_in_order: string[];
    } & PmDiffCapture)
  | ({
      kind: 'update_status_check';
      initiative_id: string;
      status_check_md: string;
    } & PmDiffCapture)
  | ({
      // Polish B (decompose flow). On accept, the decompose handler inserts
      // one initiative row under `parent_initiative_id`. `depends_on_initiative_ids`
      // can carry placeholder ids (`$0`, `$1`, …) that point to other
      // siblings created in the SAME accept call (resolved post-insert) or
      // real ids for existing initiatives. `child_kind` is constrained to
      // {milestone, epic, story} — themes are operator-driven only.
      kind: 'create_child_initiative';
      parent_initiative_id: string;
      title: string;
      description?: string | null;
      child_kind: 'milestone' | 'epic' | 'story';
      complexity?: 'S' | 'M' | 'L' | 'XL' | null;
      estimated_effort_hours?: number | null;
      sort_order?: number;
      depends_on_initiative_ids?: string[];
      /** Optional placeholder id for cross-sibling dep resolution. */
      placeholder_id?: string;
    } & PmDiffCapture)
  | ({
      // Freeform-notes intake: create one draft task attached to an
      // initiative. `initiative_id` may be a placeholder ($N or a custom
      // `placeholder_id` from a same-proposal `create_child_initiative`)
      // or a real id for an existing initiative.
      kind: 'create_task_under_initiative';
      initiative_id: string;
      title: string;
      description?: string | null;
      status_check_md?: string | null;
      assigned_agent_id?: string | null;
      priority?: 'low' | 'normal' | 'high';
    } & PmDiffCapture)
  | ({
      // Slice 2 of revertable PM proposals. Used as the inverse of
      // `create_task_under_initiative` — the "tombstone" pattern: PM
      // never hard-deletes, it cancels. Forward proposals are restricted
      // to status='cancelled'; revert proposals (trigger_kind='revert')
      // may restore an arbitrary prev_status captured by another diff
      // (e.g. confirm_task_done). The wider type covers both paths.
      kind: 'set_task_status';
      task_id: string;
      status:
        | 'pending_dispatch'
        | 'planning'
        | 'inbox'
        | 'draft'
        | 'assigned'
        | 'in_progress'
        | 'convoy_active'
        | 'testing'
        | 'review'
        | 'verification'
        | 'done'
        | 'cancelled'
        | 'needs_user_input';
    } & PmDiffCapture)
  | ({
      // PM-driven task close-out. Allowed only when the task is already
      // in a late workflow state (convoy_active, testing, review,
      // verification) and at least one structured pointer to evidence is
      // attached. The apply pass routes through `transitionTaskStatus` so
      // existing review/self-interlock gates still run.
      kind: 'confirm_task_done';
      task_id: string;
      evidence_md: string;
      audit_proposal_id?: string;
      commit_sha?: string;
      pr_url?: string;
    } & PmDiffCapture);

export interface PmProposal {
  id: string;
  workspace_id: string;
  trigger_text: string;
  trigger_kind: PmProposalTriggerKind;
  impact_md: string;
  proposed_changes: PmDiff[];
  /** Structured plan suggestions stored as a proper field, bypassing the
   *  fragile <!--pm-plan-suggestions {json} --> sidecar in impact_md. */
  plan_suggestions: Record<string, unknown> | null;
  status: PmProposalStatus;
  applied_at: string | null;
  applied_by_agent_id: string | null;
  parent_proposal_id: string | null;
  target_initiative_id: string | null;
  /** Where this row sits in the PM dispatch lifecycle (Tier 3 of the
   *  pm-dispatch-async spec). For pre-migration rows or non-dispatched
   *  proposals, defaults to 'agent_complete'. */
  dispatch_state: PmProposalDispatchState;
  /** When this proposal was synthesized to undo another accepted proposal,
   *  this points back at it. NULL for forward proposals. */
  reverts_proposal_id: string | null;
  created_at: string;
}

interface PmProposalRow {
  id: string;
  workspace_id: string;
  trigger_text: string;
  trigger_kind: PmProposalTriggerKind;
  impact_md: string;
  proposed_changes: string;
  plan_suggestions: string | null;
  status: PmProposalStatus;
  applied_at: string | null;
  applied_by_agent_id: string | null;
  parent_proposal_id: string | null;
  target_initiative_id: string | null;
  dispatch_state: PmProposalDispatchState | null;
  reverts_proposal_id: string | null;
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
  options: { trigger_kind?: PmProposalTriggerKind } = {},
): string[] {
  const errors: string[] = [];
  const initiativeCache = new Map<string, boolean>();

  if (!Array.isArray(changes)) {
    return ['proposed_changes must be an array'];
  }

  // Build a placeholder set so create_task_under_initiative diffs can
  // reference initiatives created earlier in the SAME proposal. Both
  // ordinal `$N` (where N is the position of a create_child_initiative)
  // and explicit `placeholder_id` are supported.
  const validPlaceholders = new Set<string>();
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (c && c.kind === 'create_child_initiative') {
      validPlaceholders.add(`$${i}`);
      if (c.placeholder_id) validPlaceholders.add(c.placeholder_id);
    }
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
        // Policy: PM may propose any of the 6 InitiativeStatus values,
        // including done/cancelled. Operator approval (accept/refine on
        // the diff) is the gate — not the validator. See
        // docs/archive/initiative-investigate.md (schema-gap section) for the
        // rationale: the PM's job is to surface the right next move and
        // package it as a reviewable diff; restricting which statuses
        // it can propose forced ergonomic workarounds (status_check
        // notes saying "we should mark this done") instead of letting
        // the operator just click accept.
        const allowed = new Set([
          'planned',
          'in_progress',
          'at_risk',
          'blocked',
          'done',
          'cancelled',
        ]);
        if (!allowed.has(c.status)) {
          errors.push(`changes[${i}]: status "${c.status}" is not a valid initiative status`);
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
      case 'create_task_under_initiative': {
        if (!c.initiative_id) {
          errors.push(`changes[${i}]: initiative_id required`);
          break;
        }
        // Accept either an ordinal placeholder ($N) or a custom
        // placeholder_id from a same-proposal create_child_initiative,
        // OR a real workspace initiative id.
        if (validPlaceholders.has(c.initiative_id)) {
          // Resolved at apply time.
        } else if (c.initiative_id.startsWith('$')) {
          errors.push(
            `changes[${i}]: placeholder ${c.initiative_id} does not match any create_child_initiative diff`,
          );
        } else {
          assertInitiativeInWorkspace(workspaceId, c.initiative_id, errors, initiativeCache);
        }
        if (!c.title || typeof c.title !== 'string' || c.title.length > 500) {
          errors.push(`changes[${i}]: title required (1..500 chars)`);
        }
        if (c.assigned_agent_id) {
          const a = queryOne<{ id: string }>(
            'SELECT id FROM agents WHERE id = ? AND workspace_id = ?',
            [c.assigned_agent_id, workspaceId],
          );
          if (!a) errors.push(`changes[${i}]: assigned_agent_id ${c.assigned_agent_id} not in workspace`);
        }
        if (c.priority != null && !['low', 'normal', 'high'].includes(c.priority)) {
          errors.push(`changes[${i}]: priority must be one of low/normal/high`);
        }
        break;
      }
      case 'create_child_initiative': {
        if (!c.parent_initiative_id) {
          errors.push(`changes[${i}]: parent_initiative_id required`);
          break;
        }
        assertInitiativeInWorkspace(workspaceId, c.parent_initiative_id, errors, initiativeCache);
        if (!c.title || typeof c.title !== 'string') {
          errors.push(`changes[${i}]: title required`);
        }
        // Hard-coded allowlist for child_kind — themes are
        // operator-driven and never proposed by the PM. Milestones are
        // permitted so a theme parent can be split into milestones.
        if (c.child_kind !== 'milestone' && c.child_kind !== 'epic' && c.child_kind !== 'story') {
          errors.push(
            `changes[${i}]: child_kind must be 'milestone', 'epic', or 'story' (got '${c.child_kind}')`,
          );
        }
        if (c.complexity != null && !['S', 'M', 'L', 'XL'].includes(c.complexity)) {
          errors.push(`changes[${i}]: complexity must be one of S/M/L/XL`);
        }
        if (Array.isArray(c.depends_on_initiative_ids)) {
          for (const ref of c.depends_on_initiative_ids) {
            // Placeholder ids ($0, $1, …) are resolved at apply time so we
            // skip the workspace check here. Real ids must already exist.
            if (typeof ref !== 'string') {
              errors.push(`changes[${i}]: depends_on_initiative_ids must be strings`);
              continue;
            }
            if (ref.startsWith('$')) continue;
            assertInitiativeInWorkspace(workspaceId, ref, errors, initiativeCache);
          }
        }
        break;
      }
      case 'set_task_status': {
        if (!c.task_id) {
          errors.push(`changes[${i}]: task_id required`);
          break;
        }
        // Forward proposals are restricted to status='cancelled' (the
        // tombstone path for create_task_under_initiative). Revert
        // proposals may restore any prev_status captured by another
        // diff (e.g. confirm_task_done's invertDiff), so we relax the
        // gate when trigger_kind === 'revert'.
        if (options.trigger_kind !== 'revert' && c.status !== 'cancelled') {
          errors.push(
            `changes[${i}]: set_task_status only supports status='cancelled' on forward proposals (revert use only)`,
          );
        }
        const t = queryOne<{ id: string }>(
          'SELECT id FROM tasks WHERE id = ? AND workspace_id = ?',
          [c.task_id, workspaceId],
        );
        if (!t) {
          errors.push(`changes[${i}]: task ${c.task_id} not found in workspace ${workspaceId}`);
        }
        break;
      }
      case 'confirm_task_done': {
        if (!c.task_id) {
          errors.push(`changes[${i}]: task_id required`);
          break;
        }
        const t = queryOne<{ id: string; status: string }>(
          'SELECT id, status FROM tasks WHERE id = ? AND workspace_id = ?',
          [c.task_id, workspaceId],
        );
        if (!t) {
          errors.push(`changes[${i}]: task ${c.task_id} not found in workspace ${workspaceId}`);
          break;
        }
        const allowedSources = new Set([
          'convoy_active',
          'testing',
          'review',
          'verification',
        ]);
        if (!allowedSources.has(t.status)) {
          errors.push(
            `changes[${i}]: confirm_task_done requires task to be in convoy_active|testing|review|verification (got '${t.status}'). File a create_task_under_initiative reminder instead.`,
          );
        }
        if (typeof c.evidence_md !== 'string' || c.evidence_md.trim().length < 20) {
          errors.push(
            `changes[${i}]: evidence_md required (>= 20 chars of human-readable justification)`,
          );
        }
        const hasPointer =
          (typeof c.audit_proposal_id === 'string' && c.audit_proposal_id.length > 0) ||
          (typeof c.commit_sha === 'string' && c.commit_sha.length > 0) ||
          (typeof c.pr_url === 'string' && c.pr_url.length > 0);
        if (!hasPointer) {
          errors.push(
            `changes[${i}]: at least one of audit_proposal_id|commit_sha|pr_url required as evidence`,
          );
        }
        if (c.audit_proposal_id) {
          const audit = queryOne<{ id: string; status: string; workspace_id: string }>(
            'SELECT id, status, workspace_id FROM pm_proposals WHERE id = ?',
            [c.audit_proposal_id],
          );
          if (!audit) {
            errors.push(
              `changes[${i}]: audit_proposal_id ${c.audit_proposal_id} not found`,
            );
          } else if (audit.workspace_id !== workspaceId) {
            errors.push(
              `changes[${i}]: audit_proposal_id ${c.audit_proposal_id} belongs to a different workspace`,
            );
          } else if (audit.status !== 'accepted') {
            errors.push(
              `changes[${i}]: audit_proposal_id ${c.audit_proposal_id} is '${audit.status}', not 'accepted' — pending or rejected audits are not evidence`,
            );
          }
        }
        if (c.commit_sha && !/^[0-9a-f]{7,40}$/i.test(c.commit_sha)) {
          errors.push(`changes[${i}]: commit_sha must be 7-40 hex chars`);
        }
        if (c.pr_url) {
          try {
            new URL(c.pr_url);
          } catch {
            errors.push(`changes[${i}]: pr_url must be a valid URL`);
          }
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
  let planSuggestions: Record<string, unknown> | null = null;
  if (row.plan_suggestions) {
    try { planSuggestions = JSON.parse(row.plan_suggestions) as Record<string, unknown>; } catch { /* leave null */ }
  }
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    trigger_text: row.trigger_text,
    trigger_kind: row.trigger_kind,
    impact_md: row.impact_md,
    proposed_changes: parsed,
    plan_suggestions: planSuggestions,
    status: row.status,
    applied_at: row.applied_at,
    applied_by_agent_id: row.applied_by_agent_id,
    parent_proposal_id: row.parent_proposal_id,
    target_initiative_id: row.target_initiative_id ?? null,
    dispatch_state: (row.dispatch_state ?? 'agent_complete') as PmProposalDispatchState,
    reverts_proposal_id: row.reverts_proposal_id ?? null,
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
  plan_suggestions?: Record<string, unknown> | null;
  parent_proposal_id?: string | null;
  target_initiative_id?: string | null;
  /** Defaults to 'agent_complete' (current behavior). Pass 'pending_agent'
   *  when persisting a synth placeholder while the named-agent dispatch
   *  is still in flight (Tier 3 of pm-dispatch-async). */
  dispatch_state?: PmProposalDispatchState;
  /** Slice 1 of revertable proposals: when this draft is the inverse of
   *  another accepted proposal, point back at it so the timeline can
   *  render a chain. Slice 2 wires the inverse synthesis. */
  reverts_proposal_id?: string | null;
}

/**
 * Walk the proposed changes and return the single initiative_id they
 * all converge on, if any. Used by `createProposal` to auto-populate
 * `target_initiative_id` so list-view affordances ("this initiative
 * has a pending PM proposal") can do an indexed lookup instead of
 * scanning the JSON blob.
 *
 * Strict by design: every diff must contribute the same initiative id.
 * A single initiative-agnostic diff (add_availability, remove_dependency,
 * reorder_initiatives, set_task_status) means the proposal isn't really
 * "about" one initiative, and we don't want to auto-link it — the FK is
 * `ON DELETE CASCADE`, so a wrong link can vaporize a multi-purpose
 * proposal when an unrelated initiative is deleted.
 */
export function inferTargetInitiativeId(changes: PmDiff[]): string | null {
  if (changes.length === 0) return null;
  const ids = new Set<string>();
  for (const c of changes) {
    let id: string | undefined;
    switch (c.kind) {
      case 'shift_initiative_target':
      case 'set_initiative_status':
      case 'add_dependency':
      case 'update_status_check':
      case 'create_task_under_initiative':
        id = c.initiative_id;
        break;
      case 'create_child_initiative':
        id = c.parent_initiative_id;
        break;
      default:
        // Initiative-agnostic kind (add_availability, remove_dependency,
        // reorder_initiatives, set_task_status) — bail out, proposal
        // stays untargeted.
        return null;
    }
    // Placeholder ids ($N) reference siblings created in the same
    // proposal; they don't anchor the target.
    if (!id || id.startsWith('$')) return null;
    ids.add(id);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

export function createProposal(input: CreateProposalInput): PmProposal {
  if (!input.workspace_id) throw new PmProposalValidationError('workspace_id required');
  if (!input.trigger_text) throw new PmProposalValidationError('trigger_text required');
  if (typeof input.impact_md !== 'string') {
    throw new PmProposalValidationError('impact_md required');
  }

  const errors = validateProposedChanges(
    input.workspace_id,
    input.proposed_changes ?? [],
    { trigger_kind: input.trigger_kind ?? 'manual' },
  );
  if (errors.length > 0) {
    throw new PmProposalValidationError(
      `Invalid proposed_changes: ${errors.length} error(s)`,
      errors,
    );
  }

  // Fall back to inferring a single-initiative target from the diff so
  // the initiative list can render a "pending PM proposal" chip without
  // scanning the proposed_changes JSON. Caller-supplied value wins.
  const resolvedTargetId =
    input.target_initiative_id ?? inferTargetInitiativeId(input.proposed_changes ?? []);

  const id = uuidv4();
  const now = new Date().toISOString();
  run(
    `INSERT INTO pm_proposals (
       id, workspace_id, trigger_text, trigger_kind, impact_md,
       proposed_changes, plan_suggestions, status, parent_proposal_id, target_initiative_id, dispatch_state, reverts_proposal_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspace_id,
      input.trigger_text,
      input.trigger_kind ?? 'manual',
      input.impact_md,
      JSON.stringify(input.proposed_changes ?? []),
      input.plan_suggestions != null ? JSON.stringify(input.plan_suggestions) : null,
      input.parent_proposal_id ?? null,
      resolvedTargetId,
      input.dispatch_state ?? 'agent_complete',
      input.reverts_proposal_id ?? null,
      now,
    ],
  );
  return getProposal(id)!;
}

/**
 * Update a draft's dispatch_state. Used by the late-arrival reconciler
 * (Tier 2/3 of pm-dispatch-async) when an agent's `propose_changes` lands
 * after the synth placeholder was persisted.
 */
export function setDispatchState(id: string, state: PmProposalDispatchState): void {
  run(`UPDATE pm_proposals SET dispatch_state = ? WHERE id = ?`, [state, id]);
}

/**
 * Hard-delete a proposal row. Used when a synth placeholder was created
 * speculatively but the dispatch resolved as a Mode B conversational
 * reply with 0 actionable changes — the placeholder is pure noise on
 * the recents list, so we drop it rather than leave a dangling
 * "0 changes / dispatch_state=synth_only" row. Only safe when no
 * downstream rows reference this proposal_id (no acceptance, no chat
 * post tied to it). Caller verifies the row's state first.
 */
export function deleteProposal(id: string): void {
  run(`DELETE FROM pm_proposals WHERE id = ?`, [id]);
}

/**
 * Per-status counts for a workspace's pm_proposals. Drives the
 * "Delete all rejected/draft/superseded" panel modal — operator sees
 * how many rows each checkbox would remove before confirming.
 */
export type PmProposalStatusCounts = Record<PmProposalStatus, number>;

export function countProposalsByStatus(workspaceId: string): PmProposalStatusCounts {
  const rows = queryAll<{ status: PmProposalStatus; n: number }>(
    `SELECT status, COUNT(*) AS n
       FROM pm_proposals
      WHERE workspace_id = ?
      GROUP BY status`,
    [workspaceId],
  );
  const out: PmProposalStatusCounts = {
    draft: 0,
    accepted: 0,
    rejected: 0,
    superseded: 0,
  };
  for (const r of rows) {
    if (r.status in out) out[r.status] = r.n;
  }
  return out;
}

/**
 * Bulk hard-delete every proposal in `workspaceId` whose status is in
 * `statuses`. Refuses to touch `accepted` rows for the same reason as
 * the single-row DELETE endpoint (their diffs already mutated other
 * tables, and history rows reference their ids). Returns the ids that
 * were actually deleted so the caller can broadcast individual SSE
 * events.
 */
export function bulkDeleteProposalsByStatus(
  workspaceId: string,
  statuses: PmProposalStatus[],
): string[] {
  const safe = statuses.filter(s => s !== 'accepted');
  if (safe.length === 0) return [];
  const placeholders = safe.map(() => '?').join(',');
  const rows = queryAll<{ id: string }>(
    `SELECT id FROM pm_proposals
      WHERE workspace_id = ?
        AND status IN (${placeholders})`,
    [workspaceId, ...safe],
  );
  if (rows.length === 0) return [];
  run(
    `DELETE FROM pm_proposals
      WHERE workspace_id = ?
        AND status IN (${placeholders})`,
    [workspaceId, ...safe],
  );
  return rows.map(r => r.id);
}

/**
 * Mark a row as superseded by another. Used when the agent's `propose_changes`
 * lands after a synth placeholder was already persisted: the synth row is
 * superseded, and the agent's row inherits the synth row's
 * `target_initiative_id` / `trigger_kind` and points at it via
 * `parent_proposal_id`.
 */
export function supersedeWithAgentProposal(
  synthRowId: string,
  agentRowId: string,
  intent: { trigger_kind: PmProposalTriggerKind; target_initiative_id?: string | null },
): void {
  const db = getDb();
  db.transaction(() => {
    // Inherit the placeholder's trigger_text onto the agent's row. The
    // placeholder carries the structured JSON envelope MC built (e.g.
    // `{ mode: 'decompose_initiative', initiative_id: '…' }`), which is
    // what the resume/lookup endpoints (e.g.
    // `GET /api/pm/decompose-initiative?initiative_id=…`) filter on via
    // `json_extract(trigger_text, '$.initiative_id')`. The agent's
    // freeform `trigger_text` from `propose_changes` doesn't carry that
    // shape, so without copying we lose the link and the panel can't
    // refetch after supersede.
    const synthRow = queryOne<{ trigger_text: string | null }>(
      `SELECT trigger_text FROM pm_proposals WHERE id = ?`,
      [synthRowId],
    );
    run(`UPDATE pm_proposals SET status = 'superseded' WHERE id = ?`, [synthRowId]);
    const sets: string[] = ['parent_proposal_id = ?', 'trigger_kind = ?', 'dispatch_state = ?'];
    const vals: unknown[] = [synthRowId, intent.trigger_kind, 'agent_complete'];
    if (intent.target_initiative_id) {
      sets.push('target_initiative_id = ?');
      vals.push(intent.target_initiative_id);
    }
    if (synthRow?.trigger_text) {
      sets.push('trigger_text = ?');
      vals.push(synthRow.trigger_text);
    }
    vals.push(agentRowId);
    run(`UPDATE pm_proposals SET ${sets.join(', ')} WHERE id = ?`, vals);
  })();
}

/**
 * Retroactively link a freshly-created agent proposal to any orphaned
 * synth placeholder from the same dispatch.
 *
 * Why: pm-dispatch fires a synth placeholder, dispatches the named PM
 * agent, and waits with a primary timeout + tail-window reconciler for
 * the agent's `propose_changes` row to land — at which point
 * `supersedeWithAgentProposal` links them and broadcasts
 * `pm_proposal_replaced`. Under heavy ML-server load the agent's tool
 * call can land AFTER both windows elapse, leaving the placeholder
 * stuck in `synth_only` and the agent row floating without a
 * `parent_proposal_id`. The UI never swaps the card and the operator
 * sees an empty "0 changes" placeholder.
 *
 * This function is the self-healing fallback: when the MCP
 * `propose_changes` handler finishes inserting the agent row, it calls
 * us, we look for a matching orphan placeholder within a recent
 * window, and we adopt it atomically. The in-flight reconciler is a
 * fast path; this is the correctness fallback.
 *
 * Returns the placeholder id that was adopted (so the caller can
 * broadcast `pm_proposal_replaced`), or null when no match was found
 * or another writer beat us to the supersede.
 *
 * Match key:
 *   - same workspace_id
 *   - same trigger_kind
 *   - placeholder status='draft', dispatch_state='synth_only',
 *     parent_proposal_id IS NULL (i.e. genuinely orphaned)
 *   - placeholder.created_at within `windowMs` of the agent row
 *   - excludes self
 *
 * The pm-dispatch registry only allows one in-flight dispatch per
 * workspace, so the most-recent matching orphan is unambiguously the
 * one this agent row belongs to.
 */
export function tryAdoptOrphanedPlaceholder(
  agentProposalId: string,
  windowMs: number = 10 * 60 * 1000,
): string | null {
  const agentRow = queryOne<{
    workspace_id: string;
    trigger_kind: PmProposalTriggerKind;
    created_at: string;
  }>(
    `SELECT workspace_id, trigger_kind, created_at FROM pm_proposals WHERE id = ?`,
    [agentProposalId],
  );
  if (!agentRow) return null;

  const earliestMs = new Date(agentRow.created_at).getTime() - windowMs;
  const earliestIso = new Date(earliestMs).toISOString();

  const candidate = queryOne<{ id: string; trigger_text: string | null; target_initiative_id: string | null }>(
    `SELECT id, trigger_text, target_initiative_id FROM pm_proposals
      WHERE workspace_id = ?
        AND trigger_kind = ?
        AND status = 'draft'
        AND dispatch_state = 'synth_only'
        AND parent_proposal_id IS NULL
        AND id != ?
        AND created_at >= ?
        AND created_at <= ?
      ORDER BY created_at DESC
      LIMIT 1`,
    [
      agentRow.workspace_id,
      agentRow.trigger_kind,
      agentProposalId,
      earliestIso,
      agentRow.created_at,
    ],
  );
  if (!candidate) return null;

  const db = getDb();
  let adopted = false;
  db.transaction(() => {
    // Atomic claim: only mark superseded if the placeholder is still
    // an orphan. If a concurrent reconciler already linked it, the
    // UPDATE matches zero rows and we bail without touching the agent
    // row.
    const stmt = db.prepare(
      `UPDATE pm_proposals
          SET status = 'superseded'
        WHERE id = ?
          AND status = 'draft'
          AND dispatch_state = 'synth_only'
          AND parent_proposal_id IS NULL`,
    );
    const info = stmt.run(candidate.id);
    if (info.changes !== 1) return;

    const sets: string[] = ['parent_proposal_id = ?', 'dispatch_state = ?'];
    const vals: unknown[] = [candidate.id, 'agent_complete'];
    if (candidate.target_initiative_id) {
      sets.push('target_initiative_id = ?');
      vals.push(candidate.target_initiative_id);
    }
    if (candidate.trigger_text) {
      sets.push('trigger_text = ?');
      vals.push(candidate.trigger_text);
    }
    vals.push(agentProposalId);
    run(`UPDATE pm_proposals SET ${sets.join(', ')} WHERE id = ?`, vals);
    adopted = true;
  })();

  return adopted ? candidate.id : null;
}

/**
 * Boot-time sweep: find orphaned synth placeholders that have a
 * matching agent-authored row already in the DB, and link them via
 * `tryAdoptOrphanedPlaceholder`. Idempotent.
 *
 * Used by the Next.js instrumentation hook to heal orphans left by a
 * prior process that crashed mid-dispatch or where the agent's tool
 * call landed after the reconciler had already given up. Returns the
 * number of placeholders successfully adopted.
 *
 * The reverse-lookup (agent row → orphan placeholder) is what
 * `tryAdoptOrphanedPlaceholder` already implements, so the sweep
 * iterates candidate agent rows and delegates.
 */
export function sweepOrphanedPlaceholders(): number {
  // Bound the lookback so a long-running DB with thousands of rows
  // doesn't scan everything. 24h covers any realistic gap between
  // dispatch and boot (the orphan window inside
  // tryAdoptOrphanedPlaceholder is 10m by default, but a placeholder
  // that's been orphaned for hours is still a candidate as long as
  // its agent row was created shortly after).
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const candidates = queryAll<{ id: string }>(
    `SELECT a.id
       FROM pm_proposals a
       JOIN pm_proposals p
         ON p.workspace_id = a.workspace_id
        AND p.trigger_kind = a.trigger_kind
        AND p.status = 'draft'
        AND p.dispatch_state = 'synth_only'
        AND p.parent_proposal_id IS NULL
        AND p.id != a.id
        AND p.created_at <= a.created_at
      WHERE a.dispatch_state = 'agent_complete'
        AND a.parent_proposal_id IS NULL
        AND a.created_at >= ?
      GROUP BY a.id`,
    [cutoff],
  );

  let linked = 0;
  for (const { id } of candidates) {
    try {
      // Use a wider window for the sweep than the live path — agent
      // and placeholder may be hours apart in a long-orphan scenario.
      const adopted = tryAdoptOrphanedPlaceholder(id, 24 * 60 * 60 * 1000);
      if (adopted) linked += 1;
    } catch (err) {
      console.warn(
        `[sweepOrphanedPlaceholders] adopt failed for agent row ${id}:`,
        (err as Error).message,
      );
    }
  }
  return linked;
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
  /**
   * Indexes that were skipped because the operator unchecked them in
   * the partial-accept flow. Mirrors `accepted_indexes` in the request:
   * any index in `proposed_changes` that wasn't in the input is here.
   * Empty array = full accept (or back-compat call without filter).
   */
  rejected_indexes: number[];
}

export interface AcceptProposalOptions {
  /**
   * Subset of `proposed_changes` indexes to apply. When omitted, every
   * diff applies (full accept — back-compat). When provided, only the
   * listed indexes apply; the rest are dropped silently. Cross-diff
   * placeholder references (a `create_task_under_initiative` whose
   * `initiative_id` is a placeholder for a NOT-selected
   * `create_child_initiative`) trigger a validation error before any
   * write happens.
   */
  accepted_indexes?: ReadonlyArray<number>;
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
  options: AcceptProposalOptions = {},
): AcceptProposalResult {
  const existing = getProposal(id);
  if (!existing) throw new PmProposalValidationError(`proposal ${id} not found`);

  if (existing.status === 'accepted') {
    return {
      proposal: existing,
      changes_applied: 0,
      idempotent_noop: true,
      rejected_indexes: [],
    };
  }
  if (existing.status === 'rejected' || existing.status === 'superseded') {
    throw new PmProposalValidationError(
      `proposal ${id} cannot be accepted from status=${existing.status}`,
    );
  }

  // Resolve the index filter once, up front. `null` means "apply all"
  // (back-compat). `Set<number>` lets the apply loop cheaply skip
  // unselected diffs while preserving the diff-array's natural index.
  const filter: Set<number> | null = options.accepted_indexes
    ? new Set(
        options.accepted_indexes.filter(
          (i) => i >= 0 && i < existing.proposed_changes.length,
        ),
      )
    : null;

  // Cross-diff placeholder safety: a selected `create_task_under_initiative`
  // referring to `$N` (or a custom `placeholder_id`) requires the
  // referenced `create_child_initiative` to also be selected. Catch
  // before any write so the proposal isn't half-applied.
  if (filter) {
    const placeholderToOwner = new Map<string, number>();
    for (let idx = 0; idx < existing.proposed_changes.length; idx++) {
      const c = existing.proposed_changes[idx];
      if (c.kind === 'create_child_initiative') {
        placeholderToOwner.set(`$${idx}`, idx);
        if (c.placeholder_id) placeholderToOwner.set(c.placeholder_id, idx);
      }
    }
    for (let idx = 0; idx < existing.proposed_changes.length; idx++) {
      if (!filter.has(idx)) continue;
      const c = existing.proposed_changes[idx];
      if (c.kind !== 'create_task_under_initiative') continue;
      const refIdx = placeholderToOwner.get(c.initiative_id);
      if (refIdx !== undefined && !filter.has(refIdx)) {
        throw new PmProposalValidationError(
          `changes[${idx}]: create_task_under_initiative refers to placeholder "${c.initiative_id}" but the create_child_initiative at index ${refIdx} is not in the accepted set. Either accept both or neither.`,
        );
      }
    }
    // Same check for create_child_initiative diffs that depend on other
    // placeholders — accepting a child whose dep is unselected is
    // unrecoverable at apply time.
    for (let idx = 0; idx < existing.proposed_changes.length; idx++) {
      if (!filter.has(idx)) continue;
      const c = existing.proposed_changes[idx];
      if (c.kind !== 'create_child_initiative') continue;
      for (const rawRef of c.depends_on_initiative_ids ?? []) {
        if (!rawRef.startsWith('$')) continue;
        const refIdx = placeholderToOwner.get(rawRef);
        if (refIdx !== undefined && !filter.has(refIdx)) {
          throw new PmProposalValidationError(
            `changes[${idx}]: create_child_initiative depends on placeholder "${rawRef}" but the source diff at index ${refIdx} is not in the accepted set.`,
          );
        }
      }
    }
  }

  // Re-validate against current DB state — initiatives could've been
  // deleted between draft and accept.
  const errors = validateProposedChanges(
    existing.workspace_id,
    existing.proposed_changes,
    { trigger_kind: existing.trigger_kind },
  );
  if (errors.length > 0) {
    throw new PmProposalValidationError(
      `Cannot apply proposal ${id}: ${errors.length} validation error(s)`,
      errors,
    );
  }

  const db = getDb();
  let changesApplied = 0;
  const now = new Date().toISOString();

  // plan_initiative is advisory: no DB writes other than flipping the
  // proposal row to 'accepted'. The operator applies the suggestions
  // client-side by populating the create-initiative form. Keeps the
  // refine + audit chain intact without touching real state.
  const isAdvisory = existing.trigger_kind === 'plan_initiative';

  db.transaction(() => {
    if (!isAdvisory) {
      // Build placeholder→real id map for cross-sibling dep resolution
      // (used by create_child_initiative diffs in decompose flows).
      const placeholderMap = new Map<string, string>();
      // First pass: insert children, populate the map.
      for (let idx = 0; idx < existing.proposed_changes.length; idx++) {
        if (filter && !filter.has(idx)) continue;
        const change = existing.proposed_changes[idx];
        if (change.kind === 'create_child_initiative') {
          const newId = applyCreateChildInitiative(
            existing.workspace_id,
            change,
            now,
            applied_by_agent_id,
            id,
          );
          // Capture the new initiative id back onto the diff so revert
          // can target the right row without recomputing.
          change.created_initiative_id = newId;
          // Two index forms accepted: explicit `placeholder_id` field or
          // ordinal `$N` based on diff position.
          placeholderMap.set(`$${idx}`, newId);
          if (change.placeholder_id) {
            placeholderMap.set(change.placeholder_id, newId);
          }
          changesApplied++;
        }
      }
      // Second pass: dep edges + task creation (placeholder-aware) + remaining diffs.
      for (let idx = 0; idx < existing.proposed_changes.length; idx++) {
        if (filter && !filter.has(idx)) continue;
        const change = existing.proposed_changes[idx];
        if (change.kind === 'create_child_initiative') {
          // Resolve dep placeholders against the freshly-built map and
          // create dependency edges.
          const childId = placeholderMap.get(`$${idx}`);
          if (childId && Array.isArray(change.depends_on_initiative_ids)) {
            for (const rawRef of change.depends_on_initiative_ids) {
              const realRef = rawRef.startsWith('$')
                ? placeholderMap.get(rawRef)
                : rawRef;
              if (!realRef) {
                throw new PmProposalValidationError(
                  `create_child_initiative: unresolved placeholder dep "${rawRef}"`,
                );
              }
              run(
                `INSERT INTO initiative_dependencies (id, initiative_id, depends_on_initiative_id, kind, note, created_at)
                 VALUES (?, ?, ?, 'finish_to_start', ?, ?)`,
                [uuidv4(), childId, realRef, null, now],
              );
            }
          }
          continue;
        }
        if (change.kind === 'create_task_under_initiative') {
          // Try the placeholder map first ($N or custom placeholder_id
          // from a same-proposal create_child_initiative); fall back to
          // the literal id for existing initiatives.
          const mapped = placeholderMap.get(change.initiative_id);
          const realInit = mapped ?? (change.initiative_id.startsWith('$')
            ? undefined
            : change.initiative_id);
          if (!realInit) {
            throw new PmProposalValidationError(
              `create_task_under_initiative: unresolved placeholder "${change.initiative_id}"`,
            );
          }
          const created = createTaskFromInitiative({
            initiative_id: realInit,
            workspace_id: existing.workspace_id,
            title: change.title,
            description: change.description ?? null,
            status_check_md: change.status_check_md ?? null,
            assigned_agent_id: change.assigned_agent_id || null,
            priority: change.priority ?? 'normal',
            created_by_agent_id: applied_by_agent_id,
            reason: `created via PM notes proposal #${id}`,
          });
          // Capture the new task id so revert can cancel that exact row.
          change.created_task_id = created.id;
          changesApplied++;
          continue;
        }
        if (change.kind === 'confirm_task_done') {
          const before = queryOne<{ status: string }>(
            'SELECT status FROM tasks WHERE id = ?',
            [change.task_id],
          );
          if (!before) {
            throw new PmProposalValidationError(
              `confirm_task_done: task ${change.task_id} not found`,
            );
          }
          // Capture for revert before we transition.
          change.prev_task_status = before.status;
          const reasonExcerpt = change.evidence_md.slice(0, 200);
          const result = transitionTaskStatus({
            taskId: change.task_id,
            actingAgentId: applied_by_agent_id ?? null,
            newStatus: 'done',
            statusReason: `PM confirm_task_done — ${reasonExcerpt}`,
          });
          if (!result.ok) {
            throw new PmProposalValidationError(
              `confirm_task_done(${change.task_id}): ${result.error}`,
            );
          }
          run(
            `INSERT INTO events (id, type, agent_id, task_id, message, metadata, created_at)
             VALUES (?, 'task_status_attested_done', ?, ?, ?, ?, ?)`,
            [
              uuidv4(),
              applied_by_agent_id ?? null,
              change.task_id,
              `Task confirmed done via PM proposal ${id}`,
              JSON.stringify({
                proposal_id: id,
                audit_proposal_id: change.audit_proposal_id ?? null,
                commit_sha: change.commit_sha ?? null,
                pr_url: change.pr_url ?? null,
              }),
              now,
            ],
          );
          changesApplied++;
          continue;
        }
        applyDiff(change, now);
        changesApplied++;
      }
    }

    // Persist the augmented proposed_changes JSON. The apply path above
    // mutated each diff in place to add capture state (prev_status,
    // created_dependency_id, etc.) — write that back so Slice 2's
    // invertDiff can synthesize a pure-function revert from the row alone.
    // Skipped on the advisory path since no diffs ran.
    if (!isAdvisory) {
      run(
        `UPDATE pm_proposals SET proposed_changes = ? WHERE id = ?`,
        [JSON.stringify(existing.proposed_changes), id],
      );
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
  const rejected_indexes = filter
    ? existing.proposed_changes
        .map((_, idx) => idx)
        .filter((idx) => !filter.has(idx))
    : [];
  return {
    proposal: updated,
    changes_applied: changesApplied,
    idempotent_noop: false,
    rejected_indexes,
  };
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
      // Capture the previous targets BEFORE the UPDATE so revert can
      // restore them without recomputing from drifted DB state.
      const prev = queryOne<{ target_start: string | null; target_end: string | null }>(
        `SELECT target_start, target_end FROM initiatives WHERE id = ?`,
        [diff.initiative_id],
      );
      if (prev) {
        diff.prev_target_start = prev.target_start ?? null;
        diff.prev_target_end = prev.target_end ?? null;
      }
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
      const newId = uuidv4();
      run(
        `INSERT INTO owner_availability (id, agent_id, unavailable_start, unavailable_end, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [newId, diff.agent_id, diff.start, diff.end, diff.reason ?? null, now],
      );
      diff.created_availability_id = newId;
      return;
    }
    case 'set_initiative_status': {
      // Capture previous status so revert can restore it. The PM may
      // propose any of the 6 InitiativeStatus values, and the row may
      // already be in any of them — `prev_status` covers all six.
      const prev = queryOne<{ status: PmDiffCapture['prev_status'] }>(
        `SELECT status FROM initiatives WHERE id = ?`,
        [diff.initiative_id],
      );
      if (prev) diff.prev_status = prev.status;
      run(
        `UPDATE initiatives SET status = ?, updated_at = ? WHERE id = ?`,
        [diff.status, now, diff.initiative_id],
      );
      return;
    }
    case 'add_dependency': {
      const newId = uuidv4();
      try {
        run(
          `INSERT INTO initiative_dependencies (id, initiative_id, depends_on_initiative_id, kind, note, created_at)
           VALUES (?, ?, ?, 'finish_to_start', ?, ?)`,
          [newId, diff.initiative_id, diff.depends_on_initiative_id, diff.note ?? null, now],
        );
        diff.created_dependency_id = newId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // SQLite throws SQLITE_CONSTRAINT_UNIQUE on duplicate edges. Treat
        // as idempotent — the desired state already exists. Resolve and
        // capture the existing edge's id so revert still works.
        if (/UNIQUE constraint failed/i.test(msg)) {
          const existing = queryOne<{ id: string }>(
            `SELECT id FROM initiative_dependencies
              WHERE initiative_id = ? AND depends_on_initiative_id = ?`,
            [diff.initiative_id, diff.depends_on_initiative_id],
          );
          if (existing) diff.created_dependency_id = existing.id;
          return;
        }
        throw err;
      }
      return;
    }
    case 'remove_dependency': {
      // Snapshot the row BEFORE delete so revert can re-insert the
      // identical edge. We capture the full row (including original id +
      // created_at) — Slice 2's invertDiff will reuse the id when it
      // re-inserts so any references stay valid.
      const row = queryOne<{
        id: string;
        initiative_id: string;
        depends_on_initiative_id: string;
        kind: string;
        note: string | null;
        created_at: string;
      }>(
        `SELECT id, initiative_id, depends_on_initiative_id, kind, note, created_at
           FROM initiative_dependencies WHERE id = ?`,
        [diff.dependency_id],
      );
      if (row) diff.removed_dependency_row = row;
      run(`DELETE FROM initiative_dependencies WHERE id = ?`, [diff.dependency_id]);
      return;
    }
    case 'reorder_initiatives': {
      // Snapshot the prior order of these siblings BEFORE the UPDATE so
      // revert restores the exact previous arrangement. We only capture
      // the ids the diff is touching — siblings outside that set keep
      // their existing sort_order through both apply and revert.
      const placeholders = diff.child_ids_in_order.map(() => '?').join(',');
      const prevRows = queryAll<{ id: string; sort_order: number }>(
        `SELECT id, sort_order FROM initiatives WHERE id IN (${placeholders}) ORDER BY sort_order ASC`,
        diff.child_ids_in_order,
      );
      diff.prev_child_ids_in_order = prevRows.map(r => r.id);
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
      const prev = queryOne<{ status_check_md: string | null }>(
        `SELECT status_check_md FROM initiatives WHERE id = ?`,
        [diff.initiative_id],
      );
      if (prev) diff.prev_status_check_md = prev.status_check_md ?? null;
      run(
        `UPDATE initiatives SET status_check_md = ?, updated_at = ? WHERE id = ?`,
        [diff.status_check_md, now, diff.initiative_id],
      );
      return;
    }
    case 'create_child_initiative': {
      // Handled out-of-band in acceptProposal so cross-sibling dep
      // placeholders can resolve in a second pass. Reaching this branch
      // is a programming error.
      throw new Error('create_child_initiative must be applied via applyCreateChildInitiative');
    }
    case 'create_task_under_initiative': {
      // Same out-of-band pattern: handled in acceptProposal so
      // initiative_id placeholders can resolve from the same proposal.
      throw new Error('create_task_under_initiative must be applied via acceptProposal pass-2');
    }
    case 'set_task_status': {
      const prev = queryOne<{ status: string }>(
        `SELECT status FROM tasks WHERE id = ?`,
        [diff.task_id],
      );
      if (prev) diff.prev_task_status = prev.status;
      run(
        `UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`,
        [diff.status, now, diff.task_id],
      );
      return;
    }
    case 'confirm_task_done': {
      // Handled out-of-band in acceptProposal so it can route through
      // transitionTaskStatus (workflow gates). Reaching this branch is
      // a programming error.
      throw new Error('confirm_task_done must be applied via acceptProposal pass-2');
    }
    default: {
      const exhaustive: never = diff;
      throw new Error(`Unknown diff kind: ${(exhaustive as { kind?: string }).kind ?? '?'}`);
    }
  }
}

/**
 * Apply one `create_child_initiative` diff. Inserts the initiative row,
 * appends an `initiative_parent_history` audit row, and returns the new
 * id so the caller can wire dep placeholders post-hoc.
 *
 * Caller wraps in a transaction — same pattern as `applyDiff`.
 */
function applyCreateChildInitiative(
  workspace_id: string,
  diff: Extract<PmDiff, { kind: 'create_child_initiative' }>,
  now: string,
  applied_by_agent_id: string | null,
  proposal_id: string,
): string {
  const childId = uuidv4();
  run(
    `INSERT INTO initiatives (
       id, workspace_id, parent_initiative_id, kind, title, description,
       status, complexity, estimated_effort_hours, sort_order,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?)`,
    [
      childId,
      workspace_id,
      diff.parent_initiative_id,
      diff.child_kind,
      diff.title,
      diff.description ?? null,
      diff.complexity ?? null,
      diff.estimated_effort_hours ?? null,
      diff.sort_order ?? 0,
      now,
      now,
    ],
  );
  run(
    `INSERT INTO initiative_parent_history (
       id, initiative_id, from_parent_id, to_parent_id, moved_by_agent_id, reason, created_at
     ) VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    [
      uuidv4(),
      childId,
      diff.parent_initiative_id,
      applied_by_agent_id,
      `created via PM decompose proposal #${proposal_id}`,
      now,
    ],
  );
  return childId;
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
  /**
   * False when an existing draft child for this parent was returned
   * instead of creating a new one (server-side dedupe of double-fires —
   * client-side disable guards aren't sufficient when the route hangs
   * 60–180s on `await dispatch.completion` and the operator clicks
   * again). The caller must skip the dispatch step in that case to
   * avoid layering a second in-flight LLM run on the same slot.
   */
  created: boolean;
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
 *
 * Dedupe: if a draft child of `parentId` already exists, return it
 * (`created: false`). The refine route's `await dispatch.completion`
 * stalls 60–180s, and a second submit during that window otherwise
 * creates a second `_(refining…)_` slot that never settles.
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

  const existingDraft = queryOne<{ id: string }>(
    `SELECT id FROM pm_proposals
       WHERE parent_proposal_id = ? AND status = 'draft'
       ORDER BY created_at DESC LIMIT 1`,
    [parentId],
  );
  if (existingDraft) {
    return {
      parent,
      child: getProposal(existingDraft.id)!,
      created: false,
    };
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
         proposed_changes, status, parent_proposal_id, target_initiative_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      [
        childId,
        parent.workspace_id,
        triggerText,
        parent.trigger_kind,
        '_(refining…)_',
        '[]',
        parentId,
        parent.target_initiative_id,
        now,
      ],
    );
  })();

  return { parent: getProposal(parentId)!, child: getProposal(childId)!, created: true };
}
