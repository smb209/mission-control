import { NextResponse } from 'next/server';
import { getOpenClawClient } from '@/lib/openclaw/client';

export const dynamic = 'force-dynamic';

/**
 * GET /api/openclaw/connection
 *
 * Pollable endpoint for surfacing the gateway connection state to the
 * UI. Distinct from /api/openclaw/status, which is the heavyweight
 * "verify connectivity AND list sessions" endpoint.
 *
 * Behavior:
 *   - Reports the current `isConnected()` state immediately (no
 *     blocking wait).
 *   - When the client reports as NOT connected, fires `connect()` in
 *     the background. The next poll (typically 5s later in the UI)
 *     will then see `connected: true`.
 *
 * Why the lazy kick: the openclaw client is created lazily; on a
 * fresh dev server boot the first read of `isConnected()` returns
 * false because the client hasn't tried yet. Without this trigger
 * the gateway only wakes up when something else (e.g. the agents
 * page hitting a session call) hits the right endpoint, which is
 * confusing UX. `connect()` dedupes in-flight attempts so calling
 * it on every miss is safe.
 */
export async function GET() {
  try {
    const client = getOpenClawClient();
    const connected = client.isConnected();
    if (!connected) {
      // Fire-and-forget. We deliberately don't await — the UI polls
      // again in a few seconds, and connect() can take longer than
      // we want to keep the browser hanging on a single GET.
      client.connect().catch(err => {
        console.warn('[openclaw/connection] background reconnect failed:', err?.message ?? err);
      });
    }
    return NextResponse.json({ connected });
  } catch {
    return NextResponse.json({ connected: false });
  }
}
