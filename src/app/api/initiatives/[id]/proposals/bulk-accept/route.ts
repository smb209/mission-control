/**
 * POST /api/initiatives/:id/proposals/bulk-accept
 *
 * Accept several audit_proposals at once. Server-gated behind the env
 * flag `MC_AUDIT_BULK_ACCEPT_ENABLED` — when unset / 'false' the route
 * returns 404 to mirror "feature does not exist" and let the UI's
 * `bulk_accept_available: false` state work uniformly.
 *
 * Each proposal is validated against the bulk-accept cohort
 * (high-confidence keep / mark_done, target node is this initiative or
 * an immediate descendant). Failures don't abort — the response carries
 * a `failed` array with per-id errors so partial successes still land.
 *
 * Spec: §8 ("Bulk accept for proposals at confidence: high and
 * proposed_action ∈ {keep, mark_done}").
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  acceptProposal,
  isBulkAcceptable,
} from '@/lib/agents/audit-proposals/operator-actions';
import {
  isBulkAcceptEnabled,
  isProposalConsumedByOperator,
} from '@/lib/agents/audit-proposals/operator-review';
import { getNote } from '@/lib/db/agent-notes';
import { getInitiative, listInitiatives } from '@/lib/db/initiatives';
import {
  validateAuditNoteBody,
  type AuditProposalBody,
} from '@/lib/agents/audit-proposals/schemas';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

const BulkAcceptSchema = z.object({
  proposal_ids: z.array(z.string().min(1)).min(1).max(100),
});

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  // Server gate. UI hides the toolbar via `bulk_accept_available` from
  // the aggregation endpoint, so a 404 here is also a defensible fallback
  // for stale clients hitting a flag that's been turned off.
  if (!isBulkAcceptEnabled()) {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  }

  try {
    const { id } = await params;
    const raw = await request.json().catch(() => ({}));
    const parsed = BulkAcceptSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }

    const root = getInitiative(id);
    if (!root) {
      return NextResponse.json(
        { error: 'Initiative not found' },
        { status: 404 },
      );
    }

    // Build the allowed-target set: this initiative + immediate
    // children. Same scope as the aggregation endpoint's "descendants
    // = self + children" rule.
    const children = listInitiatives({
      workspace_id: root.workspace_id,
      parent_id: id,
    });
    const allowedTargets = new Set<string>([id, ...children.map((c) => c.id)]);

    let accepted = 0;
    const failed: Array<{ proposalId: string; error: string }> = [];
    for (const proposalId of parsed.data.proposal_ids) {
      const note = getNote(proposalId);
      if (!note || note.kind !== 'audit_proposal') {
        failed.push({ proposalId, error: 'proposal not found' });
        continue;
      }
      if (isProposalConsumedByOperator(note)) {
        failed.push({ proposalId, error: 'already consumed' });
        continue;
      }
      const validated = validateAuditNoteBody('audit_proposal', note.body);
      if (!validated.ok) {
        failed.push({ proposalId, error: `invalid body: ${validated.error}` });
        continue;
      }
      const body = validated.parsed as AuditProposalBody;
      if (!isBulkAcceptable(body)) {
        failed.push({
          proposalId,
          error:
            'not eligible for bulk-accept (requires high confidence + keep|mark_done)',
        });
        continue;
      }
      if (!allowedTargets.has(body.node_initiative_id)) {
        failed.push({
          proposalId,
          error:
            'target initiative is not this initiative or an immediate descendant',
        });
        continue;
      }
      const outcome = acceptProposal(proposalId, null);
      if (outcome.ok) {
        accepted += 1;
      } else {
        failed.push({ proposalId, error: outcome.message });
      }
    }

    return NextResponse.json({ accepted, failed });
  } catch (error) {
    console.error('[proposals/bulk-accept] route error:', error);
    return NextResponse.json(
      { error: (error as Error).message ?? 'Internal server error' },
      { status: 500 },
    );
  }
}
