/**
 * GET /api/jobs/:id
 *
 * Backs the /jobs drill-down side panel (PR 5). Returns the full
 * agent_runs row for one id — same shape as the AgentRun DAO type
 * plus a derived label and the linked initiative title (best-effort
 * join) for headers. trigger_body and error_md ride through verbatim
 * so the side panel can render them without a second fetch.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentRun } from '@/lib/db/agent-runs';
import { queryOne } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: 'job id required' }, { status: 400 });
  }
  const row = getAgentRun(id);
  if (!row) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }
  // Best-effort initiative title for the header. Cheap single-row
  // lookup; null if the row doesn't reference an initiative or the
  // initiative was deleted.
  let initiative_title: string | null = null;
  if (row.initiative_id) {
    const init = queryOne<{ title: string }>(
      `SELECT title FROM initiatives WHERE id = ?`,
      [row.initiative_id],
    );
    initiative_title = init?.title ?? null;
  }
  return NextResponse.json({ ...row, initiative_title });
}
