/**
 * POST /api/initiatives/:id/proposals/:proposalId/reject
 *
 * Reject a single audit_proposal with a required reason. No mutation —
 * just records a `kind: 'decision'` note and marks the proposal
 * consumed by the operator-review stage.
 *
 * Returns 200 on success, 400 on validation, 404 if missing, 409 if
 * already consumed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { rejectProposal } from '@/lib/agents/audit-proposals/operator-actions';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string; proposalId: string }>;
}

const RejectSchema = z.object({
  reason: z.string().trim().min(1, 'reason is required'),
});

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  try {
    const { proposalId } = await params;
    const raw = await request.json().catch(() => ({}));
    const parsed = RejectSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }

    const outcome = rejectProposal(proposalId, parsed.data.reason);
    if (!outcome.ok) {
      const status =
        outcome.kind === 'not_found'
          ? 404
          : outcome.kind === 'already_consumed'
            ? 409
            : 400;
      return NextResponse.json(
        { error: outcome.message, kind: outcome.kind },
        { status },
      );
    }

    return NextResponse.json({
      ok: true,
      decision_note_id: outcome.decisionNoteId,
      target_id: outcome.targetId,
    });
  } catch (error) {
    console.error('[proposals/reject] route error:', error);
    return NextResponse.json(
      { error: (error as Error).message ?? 'Internal server error' },
      { status: 500 },
    );
  }
}
