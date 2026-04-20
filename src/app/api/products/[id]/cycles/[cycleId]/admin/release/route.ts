import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { logDebugEvent } from '@/lib/debug-log';
import { emitAutopilotActivity } from '@/lib/autopilot/activity';
import { ReleaseCycleSchema } from '@/lib/validation';
import type { ResearchCycle, IdeationCycle } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * POST /api/products/[id]/cycles/[cycleId]/admin/release
 *
 * Admin escape hatch for autopilot cycles stuck in status='running'. Flips
 * the cycle to 'interrupted' (the shared vocabulary used by recovery.ts)
 * with a descriptive error_message and writes an autopilot activity row so
 * the operator sees the action in the Activity panel. Mirrors the shape of
 * /api/tasks/[id]/admin/release-stall.
 *
 * Auth: bearer-token check via middleware (same as other admin routes).
 *
 * Body:
 *   reason:       required, 1..500 chars
 *   released_by:  optional audit string
 *
 * Accepts either a research_cycle id or an ideation_cycle id — we look
 * both tables up by id and dispatch based on which one matches.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; cycleId: string }> }
) {
  const { id: productId, cycleId } = await params;

  try {
    const body = await request.json().catch(() => ({}));
    const validation = ReleaseCycleSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.issues },
        { status: 400 }
      );
    }

    const { reason, released_by } = validation.data;

    // Find the cycle in either table. Cycle IDs are UUIDs so collisions are
    // effectively zero; we still check both in case an operator passes the
    // wrong kind of id.
    const research = queryOne<ResearchCycle>(
      'SELECT * FROM research_cycles WHERE id = ? AND product_id = ?',
      [cycleId, productId]
    );
    const ideation = research
      ? null
      : queryOne<IdeationCycle>(
          'SELECT * FROM ideation_cycles WHERE id = ? AND product_id = ?',
          [cycleId, productId]
        );

    if (!research && !ideation) {
      return NextResponse.json({ error: 'Cycle not found for this product' }, { status: 404 });
    }

    const cycleType: 'research' | 'ideation' = research ? 'research' : 'ideation';
    const table = research ? 'research_cycles' : 'ideation_cycles';
    const priorStatus = (research || ideation)!.status;
    const currentPhase = (research || ideation)!.current_phase || 'init';

    if (priorStatus !== 'running') {
      return NextResponse.json(
        {
          error: `Cycle is not in a releasable state`,
          hint: `Status is '${priorStatus}'; release only flips running → interrupted.`,
        },
        { status: 409 }
      );
    }

    const now = new Date().toISOString();
    const errorMessage = `released_by_admin: ${reason}${released_by ? ` (by ${released_by})` : ''}`;

    // Guard the UPDATE on status='running' so a racing runner can't resurrect
    // the cycle after we release it.
    run(
      `UPDATE ${table}
         SET status = 'interrupted', error_message = ?, completed_at = ?
       WHERE id = ? AND status = 'running'`,
      [errorMessage, now, cycleId]
    );

    emitAutopilotActivity({
      productId,
      cycleId,
      cycleType,
      eventType: 'cycle_released',
      message: `${cycleType} cycle released by admin`,
      detail: `Phase was ${currentPhase}; reason: ${reason}`,
    });

    logDebugEvent({
      type: 'autopilot.cycle_aborted',
      direction: 'internal',
      metadata: {
        table,
        cycle_id: cycleId,
        cycle_type: cycleType,
        product_id: productId,
        current_phase: currentPhase,
        prior_status: priorStatus,
        reason,
        released_by: released_by || null,
        trigger: 'admin_release',
      },
    });

    broadcast({
      type: cycleType === 'research' ? 'research_phase' : 'ideation_phase',
      payload: {
        productId,
        cycleId,
        phase: 'interrupted',
        reason: errorMessage,
      },
    });

    return NextResponse.json({
      success: true,
      cycle_id: cycleId,
      cycle_type: cycleType,
      prior_status: priorStatus,
      prior_phase: currentPhase,
      new_status: 'interrupted',
    });
  } catch (error) {
    console.error('Failed to release autopilot cycle:', error);
    return NextResponse.json(
      { error: `Failed to release cycle: ${(error as Error).message}` },
      { status: 500 }
    );
  }
}
