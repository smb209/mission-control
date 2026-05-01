import { NextResponse } from 'next/server';
import { syncGatewayAgentsToCatalog } from '@/lib/agent-catalog-sync';

export const dynamic = 'force-dynamic';

/**
 * Force-sync the local agent catalog from the OpenClaw gateway. The
 * background sync runs every 60s and on dispatch/PATCH; this endpoint
 * lets the operator trigger one immediately when they've edited an
 * agent in OpenClaw and want the change (model, name, etc.) to
 * propagate without waiting for the timer.
 */
export async function POST(): Promise<NextResponse> {
  try {
    const synced = await syncGatewayAgentsToCatalog({
      force: true,
      reason: 'manual',
    });
    return NextResponse.json({ synced });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Sync failed';
    console.error('[POST /api/agents/sync] failed:', error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
