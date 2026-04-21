import { NextRequest, NextResponse } from 'next/server';
import {
  getDebugEventsForExport,
  type DebugEventFilter,
  type DebugEventType,
  type DebugEventDirection,
} from '@/lib/debug-log';

export const dynamic = 'force-dynamic';

/**
 * GET /api/debug/events/export
 *
 * Same query params as GET /api/debug/events (task_id, agent_id,
 * event_type, direction), plus `format=json|jsonl` (default json).
 * Returns the filtered rows as a downloadable file — the Content-
 * Disposition header triggers a save dialog in the browser rather than
 * rendering in-tab.
 *
 * JSON: a single `{ exported_at, filter, count, events: [...] }` object
 * so the file is self-describing and re-importable.
 *
 * JSONL: one debug_event JSON object per line, newest first. Smaller for
 * large exports and friendlier to stream processors (jq, pandas, etc.).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const format = (searchParams.get('format') || 'json').toLowerCase();
  if (format !== 'json' && format !== 'jsonl') {
    return NextResponse.json({ error: 'format must be json or jsonl' }, { status: 400 });
  }

  const filter: DebugEventFilter = {
    taskId: searchParams.get('task_id') || undefined,
    agentId: searchParams.get('agent_id') || undefined,
    eventType: (searchParams.get('event_type') as DebugEventType | null) || undefined,
    direction: (searchParams.get('direction') as DebugEventDirection | null) || undefined,
  };

  const events = getDebugEventsForExport(filter);

  // Timestamp the filename so successive exports don't overwrite each
  // other in the operator's Downloads folder. Colons are illegal in
  // Windows filenames — swap them for hyphens.
  const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '');
  const filename = `mc-debug-events-${stamp}.${format}`;

  if (format === 'jsonl') {
    const body = events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  }

  const body = JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      filter: {
        task_id: filter.taskId ?? null,
        agent_id: filter.agentId ?? null,
        event_type: filter.eventType ?? null,
        direction: filter.direction ?? null,
      },
      count: events.length,
      events,
    },
    null,
    2,
  );
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
