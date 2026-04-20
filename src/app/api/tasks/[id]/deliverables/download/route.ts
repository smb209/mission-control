/**
 * Download all file deliverables for a task as a zip.
 *
 * Skips URL/artifact types. Skips file deliverables that can't be read (404
 * from the storage helper) — the rest still go into the archive.
 */

import { NextRequest, NextResponse } from 'next/server';
import { PassThrough } from 'stream';
import { Readable } from 'stream';
import path from 'path';
import archiver from 'archiver';
import { getDb } from '@/lib/db';
import {
  resolveDeliverableReadPath,
  DeliverableReadError,
} from '@/lib/deliverables/storage';
import type { Task, TaskDeliverable } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const db = getDb();
  const task = db.prepare(`SELECT id, title FROM tasks WHERE id = ?`).get(params.id) as
    | Pick<Task, 'id' | 'title'>
    | undefined;

  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  const deliverables = db.prepare(`
    SELECT * FROM task_deliverables
    WHERE task_id = ? AND deliverable_type = 'file'
    ORDER BY created_at ASC
  `).all(params.id) as TaskDeliverable[];

  const entries: { absPath: string; name: string }[] = [];
  for (const d of deliverables) {
    try {
      const absPath = resolveDeliverableReadPath(d);
      // Entry name is suffixed with the deliverable id to keep archive entries
      // unique even when two deliverables share a filename.
      const ext = path.extname(absPath);
      const base = path.basename(absPath, ext);
      entries.push({ absPath, name: `${base}-${d.id}${ext}` });
    } catch (e) {
      if (e instanceof DeliverableReadError) {
        // Silently skip unreadable rows — don't fail the whole zip.
        console.warn(`[deliverables zip] Skipping ${d.id}: ${e.message}`);
        continue;
      }
      throw e;
    }
  }

  if (entries.length === 0) {
    return NextResponse.json(
      { error: 'No downloadable deliverables for this task' },
      { status: 404 }
    );
  }

  const archive = archiver('zip', { zlib: { level: 6 } });
  const pass = new PassThrough();
  archive.pipe(pass);

  for (const entry of entries) {
    archive.file(entry.absPath, { name: entry.name });
  }
  archive.finalize();

  archive.on('error', (err) => {
    console.error('[deliverables zip] archive error', err);
    pass.destroy(err);
  });

  const slug = (task.title || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'task';
  const zipName = `${slug}-deliverables.zip`;

  const webStream = Readable.toWeb(pass) as unknown as ReadableStream;
  return new NextResponse(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(zipName)}"`,
    },
  });
}
