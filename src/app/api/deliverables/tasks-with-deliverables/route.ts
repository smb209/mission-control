/**
 * Summary list of every task that has at least one deliverable, used by the
 * right-rail "Ready deliverables" panel.
 *
 * Returns a row per task with total count, mc-managed count (i.e. how many are
 * downloadable), status, archived flag, and last_added_at for sorting.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface Row {
  task_id: string;
  task_title: string;
  status: string;
  is_archived: number;
  file_count: number;
  mc_count: number;
  last_added_at: string;
}

export async function GET(request: NextRequest) {
  const db = getDb();
  const workspaceId = request.nextUrl.searchParams.get('workspace_id');

  const params: string[] = [];
  let where = 'WHERE td.deliverable_type = \'file\'';
  if (workspaceId) {
    where += ' AND t.workspace_id = ?';
    params.push(workspaceId);
  }

  const rows = db.prepare(`
    SELECT
      t.id AS task_id,
      t.title AS task_title,
      t.status AS status,
      COALESCE(t.is_archived, 0) AS is_archived,
      COUNT(td.id) AS file_count,
      SUM(CASE WHEN COALESCE(td.storage_scheme, 'host') = 'mc' THEN 1 ELSE 0 END) AS mc_count,
      MAX(td.created_at) AS last_added_at
    FROM task_deliverables td
    JOIN tasks t ON t.id = td.task_id
    ${where}
    GROUP BY t.id
    ORDER BY MAX(td.created_at) DESC
  `).all(...params) as Row[];

  return NextResponse.json(rows);
}
