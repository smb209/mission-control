/**
 * Operator-review helpers for the audit-proposal queue (Phase 6 of
 * specs/subtree-audit-proposals-spec.md §8).
 *
 * Centralizes the stage-slug convention and the "is this proposal
 * already handled?" check so the aggregation endpoint, the accept /
 * reject handlers, and the bulk-accept handler all agree on what counts
 * as consumed.
 */

import type { AgentNote } from '@/lib/db/agent-notes';
import { parseConsumedStages } from '@/lib/db/agent-notes';

/** Stage slug recorded on `consumed_by_stages` when an operator accepts. */
export const OPERATOR_REVIEW_ACCEPTED = 'operator-review:accepted';
/** Stage slug recorded on `consumed_by_stages` when an operator rejects. */
export const OPERATOR_REVIEW_REJECTED = 'operator-review:rejected';

/**
 * True if the operator has already acted on this proposal (accept OR
 * reject). The proposal queue endpoint filters these out by default so
 * the queue only shows live work.
 */
export function isProposalConsumedByOperator(note: AgentNote): boolean {
  const stages = parseConsumedStages(note);
  return (
    stages.includes(OPERATOR_REVIEW_ACCEPTED) ||
    stages.includes(OPERATOR_REVIEW_REJECTED)
  );
}

/**
 * Bulk-accept gate. Server-side check on `MC_AUDIT_BULK_ACCEPT_ENABLED`.
 * Default OFF — when disabled, the bulk-accept endpoint behaves like it
 * doesn't exist (404) and the aggregation endpoint reports the feature
 * unavailable so the UI can hide the toolbar button.
 */
export function isBulkAcceptEnabled(): boolean {
  return process.env.MC_AUDIT_BULK_ACCEPT_ENABLED === 'true';
}
