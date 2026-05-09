/**
 * Internal accept / reject helpers for the operator-facing proposal
 * queue (Phase 6, specs/subtree-audit-proposals-spec.md §8).
 *
 * Three callers:
 *   1. POST /accept       — single-proposal accept (with optional inline edits).
 *   2. POST /reject       — single-proposal reject with required reason.
 *   3. POST /bulk-accept  — server-gated multi-accept; reuses the same
 *                          internal helper so behavior matches accept-by-one.
 *
 * v1 only auto-applies these actions:
 *   keep | mark_done | cancel | modify_scope | modify_dates
 *
 * The cross-node and epic-level actions (merge_stories, split_story,
 * modify_epic_*, new_story) return an `unsupported` outcome — the
 * accept route surfaces that as 501 with the documented message; the
 * proposal stays unconsumed so the operator can still reject it.
 */

import { v4 as uuidv4 } from 'uuid';
import type { AgentNote } from '@/lib/db/agent-notes';
import {
  createNote,
  getNote,
  markNoteConsumed,
} from '@/lib/db/agent-notes';
import {
  getInitiative,
  updateInitiative,
  type Initiative,
} from '@/lib/db/initiatives';
import {
  auditProposalBodySchema,
  validateAuditNoteBody,
  type AuditProposalBody,
} from './schemas';
import {
  OPERATOR_REVIEW_ACCEPTED,
  OPERATOR_REVIEW_REJECTED,
  isProposalConsumedByOperator,
} from './operator-review';

// ─── Errors / outcomes ──────────────────────────────────────────────

export type AcceptOutcome =
  | {
      ok: true;
      target: Initiative;
      decisionNoteId: string;
      appliedAction: AuditProposalBody['proposed_action'];
      appliedChanges: unknown;
      editedByOperator: boolean;
    }
  | {
      ok: false;
      kind:
        | 'not_found'
        | 'already_consumed'
        | 'invalid_body'
        | 'invalid_overrides'
        | 'unsupported_action'
        | 'target_not_found'
        | 'mutation_failed';
      message: string;
    };

export interface AcceptOverrides {
  proposed_action?: AuditProposalBody['proposed_action'];
  proposed_changes?: Record<string, unknown>;
}

/**
 * Apply a single proposal acceptance. Used by both the per-proposal
 * accept route and the bulk-accept route — same code path keeps the
 * decision-note + consumption-mark semantics consistent.
 *
 * The `enforceLiveCheck` flag is true for the per-proposal route (the
 * operator clicked Accept on a card they could see) and true for bulk
 * (we re-check inside the loop because state may have shifted between
 * the queue render and the click). It exists because future call sites
 * (e.g. an automated accept rule) might want to bypass.
 */
