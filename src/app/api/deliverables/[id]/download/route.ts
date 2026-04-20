/**
 * Download a single task deliverable as a file.
 *
 * Only works for file-type deliverables. URL and artifact types are not
 * downloadable. Legacy 'host' rows are served too, provided MC can read the
 * path (i.e. same-host or shared mount) — otherwise 404.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createReadStream } from 'fs';
import { Readable } from 'stream';
import path from 'path';
import { getDb } from '@/lib/db';
import {
  resolveDeliverableReadPath,
  mimeTypeForPath,
  fileSizeBytes,
  DeliverableReadError,
} from '@/lib/deliverables/storage';
import type { TaskDeliverable } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const db = getDb();
  const deliverable = db.prepare(`SELECT * FROM task_deliverables WHERE id = ?`).get(params.id) as
    | TaskDeliverable
    | undefined;

  if (!deliverable) {
    return NextResponse.json({ error: 'Deliverable not found' }, { status: 404 });
  }
  if (deliverable.deliverable_type !== 'file') {
    return NextResponse.json(
      { error: 'Only file deliverables can be downloaded' },
      { status: 400 }
    );
  }

  let absPath: string;
  try {
    absPath = resolveDeliverableReadPath(deliverable);
  } catch (e) {
    if (e instanceof DeliverableReadError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  const size = fileSizeBytes(absPath);
  const contentType = mimeTypeForPath(absPath);
  const downloadName = path.basename(absPath);

  const nodeStream = createReadStream(absPath);
  // Next.js accepts a Web ReadableStream for the body; convert Node → Web.
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${encodeURIComponent(downloadName)}"`,
  };
  if (size !== undefined) headers['Content-Length'] = String(size);

  return new NextResponse(webStream, { status: 200, headers });
}
