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
import { synthesizePlanInitiative, synthesizeDecompose } from '@/lib/agents/pm-agent';
import { getRoadmapSnapshot } from '@/lib/db/roadmap';
import { getInitiative } from '@/lib/db/initiatives';

export const dynamic = 'force-dynamic';

const Body = z.object({
  additional_constraint: z.string().min(1).max(5000),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Plan/decompose proposals stash structured context as JSON in
 * trigger_text. Older trigger_text is free-text — we return null and the
 * caller falls back gracefully.
 */
function parseTriggerContext(triggerText: string): Record<string, unknown> | null {
  try {
    const trimmed = triggerText.trim();
    if (!trimmed.startsWith('{')) return null;
    const parsed = JSON.parse(trimmed.split('\n\n[refine]')[0]);
    return typeof parsed === 'object' && parsed != null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
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
    // parent. We then route the re-synthesis to the right backend based
    // on the parent's trigger_kind:
    //   - plan_initiative / decompose_initiative → call the matching
    //     synthesizer directly with the parent's structured context
    //     (parsed out of trigger_text).
    //   - everything else → fall back to dispatchPm (the disruption-
    //     analysis synthesizer).
    const { child } = refineProposal(id, parsed.data.additional_constraint);

    let newImpactMd: string;
    let newChanges: unknown[];

    if (parent.trigger_kind === 'plan_initiative') {
      // Re-run synthesizePlanInitiative with the operator's draft + the
      // additional constraint folded into the description.
      const ctx = parseTriggerContext(parent.trigger_text);
      const draft = (ctx?.draft as Record<string, unknown> | undefined) ?? { title: 'Untitled' };
      const refinedDraft = {
        ...draft,
        description:
          (draft.description ? `${draft.description as string}\n\n` : '') +
          `Refine: ${parsed.data.additional_constraint}`,
      } as Parameters<typeof synthesizePlanInitiative>[1];
      const snapshot = getRoadmapSnapshot({ workspace_id: parent.workspace_id });
      const synth = synthesizePlanInitiative(snapshot, refinedDraft);
      newImpactMd = synth.impact_md;
      newChanges = synth.changes;
    } else if (parent.trigger_kind === 'decompose_initiative') {
      const ctx = parseTriggerContext(parent.trigger_text);
      const initiativeId = ctx?.initiative_id as string | undefined;
      const init = initiativeId ? getInitiative(initiativeId) : undefined;
      if (!init) {
        return NextResponse.json(
          { error: 'Original parent initiative no longer exists; cannot refine' },
          { status: 400 },
        );
      }
      const combinedHint =
        ((ctx?.hint as string | null) ?? '') +
        (ctx?.hint ? '\n' : '') +
        `Refine: ${parsed.data.additional_constraint}`;
      const synth = synthesizeDecompose(init, combinedHint.trim());
      newImpactMd = synth.impact_md;
      newChanges = synth.changes;
    } else {
      // Default disruption-analysis path. We borrow dispatchPm's
      // synthesizer and patch the result onto the pre-allocated child
      // row, then delete the side-effect row dispatchPm created.
      const synthesized = dispatchPm({
        workspace_id: parent.workspace_id,
        trigger_text: child.trigger_text,
        trigger_kind: parent.trigger_kind,
      });
      newImpactMd = synthesized.proposal.impact_md;
      newChanges = synthesized.proposal.proposed_changes;
      const { run } = await import('@/lib/db');
      run(`DELETE FROM pm_proposals WHERE id = ?`, [synthesized.proposal.id]);
    }

    const { run } = await import('@/lib/db');
    run(
      `UPDATE pm_proposals SET impact_md = ?, proposed_changes = ? WHERE id = ?`,
      [newImpactMd, JSON.stringify(newChanges), child.id],
    );

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
