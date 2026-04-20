/**
 * Archive / unarchive a task.
 *
 * Archive is orthogonal to status: any task can be archived and its status is
 * untouched. The board hides is_archived=1 by default. Deliverables stay put,
 * so an archived task can still be revisited and re-downloaded.
 *
 * POST body: { archived: true | false } (defaults to true)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM tasks WHERE id = ?`).get(params.id) as
    | { id: string }
    | undefined;
  if (!existing) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  let archived = true;
  try {
    const body = await request.json().catch(() => ({}));
    if (body && typeof body.archived === 'boolean') archived = body.archived;
  } catch {
    // empty/invalid body is fine — default to archiving
  }

  if (archived) {
    db.prepare(`
      UPDATE tasks
         SET is_archived = 1,
             archived_at = datetime('now'),
             updated_at = datetime('now')
       WHERE id = ?
    `).run(params.id);
  } else {
    db.prepare(`
      UPDATE tasks
         SET is_archived = 0,
             archived_at = NULL,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(params.id);
  }

  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(params.id) as Task;

  broadcast({
    type: archived ? 'task_archived' : 'task_unarchived',
    payload: task,
  });

  return NextResponse.json(task);
}