export function acceptProposal(
  proposalId: string,
  overrides: AcceptOverrides | null,
): AcceptOutcome {
  const note = getNote(proposalId);
  if (!note || note.kind !== 'audit_proposal') {
    return { ok: false, kind: 'not_found', message: 'proposal not found' };
  }
  if (isProposalConsumedByOperator(note)) {
    return {
      ok: false,
      kind: 'already_consumed',
      message: 'proposal has already been accepted or rejected',
    };
  }
  const parsed = validateAuditNoteBody('audit_proposal', note.body);
  if (!parsed.ok) {
    return {
      ok: false,
      kind: 'invalid_body',
      message: `proposal body fails schema: ${parsed.error}`,
    };
  }
  const original = parsed.parsed as AuditProposalBody;

  // Apply operator overrides if any. We re-validate the merged shape
  // against the same Zod schema so an edited proposal can't bypass
  // the per-action invariants (e.g. mark_done requires a non-empty note).
  let effective: AuditProposalBody = original;
  let editedByOperator = false;
  if (overrides && (overrides.proposed_action || overrides.proposed_changes)) {
    editedByOperator = true;
    const merged = {
      ...original,
      ...(overrides.proposed_action
        ? { proposed_action: overrides.proposed_action }
        : {}),
      ...(overrides.proposed_changes !== undefined
        ? { proposed_changes: overrides.proposed_changes }
        : {}),
    };
    const validation = auditProposalBodySchema.safeParse(merged);
    if (!validation.success) {
      const issue = validation.error.issues[0];
      const path = issue?.path.length ? issue.path.join('.') : '<root>';
      return {
        ok: false,
        kind: 'invalid_overrides',
        message: `edited proposal fails schema — ${path}: ${issue?.message ?? 'unknown'}`,
      };
    }
    effective = validation.data;
  }

  // v1 auto-apply only handles per-node leaf actions. Cross-node /
  // epic-level actions are surfaced through synthesis sub-proposals
  // and need the v2 UX before we wire them through. Reject is still
  // available — operator records the decision; no mutation runs.
  const supportedActions = new Set<string>([
    'keep',
    'mark_done',
    'cancel',
    'modify_scope',
    'modify_dates',
  ]);
  if (!supportedActions.has(effective.proposed_action)) {
    return {
      ok: false,
      kind: 'unsupported_action',
      message:
        'epic-level and cross-node proposals require operator review in v2; this proposal cannot be auto-applied',
    };
  }

  const targetId = effective.node_initiative_id;
  const targetInit = getInitiative(targetId);
  if (!targetInit) {
    return {
      ok: false,
      kind: 'target_not_found',
      message: `target initiative ${targetId} not found`,
    };
  }

  // ── apply mutation ─────────────────────────────────────────────────
  let updated: Initiative;
  try {
    switch (effective.proposed_action) {
      case 'keep':
        // No-op. Decision note is the audit trail.
        updated = targetInit;
        break;
      case 'mark_done':
        updated = updateInitiative(targetId, { status: 'done' });
        break;
      case 'cancel':
        updated = updateInitiative(targetId, { status: 'cancelled' });
        break;
      case 'modify_scope': {
        const c = effective.proposed_changes;
        updated = updateInitiative(targetId, {
          ...(c.title !== undefined ? { title: c.title } : {}),
          ...(c.description !== undefined ? { description: c.description } : {}),
        });
        break;
      }
      case 'modify_dates': {
        const c = effective.proposed_changes;
        updated = updateInitiative(targetId, {
          ...(c.target_start !== undefined
            ? { target_start: c.target_start }
            : {}),
          ...(c.target_end !== undefined ? { target_end: c.target_end } : {}),
        });
        break;
      }
      default: {
        // Type-narrowing safety. Reach here only if a new action is
        // added to the schema without updating supportedActions.
        const exhaustive: never = effective;
        return {
          ok: false,
          kind: 'unsupported_action',
          message: `unsupported proposed_action: ${(exhaustive as AuditProposalBody).proposed_action}`,
        };
      }
    }
  } catch (err) {
    return {
      ok: false,
      kind: 'mutation_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // ── decision note ──────────────────────────────────────────────────
  const decisionBody = JSON.stringify({
    source_proposal_id: proposalId,
    accepted_at: new Date().toISOString(),
    applied_action: effective.proposed_action,
    applied_changes: effective.proposed_changes,
    edited_by_operator: editedByOperator,
  });
  const decisionNote = createNote({
    workspace_id: note.workspace_id,
    agent_id: null,
    initiative_id: targetId,
    scope_key: `initiative-${targetId}:operator-review:${uuidv4().slice(0, 8)}`,
    role: 'operator',
    run_group_id: uuidv4(),
    kind: 'decision',
    audience: 'pm',
    body: decisionBody,
    importance: 2,
  });

  markNoteConsumed(proposalId, OPERATOR_REVIEW_ACCEPTED);

  return {
    ok: true,
    target: updated,
    decisionNoteId: decisionNote.id,
    appliedAction: effective.proposed_action,
    appliedChanges: effective.proposed_changes,
    editedByOperator,
  };
}

// ─── Reject ─────────────────────────────────────────────────────────

export type RejectOutcome =
  | { ok: true; decisionNoteId: string; targetId: string }
  | {
      ok: false;
      kind: 'not_found' | 'already_consumed' | 'invalid_body';
      message: string;
    };

/**
 * Reject is plain — no mutation, just a decision note + mark consumed.
 * Reason is required.
 */
export function rejectProposal(
  proposalId: string,
  reason: string,
): RejectOutcome {
  const note = getNote(proposalId);
  if (!note || note.kind !== 'audit_proposal') {
    return { ok: false, kind: 'not_found', message: 'proposal not found' };
  }
  if (isProposalConsumedByOperator(note)) {
    return {
      ok: false,
      kind: 'already_consumed',
      message: 'proposal has already been accepted or rejected',
    };
  }
  // We tolerate body-validation failure on reject — the operator should
  // be able to clear malformed proposals out of the queue too.
  let targetId: string | null = null;
  const parsed = validateAuditNoteBody('audit_proposal', note.body);
  if (parsed.ok) {
    targetId = (parsed.parsed as AuditProposalBody).node_initiative_id;
  } else {
    targetId = note.initiative_id;
  }
  if (!targetId) {
    return {
      ok: false,
      kind: 'invalid_body',
      message: 'proposal has no resolvable target initiative',
    };
  }

  const decisionBody = JSON.stringify({
    source_proposal_id: proposalId,
    rejected_at: new Date().toISOString(),
    reason,
  });
  const decisionNote = createNote({
    workspace_id: note.workspace_id,
    agent_id: null,
    initiative_id: targetId,
    scope_key: `initiative-${targetId}:operator-review:${uuidv4().slice(0, 8)}`,
    role: 'operator',
    run_group_id: uuidv4(),
    kind: 'decision',
    audience: 'pm',
    body: decisionBody,
    importance: 1,
  });

  markNoteConsumed(proposalId, OPERATOR_REVIEW_REJECTED);

  return { ok: true, decisionNoteId: decisionNote.id, targetId };
}

// ─── Bulk-accept eligibility ────────────────────────────────────────

/**
 * Bulk-accept cohort: high-confidence keeps and mark_done's only. The
 * cheap, low-risk class. Anything else (modify_*, low/medium
 * confidence, unsupported actions) requires individual review.
 */
export function isBulkAcceptable(body: AuditProposalBody): boolean {
  if (body.confidence !== 'high') return false;
  if (body.proposed_action !== 'keep' && body.proposed_action !== 'mark_done') {
    return false;
  }
  return true;
}

/**
 * Convenience: count how many of a given proposal-list match the
 * bulk-accept cohort. Used by the UI badge "Accept N high-confidence
 * keeps".
 */
export function countBulkAcceptable(notes: AgentNote[]): number {
  let n = 0;
  for (const note of notes) {
    if (note.kind !== 'audit_proposal') continue;
    if (isProposalConsumedByOperator(note)) continue;
    const parsed = validateAuditNoteBody('audit_proposal', note.body);
    if (!parsed.ok) continue;
    if (isBulkAcceptable(parsed.parsed as AuditProposalBody)) n += 1;
  }
  return n;
}
