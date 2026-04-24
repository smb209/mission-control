/**
 * Workspace-scoped deliverable search.
 *
 * Used by the TaskModal's "Reference prior deliverable" picker on the create
 * flow. Returns only role='output' rows — the point of the picker is to
 * attach a past *agent-produced* artifact as an input on the new task; an
 * input can't reference another input.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface DeliverableSearchRow {
  id: string;
  task_id: string;
  task_title: string;
  deliverable_type: string;
  title: string;
  path: string | null;
  description: string | null;
  storage_scheme: string | null;
  created_at: string;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspace_id');
  const q = (url.searchParams.get('q') || '').trim();
  const excludeTaskId = url.searchParams.get('exclude_task_id');
  const limit = Math.min(Number(url.searchParams.get('limit') || 20), 50);

  if (!workspaceId) {
    return NextResponse.json({ error: 'workspace_id is required' }, { status: 400 });
  }

  const db = getDb();
  const params: Array<string | number> = [workspaceId];
  let where = `t.workspace_id = ? AND d.role = 'output'`;

  if (excludeTaskId) {
    where += ` AND d.task_id != ?`;
    params.push(excludeTaskId);
  }

  if (q) {
    where += ` AND (d.title LIKE ? OR d.description LIKE ? OR t.title LIKE ?)`;
    const like = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`;
    params.push(like, like, like);
  }

  params.push(limit);

  const rows = db.prepare(
    `SELECT
       d.id, d.task_id, t.title as task_title, d.deliverable_type,
       d.title, d.path, d.description, d.storage_scheme, d.created_at
     FROM task_deliverables d
     JOIN tasks t ON t.id = d.task_id
     WHERE ${where}
     ORDER BY d.created_at DESC
     LIMIT ?`
  ).all(...params) as DeliverableSearchRow[];

  return NextResponse.json({ results: rows });
}
