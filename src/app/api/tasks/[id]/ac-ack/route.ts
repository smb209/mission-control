import { NextRequest, NextResponse } from 'next/server';
import {
  acknowledgeAc,
  getParentConvoyAcs,
  unacknowledgeAc,
} from '@/lib/db/task-ac-ack';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/tasks/[id]/ac-ack
 *
 * Returns the per-AC status for the task's done-state parent convoy.
 * Response body: `{ acceptance_criteria: AcStatus[] | null }`. A null value
 * means the task has no convoy with ACs — the AC gate is a no-op and the
 * caller can drive the existing review → done transition directly.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const acceptance_criteria = getParentConvoyAcs(id);
    return NextResponse.json({ acceptance_criteria });
  } catch (error) {
    console.error('[ac-ack:GET] failed:', error);
    return NextResponse.json({ error: 'Failed to load AC status' }, { status: 500 });
  }
}

/**
 * POST /api/tasks/[id]/ac-ack
 *
 * Body: `{ ac_index: number, rationale?: string }`.
 * Records (or replaces) an acknowledgement for a single AC. Returns the
 * updated AC projection so the modal can re-render without a round trip.
 *
 * Single-operator dev mode: `acknowledged_by` defaults to 'operator'.
 * Future auth layers can populate it from the session.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body.ac_index !== 'number') {
      return NextResponse.json(
        { error: 'ac_index (number) is required' },
        { status: 400 },
      );
    }
    const rationale = typeof body.rationale === 'string' ? body.rationale : undefined;
    try {
      acknowledgeAc(id, body.ac_index, { rationale, acknowledgedBy: 'operator' });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Failed to ack' },
        { status: 400 },
      );
    }
    return NextResponse.json({ acceptance_criteria: getParentConvoyAcs(id) });
  } catch (error) {
    console.error('[ac-ack:POST] failed:', error);
    return NextResponse.json({ error: 'Failed to record acknowledgement' }, { status: 500 });
  }
}

/**
 * DELETE /api/tasks/[id]/ac-ack
 *
 * Body: `{ ac_index: number }`. Removes a single ack row (operator changed
 * their mind). Idempotent — DELETE of a non-existent row succeeds.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body.ac_index !== 'number') {
      return NextResponse.json(
        { error: 'ac_index (number) is required' },
        { status: 400 },
      );
    }
    unacknowledgeAc(id, body.ac_index);
    return NextResponse.json({ acceptance_criteria: getParentConvoyAcs(id) });
  } catch (error) {
    console.error('[ac-ack:DELETE] failed:', error);
    return NextResponse.json({ error: 'Failed to remove acknowledgement' }, { status: 500 });
  }
}
