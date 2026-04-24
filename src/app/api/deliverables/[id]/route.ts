/**
 * Single-deliverable metadata fetch. Powers the standalone viewer page so it
 * can show title/path/type without scraping the per-task list endpoint.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import type { TaskDeliverable } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM task_deliverables WHERE id = ?`)
    .get(params.id) as TaskDeliverable | undefined;
  if (!row) return NextResponse.json({ error: 'Deliverable not found' }, { status: 404 });
  return NextResponse.json(row);
}
