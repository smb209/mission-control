/**
 * POST /api/pm/proposals/[id]/revert
 *
 * Synthesize the inverse of an accepted proposal and persist it as a
 * NEW draft proposal — the operator must accept it through the normal
 * review/accept flow before any state is mutated.
 *
 * Body:
 *   - { } (no fields required today)
 *
 * Response:
 *   - 201 with the new draft proposal + per-diff `notes` (one entry
 *     per source diff, including any 'limited' explanations the UI can
 *     surface as warning chips).
 *   - 404 when the source proposal isn't found.
 *   - 409 when the source isn't in status='accepted'.
 *   - 422 when every source diff was 'limited' (nothing to revert).
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createProposal,
  getProposal,
  PmProposalValidationError,
} from '@/lib/db/pm-proposals';
import { invertProposalDiffs } from '@/lib/pm/invertDiff';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const source = getProposal(id);
  if (!source) {
    return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
  }
  if (source.status !== 'accepted') {
    return NextResponse.json(
      {
        error: `Only accepted proposals can be reverted (this one is '${source.status}')`,
      },
      { status: 409 },
    );
  }

  const { diffs, notes } = invertProposalDiffs(source.proposed_changes);

  if (diffs.length === 0) {
    return NextResponse.json(
      {
        error:
          'Nothing to revert — every diff in this proposal pre-dates the capture pattern or has no defined inverse.',
        notes,
      },
      { status: 422 },
    );
  }

  const limitedCount = notes.filter(n => n.status === 'limited').length;
  const summary = limitedCount > 0
    ? `### Revert proposal\n\nInverts proposal \`${source.id}\` (${notes.length} forward diff${notes.length === 1 ? '' : 's'}, ${limitedCount} unrevertable — see per-diff notes).`
    : `### Revert proposal\n\nInverts proposal \`${source.id}\` (${notes.length} forward diff${notes.length === 1 ? '' : 's'}).`;

  // The trigger_text envelope mirrors the shape used elsewhere in
  // pm-dispatch (JSON with a `mode` discriminator) so future filters
  // and the resume/lookup endpoints can introspect cleanly.
  const triggerText = JSON.stringify({
    mode: 'revert',
    source_proposal_id: source.id,
  });

  try {
    const draft = createProposal({
      workspace_id: source.workspace_id,
      trigger_text: triggerText,
      trigger_kind: 'revert',
      impact_md: summary,
      proposed_changes: diffs,
      reverts_proposal_id: source.id,
      target_initiative_id: source.target_initiative_id,
    });
    return NextResponse.json({ proposal: draft, notes }, { status: 201 });
  } catch (e) {
    if (e instanceof PmProposalValidationError) {
      return NextResponse.json(
        { error: e.message, hints: e.hints, notes },
        { status: 400 },
      );
    }
    throw e;
  }
}
