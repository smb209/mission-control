/**
 * POST /api/pm/proposals/[id]/refine
 *
 *   body: { additional_constraint: string }
 *
 * Marks the parent `superseded`, creates a new draft slot with
 * parent_proposal_id set, then re-synthesizes a fresh impact + diff list
 * incorporating the operator's additional constraint. Returns the new
 * proposal.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getProposal, refineProposal, PmProposalValidationError } from '@/lib/db/pm-proposals';
import { dispatchPm } from '@/lib/agents/pm-dispatch';

export const dynamic = 'force-dynamic';

const Body = z.object({
  additional_constraint: z.string().min(1).max(5000),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body required' }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.issues }, { status: 400 });
  }

  try {
    const parent = getProposal(id);
    if (!parent) {
      return NextResponse.json({ error: 'Parent proposal not found' }, { status: 404 });
    }

    // refineProposal creates the (empty) draft slot and supersedes the
    // parent; we then re-dispatch with the combined trigger so the slot
    // is filled with the new impact + diffs. We do this in two steps so
    // the supersede + new-id pair is visible even if dispatch fails.
    const { child } = refineProposal(id, parsed.data.additional_constraint);

    // Re-dispatch using the parent's full trigger + the additional
    // constraint as a free-text bolt-on. We then patch the child row
    // with the new impact + changes by deleting/recreating — simplest
    // reliable path that doesn't require an "update_proposal" helper.
    // Call dispatchPm separately (without parent_proposal_id) so it
    // returns a freshly-synthesized result we copy onto `child`.
    const synthesized = dispatchPm({
      workspace_id: parent.workspace_id,
      trigger_text: child.trigger_text,
      trigger_kind: parent.trigger_kind,
      // We do NOT pass parent_proposal_id here — that would create a
      // SECOND child. The freshly-synthesized proposal exists; we
      // delete it and update our pre-allocated slot below.
    });

    // Move the synthesized impact + changes onto our pre-allocated child
    // row, then delete the side-effect row created by dispatchPm.
    // Rationale: refineProposal already produced the supersede chain we
    // want — we're only borrowing dispatchPm's synthesizer.
    const { run } = await import('@/lib/db');
    run(
      `UPDATE pm_proposals SET impact_md = ?, proposed_changes = ? WHERE id = ?`,
      [
        synthesized.proposal.impact_md,
        JSON.stringify(synthesized.proposal.proposed_changes),
        child.id,
      ],
    );
    run(`DELETE FROM pm_proposals WHERE id = ?`, [synthesized.proposal.id]);

    const refreshed = getProposal(child.id)!;
    return NextResponse.json({ proposal: refreshed }, { status: 201 });
  } catch (err) {
    if (err instanceof PmProposalValidationError) {
      return NextResponse.json({ error: err.message, hints: err.hints }, { status: 400 });
    }
    const msg = err instanceof Error ? err.message : 'Failed to refine proposal';
    console.error('Failed to refine proposal:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
