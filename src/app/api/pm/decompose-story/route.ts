/**
 * POST /api/pm/decompose-story
 *
 * Story → tasks decomposition. Sibling of /api/pm/decompose-initiative
 * but for story-kind initiatives: each proposed child is a draft task
 * (one `create_task_under_initiative` diff) attached to the story via
 * task.initiative_id.
 *
 * Body:
 *   { initiative_id, hint?, agent_id? }
 *
 * `agent_id` is reserved for the multi-agent picker. Today only the
 * workspace PM is supported; passing any other id returns 400.
 */

import { NextRequest, NextResponse } from 'next/server';
import { logApiError, serverLog } from '@/lib/debug-log';
import { z } from 'zod';
import { getInitiative } from '@/lib/db/initiatives';
import { synthesizeStoryToTasks } from '@/lib/agents/pm-agent';
import { PmProposalValidationError, getProposal } from '@/lib/db/pm-proposals';
import { postPmChatMessage, dispatchPmSynthesized } from '@/lib/agents/pm-dispatch';
import { getPmAgent } from '@/lib/agents/pm-resolver';
import { queryOne } from '@/lib/db';

export const dynamic = 'force-dynamic';

const Body = z.object({
  initiative_id: z.string().min(1),
  hint: z.string().max(2000).optional(),
  agent_id: z.string().optional(),
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
    if (parent.kind !== 'story') {
      return NextResponse.json(
        {
          error: `Decompose-to-tasks only supported for story-kind initiatives (got "${parent.kind}"). Convert the initiative to a story first.`,
        },
        { status: 400 },
      );
    }

    // Agent picker scaffolding. Today the only valid decomposer is the
    // workspace PM; the picker accepts only that id (or omits it).
    const pm = getPmAgent(parent.workspace_id);
    if (parsed.data.agent_id && pm && parsed.data.agent_id !== pm.id) {
      return NextResponse.json(
        { error: 'Only the workspace PM can decompose stories into tasks (for now).' },
        { status: 400 },
      );
    }

    const synth = synthesizeStoryToTasks(parent, parsed.data.hint);

    const triggerText = JSON.stringify({
      mode: 'decompose_story',
      initiative_id: parent.id,
      parent_title: parent.title,
      hint: parsed.data.hint ?? null,
    });

    // Dedup recent identical drafts (StrictMode + rapid re-opens).
    // Returns the canonical proposal shape (via getProposal) — earlier
    // versions returned a stripped { id, impact_md, proposed_changes }
    // payload that dropped `dispatch_state` + `created_at`, so the
    // modal's InFlightProposalCard gate (dispatch_state==='pending_agent')
    // never matched on the second StrictMode call.
    const recent = queryOne<{ id: string }>(
      `SELECT id FROM pm_proposals
       WHERE workspace_id = ?
         AND trigger_kind = 'decompose_story'
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

    const dispatch = dispatchPmSynthesized({
      workspace_id: parent.workspace_id,
      trigger_text: triggerText,
      trigger_kind: 'decompose_story',
      target_initiative_id: parent.id,
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
        `Decompose story ${parent.id} ("${parent.title}") into a convoy: a ` +
        `slice DAG that an implementer team can execute under dep + AC gates.` +
        (parent.description ? ` Story description: ${parent.description}` : '') +
        (parsed.data.hint ? ` Operator hint: ${parsed.data.hint}.` : '') +
        ` Before composing, call read_notes({ initiative_id: "${parent.id}", audience: 'pm', min_importance: 2, limit: 5 }) ` +
        `to ingest any recent audit findings; if any are returned, reference one or two explicitly in impact_md ` +
        `(e.g. \`Per audit on YYYY-MM-DD: "<short quoted finding>"\`) and let them inform slice scope. ` +
        `See SOUL.md "Ingest recent audit findings".\n\n` +
        `Call \`propose_changes\` with trigger_kind='decompose_story' and a SINGLE ` +
        `\`create_convoy_under_initiative\` diff targeting initiative_id='${parent.id}'. ` +
        `Do NOT emit \`create_task_under_initiative\` — that path is reserved for ` +
        `notes-intake / manual / audit follow-ups; the schema rejects flat-task ` +
        `diffs from decompose-flow proposals (see docs/reference/pm-convoy-mandate.md).\n\n` +
        `Convoy shape (see your SOUL.md "Decomposition output contract"):\n` +
        `  - \`parent_acceptance_criteria\`: 1-3 FEATURE-shaped criteria the operator ` +
        `validates before parent task transitions to done. NOT contract-shaped (no ` +
        `"endpoint returns 200" at the parent level). Example good: "Operator clicks ` +
        `X and Y happens." Example bad: "Endpoint returns 200."\n` +
        `  - \`slices\`: each = one PR by one role, independently reviewable. Bias ` +
        `toward FEWER, FATTER slices — if two candidate slices would ride in the ` +
        `same PR by the same role, fuse them. Do not emit a 1-slice convoy that ` +
        `lacks observable operator-facing behavior on its own.\n` +
        `  - Per-slice \`depends_on\`: cite slice ids that must complete first. ` +
        `Linear chains are common; fan-out is allowed when slices are independent.\n` +
        `  - Per-slice \`acceptance_criteria\`: contract-shaped is fine here (the ` +
        `slice is the unit-of-work contract).\n\n` +
        `Output discipline: tool call FIRST, then a short confirmation sentence — ` +
        `do NOT echo the id or use \`{...}\` placeholder syntax (the operator UI discards freeform replies).`,
    });
    const proposal = dispatch.proposal;

    try {
      const ctx = {
        trigger_kind: 'decompose_story' as const,
        target_initiative_id: parent.id,
        origin: 'pm_dispatch' as const,
      };
      postPmChatMessage({
        workspace_id: parent.workspace_id,
        role: 'user',
        content:
          `Create tasks: "${parent.title}"` +
          (parsed.data.hint ? ` (hint: ${parsed.data.hint})` : ''),
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
      serverLog.warn('pm-decompose-story', `chat insert failed: ${(err as Error).message}`);
    }

    return NextResponse.json({ proposal }, { status: 201 });
  } catch (err) {
    if (err instanceof PmProposalValidationError) {
      return NextResponse.json({ error: err.message, hints: err.hints }, { status: 400 });
    }
    const msg = err instanceof Error ? err.message : 'Failed to decompose story';
    logApiError({ route: '/api/pm/decompose-story', method: 'POST', status: 500, error: err });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * GET /api/pm/decompose-story?workspace_id=…&initiative_id=…
 *
 * Resume-lookup. Returns the latest draft decompose_story proposal for
 * the given story so the modal re-opens the same draft instead of
 * dispatching a fresh one every open.
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
       AND trigger_kind = 'decompose_story'
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
