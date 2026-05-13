import { NextRequest, NextResponse } from 'next/server';
import { broadcast } from '@/lib/events';
import {
  getDebugEvents,
  getDebugEventCount,
  clearDebugEvents,
  type DebugEventFilter,
  type DebugEventType,
  type DebugEventDirection,
} from '@/lib/debug-log';

export const dynamic = 'force-dynamic';

/**
 * GET /api/debug/events
 *
 * Query params (all optional):
 *   task_id, agent_id, event_type, direction, after_id, limit
 *
 * Returns `{ events, total }`. `total` is the unfiltered count so the UI
 * can show "N / M" even when the current filter is narrow.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const filter: DebugEventFilter = {
    taskId: searchParams.get('task_id') || undefined,
    agentId: searchParams.get('agent_id') || undefined,
    eventType: (searchParams.get('event_type') as DebugEventType | null) || undefined,
    direction: (searchParams.get('direction') as DebugEventDirection | null) || undefined,
    afterId: searchParams.get('after_id') || undefined,
    limit: searchParams.get('limit') ? Number(searchParams.get('limit')) : undefined,
  };

  const events = getDebugEvents(filter);
  const total = getDebugEventCount();
  // Always-on error count so the /debug UI can surface "(N errors)" in
  // the header even when the current filter scopes the visible list to
  // something else.
  const error_count = getDebugEventCount('api.error');

  return NextResponse.json({ events, total, error_count });
}

/**
 * DELETE /api/debug/events[?event_type=api.error] — wipe captured rows.
 * Operator-invoked from the /debug UI. Intentionally not soft-delete;
 * debug data has no auditing value after the operator says "clear".
 *
 * `event_type` scopes the delete to one bucket (e.g. clear only
 * `api.error` rows without losing trace history captured during a
 * separate collection session).
 */
export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const eventType = (searchParams.get('event_type') as DebugEventType | null) || undefined;
  const cleared = clearDebugEvents(eventType);
  broadcast({
    type: 'debug_events_cleared',
    payload: eventType ? { cleared, event_type: eventType } : { cleared },
  });
  return NextResponse.json({ cleared, event_type: eventType ?? null });
}
