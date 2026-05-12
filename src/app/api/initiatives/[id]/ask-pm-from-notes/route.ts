/**
 * POST /api/initiatives/:id/ask-pm-from-notes
 *
 * Operator-facing handoff: hand the PM a specific subset of audit notes
 * for this initiative and ask it to propose changes. The PM dispatch
 * uses `trigger_kind='notes_intake'`, the same path the
 * `propose_from_notes` MCP tool walks — the difference is that this
 * route grounds the prompt in *specific* note ids rather than freeform
 * paragraphs.
 *
 * Body:
 *   { note_ids: string[] }   // 1..20 ids; must all belong to this initiative
 *
 * Response:
 *   { proposal_id, awaiting_agent }
 *
 * After dispatch, each note is marked consumed by the `pm_proposal`
 * stage so a second click doesn't re-hand the same note. Operators can
 * still ask again — this is just a subtle "we've already done this"
 * signal in the UI; it does not block.
 *
 * See docs/archive/audit-actions-and-tracking.md PR 5.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  appendNoteProposalId,
  getNote,
  markNoteConsumed,
  type AgentNote,
} from '@/lib/db/agent-notes';
import { getInitiative } from '@/lib/db/initiatives';
import { dispatchPm, PmDispatchGatewayUnavailableError } from '@/lib/agents/pm-dispatch';

export const dynamic = 'force-dynamic';

const Body = z.object({
  note_ids: z.array(z.string().min(1)).min(1).max(20),
});

const CONSUMED_STAGE = 'pm_proposal';

function formatNoteAsTrigger(notes: AgentNote[], initiativeTitle: string): string {
  const lines: string[] = [
    `Please review the following audit note${notes.length === 1 ? '' : 's'} from initiative "${initiativeTitle}" and propose any changes you'd recommend.`,
    '',
    'Each note is one observation surfaced by an audit run; treat them as the primary input. Use the standard `propose_changes` flow with structured diffs (creates / updates on initiatives, draft tasks under them) — do not synthesize a free-text summary.',
    '',
    '---',
    '',
  ];
  for (const n of notes) {
    lines.push(`### Note ${n.id} (${n.kind}, importance ${n.importance})`);
    if (n.role) lines.push(`*from role: ${n.role}*`);
    lines.push('');
    lines.push(n.body);
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  return lines.join('\n');
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const initiative = getInitiative(id);
  if (!initiative) {
    return NextResponse.json({ error: 'initiative not found' }, { status: 404 });
  }

  let body: z.infer<typeof Body>;
  try {
    const raw = await request.json();
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  // Resolve every note id, validate ownership.
  const notes: AgentNote[] = [];
  for (const noteId of body.note_ids) {
    const n = getNote(noteId);
    if (!n) {
      return NextResponse.json(
        { error: `note ${noteId} not found` },
        { status: 404 },
      );
    }
    if (n.initiative_id !== id) {
      return NextResponse.json(
        {
          error: `note ${noteId} does not belong to this initiative`,
        },
        { status: 400 },
      );
    }
    if (n.archived_at) {
      return NextResponse.json(
        { error: `note ${noteId} is archived; restore it before handing to PM` },
        { status: 409 },
      );
    }
    notes.push(n);
  }

  const triggerText = formatNoteAsTrigger(notes, initiative.title);

  try {
    const result = dispatchPm({
      workspace_id: initiative.workspace_id,
      trigger_text: triggerText,
      trigger_kind: 'notes_intake',
      // Same as the MCP path — regex on freeform is worse than nothing.
      allowFallback: false,
    });

    // Mark notes consumed so the UI can fade the "Ask PM" button on
    // a re-render. Also remember the resulting proposal id on each
    // note so the UI can offer a persistent "View proposal" link
    // (survives page reloads). Both operations are idempotent.
    for (const n of notes) {
      try {
        markNoteConsumed(n.id, CONSUMED_STAGE);
        appendNoteProposalId(n.id, result.proposal.id);
      } catch (err) {
        // Best-effort; the dispatch already happened, this is housekeeping.
        console.warn(
          `[ask-pm-from-notes] note bookkeeping failed for ${n.id}:`,
          (err as Error).message,
        );
      }
    }

    return NextResponse.json({
      proposal_id: result.proposal.id,
      awaiting_agent: result.awaiting_agent,
    });
  } catch (err) {
    if (err instanceof PmDispatchGatewayUnavailableError) {
      return NextResponse.json(
        { error: 'PM gateway unavailable. Try again when openclaw is reachable.' },
        { status: 503 },
      );
    }
    throw err;
  }
}
