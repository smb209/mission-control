/**
 * GET /api/jobs/:id/artifacts
 *
 * Backs the JobDetailDrawer's "Artifacts" panel — what did this run
 * actually produce? Two sources, joined by what we can prove:
 *
 *   - notes: agent_notes where scope_key = run.scope_key. (Notes are
 *     scope-keyed by design; the same scope_key the run wrote against
 *     is the one any take_note calls during the run will carry.)
 *
 *   - deliverables: task_deliverables where task_id = run.task_id AND
 *     created_at >= run.started_at. (task_deliverables predates the
 *     run model so there's no run_id column. Filtering by
 *     created_at >= started_at is the best signal for "produced by
 *     this run" without a schema migration. Initiative-scoped runs
 *     have no task_id and so return [] for deliverables.)
 *
 * The endpoint is meant to be polled while the run is in-flight so
 * operators can watch artifacts land in real time.
 */

import { NextRequest, NextResponse } from 'next/server';
import { queryAll } from '@/lib/db';
import { getAgentRun } from '@/lib/db/agent-runs';

export const dynamic = 'force-dynamic';

interface NoteRow {
  id: string;
  task_id: string | null;
  initiative_id: string | null;
  kind: string;
  audience: string | null;
  body: string;
  importance: number;
  attached_files: string | null;
  archived_at: string | null;
  created_at: string;
}

interface DeliverableRow {
  id: string;
  task_id: string;
  deliverable_type: string;
  title: string;
  path: string | null;
  description: string | null;
  size_bytes: number | null;
  role: string;
  created_at: string;
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: 'job id required' }, { status: 400 });
  }
  const run = getAgentRun(id);
  if (!run) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }

  // Notes by scope_key. Skip when the run never claimed a scope_key
  // (legacy rows from before scope-keyed dispatch).
  const notes: NoteRow[] = run.scope_key
    ? queryAll<NoteRow>(
        `SELECT id, task_id, initiative_id, kind, audience, body, importance,
                attached_files, archived_at, created_at
           FROM agent_notes
          WHERE scope_key = ?
          ORDER BY importance DESC, created_at ASC`,
        [run.scope_key],
      )
    : [];

  // Deliverables: only meaningful when the run was task-scoped, and
  // only after started_at so we don't misattribute pre-existing rows.
  const deliverables: DeliverableRow[] =
    run.task_id && run.started_at
      ? queryAll<DeliverableRow>(
          `SELECT id, task_id, deliverable_type, title, path, description,
                  size_bytes, role, created_at
             FROM task_deliverables
            WHERE task_id = ?
              AND role = 'output'
              AND created_at >= ?
            ORDER BY created_at ASC`,
          [run.task_id, run.started_at],
        )
      : [];

  return NextResponse.json({
    run_id: run.id,
    notes: notes.map((n) => ({
      ...n,
      attached_files: n.attached_files
        ? safeParseStringArray(n.attached_files)
        : [],
    })),
    deliverables,
  });
}

function safeParseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return [];
}
