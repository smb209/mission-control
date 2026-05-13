/**
 * GET    /api/pm/proposals/[id] — fetch one proposal.
 * DELETE /api/pm/proposals/[id] — hard-delete (operator dismiss).
 *
 * DELETE is a destructive operator action, distinct from /reject which
 * marks status='rejected' for audit. Use delete to clear the row out
 * entirely when it has no audit value (placeholders, mistakes, test
 * runs). Refuses to delete `accepted` rows since acceptance has
 * already mutated other tables (initiatives, tasks, dependencies)
 * and the proposal id is referenced from history rows.
 */

import { NextRequest, NextResponse } from 'next/server';
import { logApiError } from '@/lib/debug-log';
import { getProposal, deleteProposal } from '@/lib/db/pm-proposals';
import { broadcast } from '@/lib/events';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const proposal = getProposal(id);
  if (!proposal) {
    return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
  }
  return NextResponse.json(proposal);
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const proposal = getProposal(id);
  if (!proposal) {
    return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
  }
  if (proposal.status === 'accepted') {
    return NextResponse.json(
      {
        error:
          'Cannot delete an accepted proposal — its diffs already mutated initiatives/tasks. Reject + revert if you need to undo.',
      },
      { status: 409 },
    );
  }
  try {
    deleteProposal(id);
  } catch (err) {
    logApiError({ route: '/api/pm/proposals/[id]', method: 'DELETE', status: 500, error: err });
    return NextResponse.json({ error: 'Delete failed' }, { status: 500 });
  }
  // Broadcast so the /pm recents list refreshes for any open clients.
  broadcast({
    type: 'pm_proposal_deleted',
    payload: { proposal_id: id, workspace_id: proposal.workspace_id },
  });
  return NextResponse.json({ ok: true, id });
}
