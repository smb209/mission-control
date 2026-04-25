/**
 * PUT /api/pm/proposals/[id]/diffs
 *
 * Polish B helper. Replaces the proposed_changes array on a draft
 * proposal — used by the Decompose-with-PM modal so the operator can
 * edit the PM's proposed children before accepting.
 *
 * Only allowed when the proposal is still in `draft` status. Re-runs
 * validation against the workspace before persisting so we never let
 * a tampered diff pass.
 *
 * Body:
 *   { proposed_changes: PmDiff[] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getProposal,
  validateProposedChanges,
  PmProposalValidationError,
  type PmDiff,
} from '@/lib/db/pm-proposals';
import { run } from '@/lib/db';

export const dynamic = 'force-dynamic';

const Body = z.object({
  proposed_changes: z.array(z.unknown()),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
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
    const existing = getProposal(id);
    if (!existing) {
      return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
    }
    if (existing.status !== 'draft') {
      return NextResponse.json(
        { error: `Cannot edit diffs on status=${existing.status}` },
        { status: 400 },
      );
    }

    const changes = parsed.data.proposed_changes as PmDiff[];
    const errors = validateProposedChanges(existing.workspace_id, changes);
    if (errors.length > 0) {
      throw new PmProposalValidationError(
        `Invalid proposed_changes: ${errors.length} error(s)`,
        errors,
      );
    }

    run(`UPDATE pm_proposals SET proposed_changes = ? WHERE id = ?`, [
      JSON.stringify(changes),
      id,
    ]);
    return NextResponse.json({ proposal: getProposal(id) });
  } catch (err) {
    if (err instanceof PmProposalValidationError) {
      return NextResponse.json({ error: err.message, hints: err.hints }, { status: 400 });
    }
    const msg = err instanceof Error ? err.message : 'Failed to update diffs';
    console.error('Failed to update proposal diffs:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
