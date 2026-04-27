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
import { z } from 'zod';
import { getInitiative } from '@/lib/db/initiatives';
import { synthesizeDecompose } from '@/lib/agents/pm-agent';
import { PmProposalValidationError } from '@/lib/db/pm-proposals';
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
    if (parent.kind !== 'epic' && parent.kind !== 'milestone') {
      return NextResponse.json(
        {
          error: `Decompose only supported for epic/milestone parents (got "${parent.kind}")`,
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
    const recent = queryOne<{ id: string; impact_md: string; proposed_changes: string }>(
      `SELECT id, impact_md, proposed_changes FROM pm_proposals
       WHERE workspace_id = ?
         AND trigger_kind = 'decompose_initiative'
         AND trigger_text = ?
         AND status = 'draft'
         AND created_at >= datetime('now', '-2 seconds')
       ORDER BY created_at DESC LIMIT 1`,
      [parent.workspace_id, triggerText],
    );
    if (recent) {
      return NextResponse.json(
        {
          proposal: {
            ...recent,
            proposed_changes: JSON.parse(recent.proposed_changes),
          },
          deduped: true,
        },
        { status: 201 },
      );
    }

    // Try the named-agent path first (PM gateway agent at
    // ~/.openclaw/workspaces/mc-project-manager). On timeout or no
    // session, the synthesized proposal is persisted exactly like
    // before so the operator always has something to react to.
    const dispatch = await dispatchPmSynthesized({
      workspace_id: parent.workspace_id,
      trigger_text: triggerText,
      trigger_kind: 'decompose_initiative',
      synth: { impact_md: synth.impact_md, changes: synth.changes },
      agent_prompt:
        `Decompose initiative ${parent.id} ("${parent.title}", kind=${parent.kind}) ` +
        `into 3-7 child initiatives.` +
        (parsed.data.hint ? ` Operator hint: ${parsed.data.hint}.` : '') +
        ` Call \`propose_changes\` (trigger_kind='decompose_initiative') with one ` +
        `\`create_child_initiative\` diff per child. Pre-wire each child to depend on the ` +
        `prior sibling using placeholder ids \`$0\`, \`$1\`, etc. See your SOUL.md.`,
    });
    const proposal = dispatch.proposal;

    // Use the PROPOSAL's impact_md so the named-agent path's richer
    // analysis isn't overwritten by synth's. On synth fallback the two
    // are identical (proposal was created from synth.impact_md).
    try {
      postPmChatMessage({
        workspace_id: parent.workspace_id,
        role: 'user',
        content: `Decompose: "${parent.title}"` + (parsed.data.hint ? ` (hint: ${parsed.data.hint})` : ''),
      });
      postPmChatMessage({
        workspace_id: parent.workspace_id,
        role: 'assistant',
        content: proposal.impact_md,
        proposal_id: proposal.id,
      });
    } catch (err) {
      console.warn('[pm-decompose] chat insert failed:', (err as Error).message);
    }

    return NextResponse.json({ proposal }, { status: 201 });
  } catch (err) {
    if (err instanceof PmProposalValidationError) {
      return NextResponse.json({ error: err.message, hints: err.hints }, { status: 400 });
    }
    const msg = err instanceof Error ? err.message : 'Failed to decompose initiative';
    console.error('Failed to decompose initiative:', err);
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
  }>(
    `SELECT id, workspace_id, trigger_text, trigger_kind, impact_md, proposed_changes, status
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
