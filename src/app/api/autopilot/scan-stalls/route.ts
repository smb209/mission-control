import { NextRequest, NextResponse } from 'next/server';
import { scanStalledCycles } from '@/lib/autopilot/stall-detection';

export const dynamic = 'force-dynamic';

/**
 * POST /api/autopilot/scan-stalls
 *
 * Manual trigger for the autopilot cycle stall scanner. The scanner also
 * runs automatically every 2 minutes as part of runHealthCheckCycle
 * (alongside the task-side scanStalledTasks). Use this endpoint for an
 * immediate pass — e.g. from an external cron, or when debugging an
 * autopilot cycle that's stuck in `running`.
 *
 * Response:
 *   {
 *     scanned: number,
 *     flagged: Array<{ cycle_id, cycle_type, product_id, current_phase, minutes_idle }>
 *   }
 */
export async function POST(_request: NextRequest) {
  try {
    const report = await scanStalledCycles();
    return NextResponse.json(report);
  } catch (error) {
    console.error('[AutopilotScanStalls] failed:', error);
    return NextResponse.json(
      { error: `Autopilot cycle stall scan failed: ${(error as Error).message}` },
      { status: 500 }
    );
  }
}
