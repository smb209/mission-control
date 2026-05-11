/**
 * DELETE /api/agent-notes/:id
 *
 * Hard-delete a note. The note MUST be archived first (two-step intent —
 * archive, then empty-the-trash). Returns 409 if the note is still active.
 *
 * UI must gate this behind `ConfirmDialog destructive` per project
 * convention. See docs/archive/audit-actions-and-tracking.md PR 1.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  AgentNoteNotArchivedError,
  getNote,
  hardDeleteNote,
} from '@/lib/db/agent-notes';
import { broadcast } from '@/lib/events';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const existing = getNote(id);
  if (!existing) {
    return NextResponse.json({ error: 'note not found' }, { status: 404 });
  }

  try {
    const ok = hardDeleteNote(id);
    if (!ok) {
      // Race: existed at the GET above, gone by the DELETE. Treat as
      // already-deleted success rather than a 500.
      return NextResponse.json({ ok: true, already_deleted: true });
    }
  } catch (err) {
    if (err instanceof AgentNoteNotArchivedError) {
      return NextResponse.json(
        { error: 'note must be archived before delete' },
        { status: 409 },
      );
    }
    throw err;
  }

  broadcast({
    type: 'agent_note_deleted',
    payload: {
      note_id: id,
      workspace_id: existing.workspace_id,
    },
  });

  return NextResponse.json({ ok: true });
}
