import { NextRequest, NextResponse } from 'next/server';
import { queryAll } from '@/lib/db';
import { getInitiative } from '@/lib/db/initiatives';

export const dynamic = 'force-dynamic';

interface BriefWithStatusRow {
  id: string;
  title: string;
  agent_run_id: string;
  template: string;
  topic_id: string | null;
  initiative_id: string | null;
  summary: string | null;
  citations_json: string | null;
  error_md: string | null;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
  run_status: string;
  run_completed_at: string | null;
}

interface BriefWithStatus {
  id: string;
  title: string;
  agent_run_id: string;
  template: string;
  topic_id: string | null;
  initiative_id: string | null;
  summary: string | null;
  citations: Array<{ url: string; title?: string; accessed_at?: string; snippet?: string }>;
  error_md: string | null;
  source_ref: string | null;
  status: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * GET /api/initiatives/[id]/briefs
 *
 * Lists briefs scoped to this initiative with the agent_run.status
 * already joined in. Used by InitiativeDetailView's Research section
 * so the UI doesn't have to N+1 fetch run status per brief.
 */
export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const initiative = getInitiative(id);
    if (!initiative) {
      return NextResponse.json({ error: 'Initiative not found' }, { status: 404 });
    }
    const rows = queryAll<BriefWithStatusRow>(
      `SELECT b.id, b.title, b.agent_run_id, b.template, b.topic_id, b.initiative_id,
              b.summary, b.citations_json, b.error_md, b.source_ref,
              b.created_at, b.updated_at,
              r.status AS run_status, r.completed_at AS run_completed_at
         FROM briefs b
         LEFT JOIN agent_runs r ON r.id = b.agent_run_id
        WHERE b.initiative_id = ?
        ORDER BY b.created_at DESC, b.rowid DESC
        LIMIT 100`,
      [id],
    );
    const out: BriefWithStatus[] = rows.map(r => ({
      id: r.id,
      title: r.title,
      agent_run_id: r.agent_run_id,
      template: r.template,
      topic_id: r.topic_id,
      initiative_id: r.initiative_id,
      summary: r.summary,
      citations: parseCitations(r.citations_json),
      error_md: r.error_md,
      source_ref: r.source_ref,
      status: r.run_status ?? 'unknown',
      completed_at: r.run_completed_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
    return NextResponse.json(out);
  } catch (error) {
    console.error('Failed to list briefs for initiative:', error);
    const msg = error instanceof Error ? error.message : 'Failed to list briefs';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function parseCitations(json: string | null): Array<{ url: string; title?: string }> {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(c => c && typeof c.url === 'string');
  } catch {
    return [];
  }
}
