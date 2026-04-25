/**
 * POST /api/pm/proposals/[id]/accept
 *
 *   body: { applied_by_agent_id?: string }
 *
 * Applies the proposal's diff list transactionally. Returns the updated
 * proposal + a count of changes applied.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { acceptProposal, PmProposalValidationError } from '@/lib/db/pm-proposals';
import { postPmChatMessage } from '@/lib/agents/pm-dispatch';
import { queryOne } from '@/lib/db';

export const dynamic = 'force-dynamic';

const Body = z.object({
  applied_by_agent_id: z.string().min(1).nullish(),
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
