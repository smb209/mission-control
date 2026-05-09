/**
 * POST /api/initiatives/:id/proposals/:proposalId/accept
 *
 * Accept a single audit_proposal — optionally with operator-supplied
 * inline edits to the action / changes. Routes through
 * `acceptProposal`, which:
 *   - validates (and re-validates after merging overrides)
 *   - applies the per-action mutation via updateInitiative
 *   - writes a `kind: 'decision'` note on the target node
 *   - marks the proposal `consumed_by_stages: 'operator-review:accepted'`
 *
 * Returns 200 with the new target initiative + decision note id, or:
 *   400 — invalid override body / target missing
 *   404 — proposal not found
 *   409 — proposal already consumed (raced with another operator click)
 *   501 — action is epic-level / cross-node (deferred to v2)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { acceptProposal } from '@/lib/agents/audit-proposals/operator-actions';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string; proposalId: string }>;
}

// Operator overrides: free-form record (we re-validate via the audit-
// proposal Zod schema after merging into the original body, so a
// permissive shape here is fine — the schema has the final word).
const AcceptSchema = z
  .object({
    proposed_action: z
      .enum(['keep', 'mark_done', 'cancel', 'modify_scope', 'modify_dates'])
      .optional(),
    proposed_changes: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  try {
    const { proposalId } = await params;
    const raw = await request.json().catch(() => ({}));
    const parsed = AcceptSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }

    const overrides =
      parsed.data.proposed_action || parsed.data.proposed_changes
        ? parsed.data
        : null;

    const outcome = acceptProposal(proposalId, overrides);
    if (!outcome.ok) {
      const status =
        outcome.kind === 'not_found' || outcome.kind === 'target_not_found'
          ? 404
          : outcome.kind === 'already_consumed'
            ? 409
            : outcome.kind === 'unsupported_action'
              ? 501
              : 400;
      return NextResponse.json(
        { error: outcome.message, kind: outcome.kind },
        { status },
      );
    }

    return NextResponse.json({
      ok: true,
      target: outcome.target,
      decision_note_id: outcome.decisionNoteId,
      applied_action: outcome.appliedAction,
      applied_changes: outcome.appliedChanges,
      edited_by_operator: outcome.editedByOperator,
    });
  } catch (error) {
    console.error('[proposals/accept] route error:', error);
    return NextResponse.json(
      { error: (error as Error).message ?? 'Internal server error' },
      { status: 500 },
    );
  }
}
