/**
 * Raw bytes for a single file deliverable.
 *
 * Powers the in-browser viewer (currently markdown). Returns the file body
 * inline (no Content-Disposition: attachment) so it can be fetched and
 * rendered client-side. Path resolution + traversal safety go through
 * resolveDeliverableReadPath() so MC-managed and legacy host-only rows
 * behave identically to the download route.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createReadStream } from 'fs';
import { Readable } from 'stream';
import { getDb } from '@/lib/db';
import {
  resolveDeliverableReadPath,
  mimeTypeForPath,
  fileSizeBytes,
  DeliverableReadError,
} from '@/lib/deliverables/storage';
import type { TaskDeliverable } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const db = getDb();
  const deliverable = db.prepare(`SELECT * FROM task_deliverables WHERE id = ?`).get(params.id) as
    | TaskDeliverable
    | undefined;

  if (!deliverable) {
    return NextResponse.json({ error: 'Deliverable not found' }, { status: 404 });
  }
  if (deliverable.deliverable_type !== 'file') {
    return NextResponse.json(
      { error: 'Only file deliverables can be viewed' },
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

  const nodeStream = createReadStream(absPath);
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': 'private, max-age=0, must-revalidate',
  };
  if (size !== undefined) headers['Content-Length'] = String(size);

  return new NextResponse(webStream, { status: 200, headers });
}
