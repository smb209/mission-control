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
import { dispatchPm, dispatchPmSynthesized } from '@/lib/agents/pm-dispatch';
import { synthesizePlanInitiative, synthesizeDecompose } from '@/lib/agents/pm-agent';
import { getRoadmapSnapshot } from '@/lib/db/roadmap';
import { getInitiative } from '@/lib/db/initiatives';
import { parseSuggestionsFromImpactMd } from '@/lib/pm/planSuggestionsSidecar';

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
    let newPlanSuggestions: unknown = null;

    if (parent.trigger_kind === 'plan_initiative') {
      const ctx = parseTriggerContext(parent.trigger_text);
      // When trigger_text is old free-text format, extract the title from
      // quoted strings as a best-effort fallback (e.g. `Plan initiative flow
      // for "Smart Snappy" epic.` → "Smart Snappy").
      let draft = (ctx?.draft as Record<string, unknown> | undefined);
      if (!draft) {
        const m = parent.trigger_text.match(/"([^"]+)"/);
        draft = { title: m ? m[1] : parent.trigger_text.slice(0, 80) };
      }
      const draftTitle = (draft.title as string | undefined) ?? 'Untitled';
      // Reuse the same session so multi-turn refinements share context with
      // the PM agent's prior turns in this planning conversation.
      const planSessionKey = (ctx?.planSessionKey as string | undefined) ?? null;

      // Build a synth baseline (deterministic fallback) incorporating the
      // constraint — used both as the synth-path output and as the sidecar
      // source when the PM agent's impact_md is missing one.
      const snapshot = getRoadmapSnapshot({ workspace_id: parent.workspace_id });
      const synthDraft = {
        ...draft,
        description:
          (draft.description ? `${draft.description as string}\n\n` : '') +
          `Refine: ${parsed.data.additional_constraint}`,
      } as Parameters<typeof synthesizePlanInitiative>[1];
      const synth = synthesizePlanInitiative(snapshot, synthDraft, {
        targetInitiativeId: parent.target_initiative_id ?? null,
      });

      // Route through the PM gateway agent (same as the initial plan
      // dispatch) so the refinement gets an LLM-based response instead of
      // the deterministic heuristic that just capitalises the first letter.
      const dispatch = dispatchPmSynthesized({
        workspace_id: parent.workspace_id,
        trigger_text: child.trigger_text,
        trigger_kind: 'plan_initiative',
        planSessionKey,
        // Match the initial plan dispatch's longer wait — refines hit the
        // same large-prompt cold-session profile.
        timeoutMs: 120_000,
        synth: { impact_md: synth.impact_md, changes: synth.changes },
        agent_prompt:
          `Refine the plan for initiative titled "${draftTitle}". ` +
          `Original draft: ${JSON.stringify(draft)}. ` +
          `Operator refinement request: "${parsed.data.additional_constraint}"\n\n` +
          `Produce an updated refined_description that addresses the operator's request. ` +
          `Call \`propose_changes\` (trigger_kind='plan_initiative') with proposed_changes=[] and ` +
          `pass the structured plan_suggestions parameter directly (do NOT embed JSON in impact_md). ` +
          `See your SOUL.md for the plan_suggestions shape.`,
      });
      // Refine has a pre-allocated child row to copy content onto, so we
      // wait for the full dispatch lifecycle (Tier 2 reconciliation
      // included) rather than returning the synth placeholder immediately.
      const settled = await dispatch.completion;

      const agentImpactMd = settled.final.impact_md;
      // Resolve structured suggestions: prefer what the agent wrote into
      // plan_suggestions (via propose_changes MCP param), then sidecar,
      // then the deterministic synth. This eliminates the sidecar-injection
      // band-aid that was applied here before.
      const refinedSuggestions =
        (settled.final.plan_suggestions as typeof synth.suggestions | null) ??
        parseSuggestionsFromImpactMd(agentImpactMd) ??
        synth.suggestions;

      // dispatchPmSynthesized may have created up to two transient rows:
      // the synth placeholder, and (if the named agent responded) a
      // separate agent row that supersedes it. Refine has its own
      // pre-allocated child row to copy content onto, so both transient
      // rows are cleaned up.
      const { run: del } = await import('@/lib/db');
      if (dispatch.proposal.id !== child.id) {
        del('DELETE FROM pm_proposals WHERE id = ?', [dispatch.proposal.id]);
      }
      if (settled.final.id !== dispatch.proposal.id && settled.final.id !== child.id) {
        del('DELETE FROM pm_proposals WHERE id = ?', [settled.final.id]);
      }

      newImpactMd = agentImpactMd;
      newChanges = synth.changes;
      newPlanSuggestions = refinedSuggestions;
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
      // Don't forward `child.trigger_text` directly — it carries the
      // `[refine] <constraint>` envelope written by `refineProposalDb`,
      // and the `[refine]` token nudges the PM agent to call the
      // `refine_proposal` MCP tool, which itself calls dispatchPm and
      // creates a recursive cascade. Build a clean disruption-style
      // trigger that combines the original parent context with the
      // operator's new constraint, plus an explicit "use propose_changes"
      // instruction so the agent stays on the right tool.
      const cleanTrigger =
        `Operator refinement of an earlier ${parent.trigger_kind} proposal.\n\n` +
        `Original context:\n${(parent.trigger_text || '').replace(/\n*\[refine\][\s\S]*$/, '').trim()}\n\n` +
        `New constraint to incorporate: ${parsed.data.additional_constraint}\n\n` +
        `Respond by calling \`propose_changes\` with an updated impact_md + diff list. ` +
        `Do NOT call \`refine_proposal\` — that's an operator-only tool and would create a dispatch loop.`;
      const synthesized = dispatchPm({
        workspace_id: parent.workspace_id,
        trigger_text: cleanTrigger,
        trigger_kind: parent.trigger_kind,
      });
      // Refine has a pre-allocated child row to copy content onto, so
      // wait for the full lifecycle (Tier 2 reconciler included) rather
      // than returning the synth placeholder immediately.
      const settled = await synthesized.completion;
      newImpactMd = settled.final.impact_md;
      newChanges = settled.final.proposed_changes;
      const { run } = await import('@/lib/db');
      // Clean up both the placeholder and (if separate) the agent's row.
      if (synthesized.proposal.id !== child.id) {
        run(`DELETE FROM pm_proposals WHERE id = ?`, [synthesized.proposal.id]);
      }
      if (settled.final.id !== synthesized.proposal.id && settled.final.id !== child.id) {
        run(`DELETE FROM pm_proposals WHERE id = ?`, [settled.final.id]);
      }
    }

    const { run } = await import('@/lib/db');
    run(
      `UPDATE pm_proposals SET impact_md = ?, proposed_changes = ?, plan_suggestions = ? WHERE id = ?`,
      [newImpactMd, JSON.stringify(newChanges), newPlanSuggestions != null ? JSON.stringify(newPlanSuggestions) : null, child.id],
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
