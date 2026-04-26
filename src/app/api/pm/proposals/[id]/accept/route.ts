/**
 * POST /api/pm/proposals/[id]/accept
 *
 *   body: {
 *     applied_by_agent_id?: string,
 *     // For plan_initiative proposals only: when provided, parse the
 *     // embedded suggestions JSON out of impact_md and apply it to the
 *     // chosen initiative atomically (field PATCHes + dependency INSERTs)
 *     // instead of the no-op "advisory" path.
 *     target_initiative_id?: string,
 *   }
 *
 * Applies the proposal's diff list transactionally (or, for advisory
 * plan_initiative + target_initiative_id, applies the embedded
 * suggestions blob). Returns the updated proposal + a count of changes
 * applied.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { acceptProposal, PmProposalValidationError } from '@/lib/db/pm-proposals';
import { postPmChatMessage } from '@/lib/agents/pm-dispatch';
import { queryOne } from '@/lib/db';
import {
  applyPlanInitiativeSuggestions,
  parseSuggestionsFromImpactMd,
} from '@/lib/pm/applyPlanInitiativeProposal';

export const dynamic = 'force-dynamic';

const Body = z.object({
  applied_by_agent_id: z.string().min(1).nullish(),
  target_initiative_id: z.string().min(1).nullish(),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    /* empty body is fine */
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.issues }, { status: 400 });
  }

  // Branch: plan_initiative + chosen target → apply the embedded
  // suggestions to that initiative before the standard accept flow
  // flips status. Other paths fall through to acceptProposal as before.
  const targetInitiativeId = parsed.data.target_initiative_id ?? null;
  if (targetInitiativeId) {
    const proposal = queryOne<{
      id: string;
      workspace_id: string;
      trigger_kind: string;
      impact_md: string;
      status: string;
    }>(
      'SELECT id, workspace_id, trigger_kind, impact_md, status FROM pm_proposals WHERE id = ?',
      [id],
    );
    if (!proposal) {
      return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
    }
    if (proposal.trigger_kind !== 'plan_initiative') {
      return NextResponse.json(
        { error: `target_initiative_id is only valid for plan_initiative proposals (got ${proposal.trigger_kind})` },
        { status: 400 },
      );
    }
    const suggestions = parseSuggestionsFromImpactMd(proposal.impact_md);
    if (!suggestions) {
      return NextResponse.json(
        { error: 'Proposal has no embedded suggestions to apply' },
        { status: 400 },
      );
    }
    try {
      const applied = applyPlanInitiativeSuggestions(targetInitiativeId, suggestions);
      // Flip the proposal to accepted via the standard path so downstream
      // listeners see one consistent state transition.
      const acceptResult = acceptProposal(id, parsed.data.applied_by_agent_id ?? null);

      // Replace the default "Applied — 0 changes" banner with one that
      // reflects what really happened.
      const partsList: string[] = [];
      if (applied.fields_updated > 0) {
        partsList.push(`${applied.fields_updated} field${applied.fields_updated === 1 ? '' : 's'} updated`);
      }
      if (applied.dependencies_created > 0) {
        partsList.push(
          `${applied.dependencies_created} dependenc${applied.dependencies_created === 1 ? 'y' : 'ies'} added`,
        );
      }
      if (applied.dependencies_skipped > 0) {
        partsList.push(
          `${applied.dependencies_skipped} skipped (already linked / unknown)`,
        );
      }
      const summary = partsList.length > 0 ? partsList.join(', ') : 'no changes';
      const text =
        `Applied to **${applied.initiative_title}** — ${summary}. ` +
        `[Open initiative](/initiatives/${targetInitiativeId})`;
      try {
        postPmChatMessage({
          workspace_id: proposal.workspace_id,
          role: 'assistant',
          content: text,
        });
      } catch (err) {
        console.warn('[pm-accept] chat insert failed:', (err as Error).message);
      }

      return NextResponse.json({
        ...acceptResult,
        applied_to_initiative: targetInitiativeId,
        changes_applied: applied.fields_updated + applied.dependencies_created,
        plan_apply: applied,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to apply suggestions';
      console.error('Failed to apply plan_initiative suggestions:', err);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  }

  try {
    const result = acceptProposal(id, parsed.data.applied_by_agent_id ?? null);

    // Best-effort: post a confirmation chat message so the operator sees
    // "Applied — N changes" inline. Silent on failure.
    if (!result.idempotent_noop) {
      try {
        const proposal = result.proposal;
        const text =
          `Applied — ${result.changes_applied} change${result.changes_applied === 1 ? '' : 's'}. ` +
          `[View affected initiatives](/roadmap?workspace=${encodeURIComponent(proposal.workspace_id)})`;
        // Need workspace_id from the proposal to find the PM agent.
        const w = queryOne<{ workspace_id: string }>(
          'SELECT workspace_id FROM pm_proposals WHERE id = ?',
          [id],
        );
        if (w) {
          postPmChatMessage({
            workspace_id: w.workspace_id,
            role: 'assistant',
            content: text,
          });
        }
      } catch (err) {
        console.warn('[pm-accept] chat insert failed:', (err as Error).message);
      }
    }

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof PmProposalValidationError) {
      return NextResponse.json({ error: err.message, hints: err.hints }, { status: 400 });
    }
    const msg = err instanceof Error ? err.message : 'Failed to accept proposal';
    console.error('Failed to accept proposal:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
