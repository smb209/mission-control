import { NextResponse } from 'next/server';
import { getOpenClawClient } from '@/lib/openclaw/client';

export const dynamic = 'force-dynamic';

/**
 * GET /api/openclaw/connection
 *
 * Tiny pollable endpoint for surfacing the gateway connection state
 * to the UI. Distinct from /api/openclaw/status (which actively tries
 * to reconnect + lists sessions). This one is read-only — it asks
 * `client.isConnected()` and returns. No side effects, fast enough
 * to call on a refresh tick.
 */
export async function GET() {
  try {
    const client = getOpenClawClient();
    return NextResponse.json({ connected: client.isConnected() });
  } catch {
    // If the client itself can't be instantiated (e.g. malformed env),
    // treat that as not-connected so the UI can surface the warning.
    return NextResponse.json({ connected: false });
  }
}
