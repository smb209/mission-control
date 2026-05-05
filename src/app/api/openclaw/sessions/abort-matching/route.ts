/**
 * POST /api/openclaw/sessions/abort-matching
 *
 * "Hard stop" affordance for the agents page. The operator gives a
 * glob (e.g. `*ws-rj-*`, `*recurring-*`); we list every gateway
 * session, abort the ones that match, then scrub the matching rows
 * from MC's local state so a server restart won't resurrect them:
 *
 *   - openclaw_sessions: status='ended', ended_at=now()
 *   - research_cycles / ideation_cycles: status='interrupted'
 *     (autopilot/recovery.ts re-dispatches anything still 'running'
 *      at startup — that's how stale sessions kept coming back)
 *
 * Body: { pattern: string }
 *   `*` is the only wildcard. `*` or `**` alone is rejected (use
 *   the existing /api/openclaw/sessions DELETE for a full nuke).
 *
 * Response:
 *   { pattern, matched, aborted: string[], failed: {id,error}[],
 *     local_marked: { openclaw_sessions, research_cycles,
 *                     ideation_cycles } }
 */

import { NextResponse } from 'next/server';
import { getOpenClawClient } from '@/lib/openclaw/client';
import { getDb } from '@/lib/db';
import { logDebugEvent } from '@/lib/debug-log';

export const dynamic = 'force-dynamic';

function compileGlob(pattern: string): RegExp {
  // Escape regex metachars except `*`, then convert `*` → `.*`.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export async function POST(request: Request) {
  let pattern: unknown;
  try {
    const body = await request.json();
    pattern = body?.pattern;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (typeof pattern !== 'string' || !pattern.trim()) {
    return NextResponse.json({ error: 'pattern is required' }, { status: 400 });
  }
  const trimmed = pattern.trim();
  if (trimmed === '*' || trimmed === '**') {
    return NextResponse.json(
      {
        error:
          'pattern too broad — use the "Reset all sessions" button for a full nuke',
      },
      { status: 400 },
    );
  }

  const re = compileGlob(trimmed);

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

  // The gateway's `sessions.list` RPC returns either a bare array
  // OR an envelope `{ sessions: [...] }` (the current shape on this
  // build). Each entry's session-key field is `key` (not `id`). The
  // OpenClawSessionInfo TS type lies about both, so we treat the
  // payload as unknown and unwrap defensively.
  let raw: unknown;
  try {
    raw = await client.listSessions();
  } catch (err) {
    return NextResponse.json(
      { error: `sessions.list failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  type GwSessionLike = { key?: string; id?: string };
  const sessionList: GwSessionLike[] = Array.isArray(raw)
    ? (raw as GwSessionLike[])
    : Array.isArray((raw as { sessions?: unknown })?.sessions)
      ? ((raw as { sessions: GwSessionLike[] }).sessions)
      : [];

  const sessionKeyOf = (s: GwSessionLike): string => s.key ?? s.id ?? '';
  const matched = sessionList
    .map(sessionKeyOf)
    .filter((k) => k && re.test(k))
    .map((k) => ({ id: k }));
  const aborted: string[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const s of matched) {
    try {
      await client.abortSession(s.id);
      aborted.push(s.id);
      logDebugEvent({
        type: 'session.end',
        direction: 'outbound',
        sessionKey: s.id,
        metadata: { reason: 'hard_stop_matching', pattern: trimmed, op: 'sessions.abort' },
      });
    } catch (err) {
      failed.push({ id: s.id, error: (err as Error).message });
    }
  }

  // Local-state scrub. We update by exact session_key match against
  // the keys we successfully aborted (or matched, even if abort
  // failed — the operator's intent is clear, and leaving the row in
  // a 'running' state will trip autopilot recovery on next boot).
  const db = getDb();
  const keysToScrub = matched.map((s) => s.id);
  let openclawSessionRows = 0;
  let researchCycleRows = 0;
  let ideationCycleRows = 0;
  if (keysToScrub.length > 0) {
    const placeholders = keysToScrub.map(() => '?').join(',');
    openclawSessionRows = db
      .prepare(
        `UPDATE openclaw_sessions
            SET status = 'ended', ended_at = ?, updated_at = ?
          WHERE openclaw_session_id IN (${placeholders})
            AND status != 'ended'`,
      )
      .run(new Date().toISOString(), new Date().toISOString(), ...keysToScrub).changes;

    // research_cycles / ideation_cycles use `session_key` (not
    // openclaw_session_id) — see autopilot/recovery.ts.
    researchCycleRows = db
      .prepare(
        `UPDATE research_cycles
            SET status = 'interrupted',
                error_message = COALESCE(error_message, 'hard-stopped via abort-matching'),
                completed_at = ?
          WHERE session_key IN (${placeholders})
            AND status = 'running'`,
      )
      .run(new Date().toISOString(), ...keysToScrub).changes;

    ideationCycleRows = db
      .prepare(
        `UPDATE ideation_cycles
            SET status = 'interrupted',
                error_message = COALESCE(error_message, 'hard-stopped via abort-matching'),
                completed_at = ?
          WHERE session_key IN (${placeholders})
            AND status = 'running'`,
      )
      .run(new Date().toISOString(), ...keysToScrub).changes;
  }

  return NextResponse.json({
    pattern: trimmed,
    matched: matched.length,
    aborted,
    failed,
    local_marked: {
      openclaw_sessions: openclawSessionRows,
      research_cycles: researchCycleRows,
      ideation_cycles: ideationCycleRows,
    },
  });
}
