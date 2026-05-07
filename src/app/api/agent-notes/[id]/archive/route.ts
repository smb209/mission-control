/**
 * POST /api/agent-notes/:id/archive
 *
 * Soft-archive a note from the operator UI. Mirrors the MCP `archive_note`
 * tool but without the agent-auth path — operator action over HTTP.
 *
 * Idempotent: archiving an already-archived note returns the existing row.
 * Body (optional): `{ reason?: string }`.
 *
 * See specs/audit-actions-and-tracking.md PR 1.
 */

import { NextRequest, NextResponse } from 'next/server';
import { archiveNote, getNote } from '@/lib/db/agent-notes';
import { broadcast } from '@/lib/events';

export const dynamic = 'force-dynamic';

interface ArchiveBody {
  reason?: string | null;
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const existing = getNote(id);
  if (!existing) {
    return NextResponse.json({ error: 'note not found' }, { status: 404 });
  }

  let body: ArchiveBody = {};
  try {
    // Body is optional; tolerate empty / non-JSON.
    const text = await request.text();
    if (text.trim()) body = JSON.parse(text) as ArchiveBody;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const reason = typeof body.reason === 'string' ? body.reason : null;
  const updated = archiveNote(id, reason);
  if (!updated) {
    return NextResponse.json({ error: 'archive failed' }, { status: 500 });
  }

  broadcast({
    type: 'agent_note_archived',
    payload: {
      note_id: updated.id,
      workspace_id: updated.workspace_id,
      reason: updated.archived_reason,
      archived_at: updated.archived_at,
    },
  });

  return NextResponse.json({ note: updated });
}
