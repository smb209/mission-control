/**
 * GET /api/initiatives/:id/proposals
 *
 * Aggregation endpoint that powers the operator-facing audit-proposal
 * queue (Phase 6, specs/subtree-audit-proposals-spec.md §8).
 *
 * Returns:
 *   {
 *     synthesis:  AuditSynthesisNote | null,   // most recent on root
 *     proposals:  AuditProposalNote[],         // most recent per descendant
 *     bulk_accept_available: boolean,
 *   }
 *
 * "Descendant" for v1 = the initiative itself + its **immediate
 * children** (no deep recursion). Deeper subtree audits surface there
 * naturally as their own root.
 *
 * Filters out proposals already consumed by the operator-review stage
 * (accepted or rejected) — those belong in the activity feed, not the
 * live queue. See `isProposalConsumedByOperator`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getInitiative, listInitiatives, type Initiative } from '@/lib/db/initiatives';
import { listNotes, type AgentNote } from '@/lib/db/agent-notes';
import {
  validateAuditNoteBody,
  type AuditProposalBody,
  type AuditSynthesisBody,
} from '@/lib/agents/audit-proposals/schemas';
import {
  isProposalConsumedByOperator,
  isBulkAcceptEnabled,
} from '@/lib/agents/audit-proposals/operator-review';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Shape returned for each non-consumed proposal. The note row + parsed
 * body + a thin slice of the target initiative's current state, so the
 * UI can render the diff (current → proposed) without an extra fetch.
 */
export interface ProposalQueueItem {
  note: AgentNote;
  body: AuditProposalBody;
  target: {
    id: string;
    title: string;
    current_status: Initiative['status'];
    target_end: string | null;
  } | null;
}

export interface ProposalQueueSynthesis {
  note: AgentNote;
  body: AuditSynthesisBody;
}

export interface ProposalQueueResponse {
  synthesis: ProposalQueueSynthesis | null;
  proposals: ProposalQueueItem[];
  bulk_accept_available: boolean;
}

export async function GET(
  _request: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  const { id } = await params;
  const initiative = getInitiative(id);
  if (!initiative) {
    return NextResponse.json(
      { error: 'Initiative not found' },
      { status: 404 },
    );
  }

  // ── synthesis: most recent audit_synthesis on the root ─────────────
  const synthRows = listNotes({
    initiative_id: id,
    kinds: ['audit_synthesis'],
    limit: 1,
    order: 'desc',
  });
  let synthesis: ProposalQueueSynthesis | null = null;
  if (synthRows[0]) {
    const parsed = validateAuditNoteBody('audit_synthesis', synthRows[0].body);
    if (parsed.ok) {
      synthesis = {
        note: synthRows[0],
        body: parsed.parsed as AuditSynthesisBody,
      };
    }
  }

  // ── proposals: latest non-consumed per immediate-descendant node ───
  const children = listInitiatives({
    workspace_id: initiative.workspace_id,
    parent_id: id,
  });
  const targetIds = [id, ...children.map((c) => c.id)];
  const initiativeById = new Map<string, Initiative>([
    [initiative.id, initiative],
    ...children.map((c) => [c.id, c] as const),
  ]);

  const proposals: ProposalQueueItem[] = [];
  for (const nodeId of targetIds) {
    // Pull a small recent window — most recent FIRST. Skip already-
    // consumed ones until we hit the freshest live proposal for this
    // node, then stop. Limiting keeps the query bounded for noisy nodes
    // with many redispatched audits.
    const rows = listNotes({
      initiative_id: nodeId,
      kinds: ['audit_proposal'],
      limit: 10,
      order: 'desc',
    });
    let picked: AgentNote | null = null;
    for (const row of rows) {
      if (isProposalConsumedByOperator(row)) continue;
      picked = row;
      break;
    }
    if (!picked) continue;
    const parsed = validateAuditNoteBody('audit_proposal', picked.body);
    if (!parsed.ok) continue;
    const targetInit = initiativeById.get(nodeId) ?? null;
    proposals.push({
      note: picked,
      body: parsed.parsed as AuditProposalBody,
      target: targetInit
        ? {
            id: targetInit.id,
            title: targetInit.title,
            current_status: targetInit.status,
            target_end: targetInit.target_end,
          }
        : null,
    });
  }

  // Stable order: by target node title, then most-recent first within a
  // node (only one pick per node today, but defensive).
  proposals.sort((a, b) => {
    const ta = a.target?.title ?? '';
    const tb = b.target?.title ?? '';
    if (ta !== tb) return ta.localeCompare(tb);
    return b.note.created_at.localeCompare(a.note.created_at);
  });

  const body: ProposalQueueResponse = {
    synthesis,
    proposals,
    bulk_accept_available: isBulkAcceptEnabled(),
  };
  return NextResponse.json(body);
}
