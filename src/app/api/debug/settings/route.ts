import { NextRequest, NextResponse } from 'next/server';
import { broadcast } from '@/lib/events';
import { isDebugCollectionEnabled, setDebugCollectionEnabled } from '@/lib/debug-log';

export const dynamic = 'force-dynamic';

/** GET /api/debug/settings — returns { collection_enabled } */
export async function GET() {
  return NextResponse.json({ collection_enabled: isDebugCollectionEnabled() });
}

/**
 * POST /api/debug/settings — body: { collection_enabled: boolean }
 *
 * Toggles capture. When turning OFF, existing rows are preserved so the
 * operator can still inspect them; use DELETE /api/debug/events to wipe.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  if (typeof body.collection_enabled !== 'boolean') {
    return NextResponse.json(
      { error: 'collection_enabled must be a boolean' },
      { status: 400 }
    );
  }

  setDebugCollectionEnabled(body.collection_enabled);
  broadcast({
    type: 'debug_collection_toggled',
    payload: { collection_enabled: body.collection_enabled },
  });
  return NextResponse.json({ collection_enabled: body.collection_enabled });
}
