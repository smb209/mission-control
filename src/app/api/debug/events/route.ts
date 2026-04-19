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

  return NextResponse.json({ events, total });
}

/**
 * DELETE /api/debug/events — wipe all captured rows. Operator-invoked from
 * the /debug UI. Intentionally not soft-delete; debug data has no
 * auditing value after the operator says "clear".
 */
export async function DELETE() {
  const cleared = clearDebugEvents();
  broadcast({ type: 'debug_events_cleared', payload: { cleared } });
  return NextResponse.json({ cleared });
}
