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
import { v4 as uuidv4 } from 'uuid';
import { getRoadmapSnapshot } from '@/lib/db/roadmap';
import { synthesizePlanInitiative } from '@/lib/agents/pm-agent';
import { PmProposalValidationError } from '@/lib/db/pm-proposals';
import { postPmChatMessage, dispatchPmSynthesized } from '@/lib/agents/pm-dispatch';
import { parseSuggestionsFromImpactMd } from '@/lib/pm/applyPlanInitiativeProposal';
import { queryOne } from '@/lib/db';

export const dynamic = 'force-dynamic';

const Body = z.object({
  workspace_id: z.string().min(1),
  // Set when the panel was opened on an existing initiative's detail
  // page. Persisted on the proposal so the panel can resume the same
  // draft on re-open instead of starting over.
  target_initiative_id: z.string().optional().nullable(),
  // Free-text steering from the operator — what to focus on, what to
  // avoid, constraints not visible in the draft. Threaded into the
  // PM agent prompt so the produced suggestions reflect the operator's
  // intent. Keep modest length; this isn't a place to dump specs.
  guidance: z.string().max(2000).optional().nullable(),
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
    const synth = synthesizePlanInitiative(snapshot, parsed.data.draft, {
      targetInitiativeId: parsed.data.target_initiative_id ?? null,
    });

    // Mint a session key for this planning conversation. Each new plan gets
    // a fresh gateway session (clean context, no prior-plan bleed). Refine
    // calls read planSessionKey back out of trigger_text and route to the
    // same session so multi-turn refinements share context.
    const planSessionKey = `plan-${uuidv4()}`;

    // Persist the suggestions inside trigger_text so refine() can
    // re-synthesize from the same draft without losing the planning
    // context. Guidance lives on trigger_text too so refine chains and
    // resume look-ups can see what the operator originally asked for.
    const triggerText = JSON.stringify({
      mode: 'plan_initiative',
      draft: parsed.data.draft,
      ...(parsed.data.guidance ? { guidance: parsed.data.guidance } : {}),
      planSessionKey,
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
    const dispatch = dispatchPmSynthesized({
      workspace_id: parsed.data.workspace_id,
      trigger_text: triggerText,
      trigger_kind: 'plan_initiative',
      target_initiative_id: parsed.data.target_initiative_id ?? null,
      planSessionKey,
      // plan_initiative prompts are large (description + guidance + roadmap
      // snapshot summary) and the PM agent often takes 60-90s to compose a
      // structured rewrite. Default 60s is too tight; observed cold-session
      // round trips at ~70s in the wild.
      timeoutMs: 120_000,
      synth: { impact_md: synth.impact_md, changes: synth.changes, plan_suggestions: synth.suggestions as unknown as Record<string, unknown> },
      agent_prompt:
        `Plan an initiative draft titled "${parsed.data.draft.title}". ` +
        `Operator-provided draft: ${JSON.stringify(parsed.data.draft)}. ` +
        (parsed.data.guidance
          ? `Operator guidance — focus the plan on this: ${parsed.data.guidance}\n\n`
          : '') +
        `Call \`propose_changes\` (trigger_kind='plan_initiative') with proposed_changes=[] and ` +
        `pass the structured plan_suggestions parameter directly (do NOT embed JSON in impact_md). ` +
        `See your SOUL.md for the plan_suggestions shape.`,
    });
    const proposal = dispatch.proposal;
    // Note: the synth placeholder created by `dispatchPmSynthesized` already
    // has `plan_suggestions` populated as a structured column (canonical
    // since #85). The legacy `<!--pm-plan-suggestions {json}-->` sidecar
    // appender that used to live here is removed — consumers now read the
    // column directly. The agent's superseding row, when it lands, also
    // carries plan_suggestions via the `propose_changes` MCP param.

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

    // Prefer structured plan_suggestions stored on the proposal (set by the
    // agent via the propose_changes MCP tool, or by the synth fallback).
    // Fall back to sidecar parsing for older proposals, then synth.
    const responseSuggestions =
      (proposal.plan_suggestions as typeof synth.suggestions | null) ??
      parseSuggestionsFromImpactMd(proposal.impact_md) ??
      synth.suggestions;

    return NextResponse.json(
      {
        proposal_id: proposal.id,
        proposal,
        suggestions: responseSuggestions,
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

/**
 * GET /api/pm/plan-initiative?workspace_id=…&target_initiative_id=…
 *
 * Resume-lookup. Returns the latest non-terminal plan_initiative draft
 * for the given target initiative — including its parsed suggestions
 * sidecar — so the panel can re-open the same draft instead of running
 * a fresh PM dispatch every time the operator clicks away and back.
 *
 * 200 with { proposal_id, proposal, suggestions } when a resumable
 * draft exists. 200 with { proposal: null } when there is none (so the
 * client can branch on body.proposal without handling 404 specially).
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspace_id');
  const targetInitiativeId = url.searchParams.get('target_initiative_id');
  if (!workspaceId || !targetInitiativeId) {
    return NextResponse.json(
      { error: 'workspace_id and target_initiative_id required' },
      { status: 400 },
    );
  }

  // Latest draft proposal for this initiative. Refines mark prior
  // proposals 'superseded', so the draft chain always has at most one
  // 'draft' row at a time. Order by created_at DESC for safety.
  // Match on target_initiative_id alone (no trigger_kind filter): the
  // target column is only ever set by plan dispatch, so any row with it
  // populated is a plan proposal — even if the PM agent mislabeled
  // trigger_kind via propose_changes (now reconciled in pm-dispatch,
  // but historic rows may still be 'manual').
  const row = queryOne<{
    id: string;
    workspace_id: string;
    trigger_text: string;
    trigger_kind: string;
    impact_md: string;
    proposed_changes: string;
    plan_suggestions: string | null;
    status: string;
    applied_at: string | null;
    applied_by_agent_id: string | null;
    parent_proposal_id: string | null;
    target_initiative_id: string | null;
    dispatch_state: string | null;
    created_at: string;
  }>(
    `SELECT * FROM pm_proposals
     WHERE workspace_id = ?
       AND target_initiative_id = ?
       AND status = 'draft'
     ORDER BY created_at DESC
     LIMIT 1`,
    [workspaceId, targetInitiativeId],
  );

  if (!row) {
    return NextResponse.json({ proposal: null });
  }

  // Prefer structured plan_suggestions; fall back to sidecar for older rows.
  const parsedPlanSuggestions = row.plan_suggestions
    ? (() => { try { return JSON.parse(row.plan_suggestions!) as { refined_description?: string }; } catch { return null; } })()
    : null;
  const suggestions = parsedPlanSuggestions ?? parseSuggestionsFromImpactMd(row.impact_md);
  // Require refined_description — proposals without it are incomplete.
  if (!suggestions?.refined_description) {
    return NextResponse.json({ proposal: null });
  }
  return NextResponse.json({
    proposal_id: row.id,
    proposal: {
      ...row,
      proposed_changes: JSON.parse(row.proposed_changes),
    },
    suggestions,
  });
}
