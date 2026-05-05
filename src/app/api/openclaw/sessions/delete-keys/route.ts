/**
 * POST /api/openclaw/sessions/delete-keys
 *
 * Companion to abort-matching. Takes an explicit list of session
 * keys and deletes each from the gateway via `sessions.delete`,
 * then drops the corresponding `openclaw_sessions` rows so the
 * agents page session matrix forgets them too.
 *
 * Body: { keys: string[] }   // explicit, no globbing — caller
 *                            // already resolved the keys via
 *                            // abort-matching.
 *
 * Response:
 *   { deleted: string[], failed: {key,error}[],
 *     local_rows_removed: number }
 */

import { NextResponse } from 'next/server';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { getDb } from '@/lib/db';
import { logDebugEvent } from '@/lib/debug-log';

export const dynamic = 'force-dynamic';

const MAX_KEYS = 1000;

export async function POST(request: Request) {
  let keys: unknown;
  try {
    const body = await request.json();
    keys = body?.keys;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (!Array.isArray(keys) || keys.length === 0) {
    return NextResponse.json({ error: 'keys (non-empty string[]) is required' }, { status: 400 });
  }
  const keyList = keys.filter((k): k is string => typeof k === 'string' && k.trim().length > 0);
  if (keyList.length === 0) {
    return NextResponse.json({ error: 'keys contained no valid strings' }, { status: 400 });
  }
  if (keyList.length > MAX_KEYS) {
    return NextResponse.json(
      { error: `too many keys (${keyList.length} > ${MAX_KEYS}); split into batches` },
      { status: 400 },
    );
  }

  const client = getOpenClawClient();
  if (!client.isConnected()) {
    try {
      await client.connect();
    } catch (err) {
      return NextResponse.json(
        { error: `gateway unreachable: ${(err as Error).message}` },
        { status: 503 },
      );
    }
  }

  const deleted: string[] = [];
  const failed: { key: string; error: string }[] = [];

  for (const key of keyList) {
    try {
      await client.deleteSession(key);
      deleted.push(key);
      logDebugEvent({
        type: 'session.end',
        direction: 'outbound',
        sessionKey: key,
        metadata: { reason: 'hard_stop_delete', op: 'sessions.delete' },
      });
    } catch (err) {
      failed.push({ key, error: (err as Error).message });
    }
  }

  // Drop local openclaw_sessions rows for everything we successfully
  // deleted on the gateway. We don't touch research_cycles /
  // ideation_cycles here — abort-matching already marked those
  // 'interrupted'; deleting them outright would lose audit trail.
  const db = getDb();
  let localRowsRemoved = 0;
  if (deleted.length > 0) {
    const placeholders = deleted.map(() => '?').join(',');
    localRowsRemoved = db
      .prepare(`DELETE FROM openclaw_sessions WHERE openclaw_session_id IN (${placeholders})`)
      .run(...deleted).changes;
  }

  return NextResponse.json({
    deleted,
    failed,
    local_rows_removed: localRowsRemoved,
  });
}
