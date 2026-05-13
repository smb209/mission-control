/**
 * POST /api/pm/proposals/bulk-delete
 *
 * Hard-deletes every pm_proposals row in `workspace_id` whose status
 * is in `statuses`. Accepted proposals are silently filtered out — the
 * single-row DELETE endpoint refuses them for the same reason
 * (acceptance has already mutated other tables, and history rows
 * reference their ids). Mirrors that contract for the bulk path.
 *
 * Body: { workspace_id: string, statuses: ('draft'|'rejected'|'superseded'|'accepted')[] }
 * Response: { deleted_count, deleted_ids }
 *
 * Broadcasts one `pm_proposal_deleted` SSE per row so any other
 * connected /pm client refreshes its recents list.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  bulkDeleteProposalsByStatus,
  type PmProposalStatus,
} from '@/lib/db/pm-proposals';
import { broadcast } from '@/lib/events';

export const dynamic = 'force-dynamic';

const STATUS_VALUES = ['draft', 'accepted', 'rejected', 'superseded'] as const;

const Body = z.object({
  workspace_id: z.string().min(1),
  statuses: z.array(z.enum(STATUS_VALUES)).min(1),
});

export async function POST(request: NextRequest) {
  let body: z.infer<typeof Body>;
  try {
    const raw = await request.json();
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'invalid body', issues: parsed.error.format() },
        { status: 400 },
      );
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  let deletedIds: string[];
  try {
    deletedIds = bulkDeleteProposalsByStatus(
      body.workspace_id,
      body.statuses as PmProposalStatus[],
    );
  } catch (err) {
    console.error('[proposals/bulk-delete] failed:', err);
    return NextResponse.json({ error: 'bulk delete failed' }, { status: 500 });
  }

  for (const id of deletedIds) {
    try {
      broadcast({
        type: 'pm_proposal_deleted',
        payload: { proposal_id: id, workspace_id: body.workspace_id },
      });
    } catch {
      // Broadcast best-effort — don't fail the response.
    }
  }

  return NextResponse.json({
    deleted_count: deletedIds.length,
    deleted_ids: deletedIds,
  });
}
