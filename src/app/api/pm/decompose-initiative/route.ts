/**
 * POST /api/pm/decompose-initiative
 *
 * Polish B (decompose flow). Operator picks an existing epic/milestone;
 * the PM proposes 3-7 child initiatives. Returns a draft proposal with
 * trigger_kind='decompose_initiative' and proposed_changes containing
 * one `create_child_initiative` diff per proposed child.
 *
 * On accept the children are inserted in a single transaction with
 * matching `initiative_parent_history` rows and any pre-wired sibling
 * dep edges (placeholder ids `$N` resolved post-insert).
 *
 * Body:
 *   { initiative_id, hint? }
 *
 * Response:
 *   { proposal }
 */

import { NextRequest, NextResponse } from 'next/server';
import { logApiError, serverLog } from '@/lib/debug-log';
import { z } from 'zod';
import { getInitiative } from '@/lib/db/initiatives';
import { synthesizeDecompose } from '@/lib/agents/pm-agent';
import { PmProposalValidationError, getProposal } from '@/lib/db/pm-proposals';
import { postPmChatMessage, dispatchPmSynthesized } from '@/lib/agents/pm-dispatch';
import { queryOne } from '@/lib/db';

export const dynamic = 'force-dynamic';

const Body = z.object({
  initiative_id: z.string().min(1),
  hint: z.string().max(2000).optional(),
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
    const parent = getInitiative(parsed.data.initiative_id);
    if (!parent) {
      return NextResponse.json({ error: 'Initiative not found' }, { status: 404 });
    }
    if (parent.kind !== 'theme' && parent.kind !== 'milestone' && parent.kind !== 'epic') {
      return NextResponse.json(
        {
          error: `Split only supported for theme/milestone/epic parents (got "${parent.kind}")`,
        },
        { status: 400 },
      );
    }

    const synth = synthesizeDecompose(parent, parsed.data.hint);

    // Embed the original hint in trigger_text so refine() can re-run with
    // the same context.
    const triggerText = JSON.stringify({
      mode: 'decompose_initiative',
      initiative_id: parent.id,
      parent_title: parent.title,
      hint: parsed.data.hint ?? null,
    });

    // Dedup: return any identical draft dispatched in the last 2 seconds
    // (guards against React StrictMode double-invoke and rapid re-opens).
    // Returns the canonical proposal shape via getProposal — a stripped
    // payload would drop dispatch_state + created_at and break the
    // modal's in-flight render gate (see decompose-story route note).
    const recent = queryOne<{ id: string }>(
      `SELECT id FROM pm_proposals
       WHERE workspace_id = ?
         AND trigger_kind = 'decompose_initiative'
         AND trigger_text = ?
         AND status = 'draft'
         AND created_at >= datetime('now', '-2 seconds')
       ORDER BY created_at DESC LIMIT 1`,
      [parent.workspace_id, triggerText],
    );
    if (recent) {
      const full = getProposal(recent.id);
      if (full) {
        return NextResponse.json({ proposal: full, deduped: true }, { status: 201 });
      }
    }

    // Try the named-agent path first (PM gateway agent at
    // ~/.openclaw/workspaces/mc-project-manager). On timeout or no
    // session, the synthesized proposal is persisted exactly like
    // before so the operator always has something to react to.
    const dispatch = dispatchPmSynthesized({
      workspace_id: parent.workspace_id,
      trigger_text: triggerText,
      trigger_kind: 'decompose_initiative',
      // No timeoutMs — inherits the env-tunable default in
      // pm-dispatch.ts (MC_PM_NAMED_AGENT_TIMEOUT_MS, currently 10min).
      // Operators preferred a longer wait over seeing the low-info
      // synth placeholder while the LLM is still producing.
      synth: { impact_md: synth.impact_md, changes: synth.changes },
      chat_context: {
        target_initiative_id: parent.id,
        origin: 'pm_dispatch',
      },
      agent_prompt:
        `Decompose initiative ${parent.id} ("${parent.title}", kind=${parent.kind}) ` +
        `into 3-7 child initiatives.` +
        (parent.description ? ` Parent description: ${parent.description}` : '') +
        (parsed.data.hint ? ` Operator hint: ${parsed.data.hint}.` : '') +
        ` Before composing, call read_notes({ initiative_id: "${parent.id}", audience: 'pm', min_importance: 2, limit: 5 }) ` +
        `to ingest any recent audit findings; if any are returned, reference one or two explicitly in impact_md ` +
        `(e.g. \`Per audit on YYYY-MM-DD: "<short quoted finding>"\`). See SOUL.md "Ingest recent audit findings".\n\n` +
        `Pick child_kind based on the parent's kind: theme parents split into ` +
        `milestones; milestone parents split into epics (or stories for thin slices); ` +
        `epic parents split into stories (or smaller epics for genuinely large scope). ` +
        `Never propose theme as child_kind. ` +
        `Call \`propose_changes\` (trigger_kind='decompose_initiative') with one ` +
        `\`create_child_initiative\` diff per child. Pre-wire each child to depend on the ` +
        `prior sibling using placeholder ids \`$0\`, \`$1\`, etc. See your SOUL.md. ` +
        `Output discipline: tool call FIRST, then a short confirmation sentence — ` +
        `do NOT echo the id or use \`{...}\` placeholder syntax (the operator UI discards freeform replies).`,
    });
    const proposal = dispatch.proposal;

    // Use the PROPOSAL's impact_md so the named-agent path's richer
    // analysis isn't overwritten by synth's. On synth fallback the two
    // are identical (proposal was created from synth.impact_md).
    try {
      const ctx = {
        trigger_kind: 'decompose_initiative' as const,
        target_initiative_id: parent.id,
        origin: 'pm_dispatch' as const,
      };
      postPmChatMessage({
        workspace_id: parent.workspace_id,
        role: 'user',
        content: `Split: "${parent.title}"` + (parsed.data.hint ? ` (hint: ${parsed.data.hint})` : ''),
        context: ctx,
      });
      postPmChatMessage({
        workspace_id: parent.workspace_id,
        role: 'assistant',
        content: proposal.impact_md,
        proposal_id: proposal.id,
        context: ctx,
      });
    } catch (err) {
      serverLog.warn('pm-decompose', `chat insert failed: ${(err as Error).message}`);
    }

    return NextResponse.json({ proposal }, { status: 201 });
  } catch (err) {
    if (err instanceof PmProposalValidationError) {
      return NextResponse.json({ error: err.message, hints: err.hints }, { status: 400 });
    }
    const msg = err instanceof Error ? err.message : 'Failed to decompose initiative';
    logApiError({ route: '/api/pm/decompose-initiative', method: 'POST', status: 500, error: err });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * GET /api/pm/decompose-initiative?workspace_id=…&initiative_id=…
 *
 * Resume-lookup. Returns the latest draft decompose_initiative proposal
 * for the given initiative so the modal can re-open the same draft instead
 * of dispatching a fresh one every open.
 *
 * 200 { proposal } when resumable, 200 { proposal: null } when none.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspace_id');
  const initiativeId = url.searchParams.get('initiative_id');
  if (!workspaceId || !initiativeId) {
    return NextResponse.json(
      { error: 'workspace_id and initiative_id required' },
      { status: 400 },
    );
  }

  const row = queryOne<{
    id: string;
    workspace_id: string;
    trigger_text: string;
    trigger_kind: string;
    impact_md: string;
    proposed_changes: string;
    status: string;
    dispatch_state: string | null;
  }>(
    `SELECT id, workspace_id, trigger_text, trigger_kind, impact_md, proposed_changes, status, dispatch_state
     FROM pm_proposals
     WHERE workspace_id = ?
       AND trigger_kind = 'decompose_initiative'
       AND status = 'draft'
       AND json_extract(trigger_text, '$.initiative_id') = ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [workspaceId, initiativeId],
  );

  if (!row) {
    return NextResponse.json({ proposal: null });
  }

  return NextResponse.json({
    proposal: { ...row, proposed_changes: JSON.parse(row.proposed_changes) },
  });
}
