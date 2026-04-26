/**
 * POST /api/pm/plan-initiative
 *
 * Polish B (guided planning). The operator drafts an initiative (title +
 * rough description) and asks the PM to fill in the planning fields. We
 * synthesize suggestions deterministically (no LLM dep — see
 * synthesizePlanInitiative for v1 heuristics) and store an advisory
 * `pm_proposals` row with trigger_kind='plan_initiative'.
 *
 * Advisory means: accepting the proposal does NOT mutate state. The
 * operator applies the suggestions client-side by populating the form
 * fields. The proposal exists for audit + the refine chain only.
 *
 * Body:
 *   {
 *     workspace_id,
 *     draft: { title, description?, kind?, complexity?,
 *              parent_initiative_id?, target_start?, target_end? }
 *   }
 *
 * Response:
 *   { proposal_id, suggestions: { ... } }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getRoadmapSnapshot } from '@/lib/db/roadmap';
import { synthesizePlanInitiative } from '@/lib/agents/pm-agent';
import { PmProposalValidationError } from '@/lib/db/pm-proposals';
import { postPmChatMessage, dispatchPmSynthesized } from '@/lib/agents/pm-dispatch';
import { parseSuggestionsFromImpactMd } from '@/lib/pm/applyPlanInitiativeProposal';
import { run, queryOne } from '@/lib/db';

export const dynamic = 'force-dynamic';

const Body = z.object({
  workspace_id: z.string().min(1),
  draft: z.object({
    title: z.string().min(1).max(500),
    description: z.string().max(20000).optional().nullable(),
    kind: z.enum(['theme', 'milestone', 'epic', 'story']).optional(),
    complexity: z.enum(['S', 'M', 'L', 'XL']).optional().nullable(),
    parent_initiative_id: z.string().optional().nullable(),
    target_start: z.string().optional().nullable(),
    target_end: z.string().optional().nullable(),
  }),
});

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body required' }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const snapshot = getRoadmapSnapshot({ workspace_id: parsed.data.workspace_id });
    const synth = synthesizePlanInitiative(snapshot, parsed.data.draft);

    // Persist the suggestions inside trigger_text so refine() can
    // re-synthesize from the same draft without losing the planning
    // context.
    const triggerText = JSON.stringify({
      mode: 'plan_initiative',
      draft: parsed.data.draft,
    });

    // Dedupe identical requests fired in quick succession. React
    // StrictMode in dev double-invokes effects on mount, so the
    // PlanWithPmPanel posts twice per open. Without this, every dev
    // open creates two pm_proposals rows (and hits the gateway twice).
    // Treat any draft-identical proposal created in the last ~2s as
    // the same logical request.
    const recent = queryOne<{ id: string; impact_md: string; trigger_text: string; created_at: string }>(
      `SELECT id, impact_md, trigger_text, created_at FROM pm_proposals
       WHERE workspace_id = ?
         AND trigger_kind = 'plan_initiative'
         AND trigger_text = ?
         AND status = 'draft'
         AND created_at >= datetime('now', '-2 seconds')
       ORDER BY created_at DESC LIMIT 1`,
      [parsed.data.workspace_id, triggerText],
    );
    if (recent) {
      // Re-fetch full row to match the shape the rest of the route uses.
      const full = queryOne<{
        id: string; workspace_id: string; trigger_text: string; trigger_kind: string;
        impact_md: string; proposed_changes: string; status: string; applied_at: string | null;
        applied_by_agent_id: string | null; parent_proposal_id: string | null; created_at: string;
      }>('SELECT * FROM pm_proposals WHERE id = ?', [recent.id]);
      if (full) {
        return NextResponse.json(
          {
            proposal_id: full.id,
            proposal: { ...full, proposed_changes: JSON.parse(full.proposed_changes) },
            suggestions: synth.suggestions,
            deduped: true,
          },
          { status: 201 },
        );
      }
    }

    // Try the named-agent path first (PM gateway agent at
    // ~/.openclaw/workspaces/mc-project-manager). On timeout or no
    // session, the synthesized advisory proposal is persisted exactly
    // like before. proposed_changes stays an empty array for the
    // advisory plan_initiative case = nothing to apply on accept.
    const dispatch = await dispatchPmSynthesized({
      workspace_id: parsed.data.workspace_id,
      trigger_text: triggerText,
      trigger_kind: 'plan_initiative',
      synth: { impact_md: synth.impact_md, changes: synth.changes },
      agent_prompt:
        `Plan an initiative draft titled "${parsed.data.draft.title}". ` +
        `Operator-provided draft: ${JSON.stringify(parsed.data.draft)}. ` +
        `Call \`propose_changes\` (trigger_kind='plan_initiative') with an impact_md that ` +
        `includes a "<!--pm-plan-suggestions ...-->" sidecar so the form can apply your ` +
        `suggestions. proposed_changes should be [] (advisory). See your SOUL.md.`,
    });
    let proposal = dispatch.proposal;

    // Always-embed-the-sidecar guarantee: when the PM agent answered via
    // the gateway, its impact_md is freeform — LLMs are unreliable about
    // including arbitrary HTML-comment JSON sidecars even when SOUL.md
    // tells them to. Without the sidecar, the chat-card Apply flow has
    // no structured suggestions to apply. We always have synth.suggestions
    // here, so inject it post-hoc when missing and persist the patched
    // impact_md to the same row. The synth path naturally already
    // includes it, so this is a no-op there.
    if (!parseSuggestionsFromImpactMd(proposal.impact_md)) {
      const sidecar = `\n\n<!--pm-plan-suggestions ${JSON.stringify(synth.suggestions)} -->`;
      const patchedMd = proposal.impact_md + sidecar;
      run(
        'UPDATE pm_proposals SET impact_md = ? WHERE id = ?',
        [patchedMd, proposal.id],
      );
      proposal = { ...proposal, impact_md: patchedMd };
    }

    // Best-effort chat echo for audit visibility in /pm. Use the
    // PROPOSAL's impact_md — when the named PM agent answered, that's
    // its (potentially richer) summary; on synth fallback the proposal
    // carries the same synth impact_md so the result is identical.
    // Posting `synth.impact_md` directly (the old behaviour) discarded
    // the named agent's reasoning whenever the gateway path was used.
    try {
      postPmChatMessage({
        workspace_id: parsed.data.workspace_id,
        role: 'user',
        content: `Plan with PM: "${parsed.data.draft.title}"`,
      });
      postPmChatMessage({
        workspace_id: parsed.data.workspace_id,
        role: 'assistant',
        content: proposal.impact_md,
        proposal_id: proposal.id,
      });
    } catch (err) {
      console.warn('[pm-plan] chat insert failed:', (err as Error).message);
    }

    return NextResponse.json(
      {
        proposal_id: proposal.id,
        proposal,
        suggestions: synth.suggestions,
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof PmProposalValidationError) {
      return NextResponse.json({ error: err.message, hints: err.hints }, { status: 400 });
    }
    const msg = err instanceof Error ? err.message : 'Failed to plan initiative';
    console.error('Failed to plan initiative:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
