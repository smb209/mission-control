import { NextRequest, NextResponse } from 'next/server';
import { getConvoy, dispatchReadyConvoySubtasks } from '@/lib/convoy';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/tasks/[id]/convoy/dispatch — Dispatch all ready sub-tasks
export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const convoy = getConvoy(id);

    if (!convoy) {
      return NextResponse.json({ error: 'No convoy found for this task' }, { status: 404 });
    }

    if (convoy.status !== 'active') {
      return NextResponse.json({ error: `Convoy is ${convoy.status}, cannot dispatch` }, { status: 400 });
    }

    const result = await dispatchReadyConvoySubtasks(convoy.id);
    if (result.dispatched === 0 && result.skipped) {
      return NextResponse.json({ dispatched: 0, message: result.skipped });
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('[Convoy Dispatch] failed:', error);
    return NextResponse.json({ error: 'Failed to dispatch convoy' }, { status: 500 });
  }
}
