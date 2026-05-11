/**
 * POST /api/agent-notes/:id/restore
 *
 * Un-archive a note. No-op if the note is already active. Returns 404
 * if the note doesn't exist.
 *
 * See docs/archive/audit-actions-and-tracking.md PR 1.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getNote, restoreNote } from '@/lib/db/agent-notes';
import { broadcast } from '@/lib/events';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const existing = getNote(id);
  if (!existing) {
    return NextResponse.json({ error: 'note not found' }, { status: 404 });
  }

  const updated = restoreNote(id);
  if (!updated) {
    return NextResponse.json({ error: 'restore failed' }, { status: 500 });
  }

  broadcast({
    type: 'agent_note_restored',
    payload: {
      note_id: updated.id,
      workspace_id: updated.workspace_id,
    },
  });

  return NextResponse.json({ note: updated });
}
