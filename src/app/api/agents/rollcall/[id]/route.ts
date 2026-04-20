import { NextRequest, NextResponse } from 'next/server';
import { getRollCallStatus } from '@/lib/rollcall';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/agents/rollcall/[id]
 *
 * Return the current state of a roll-call — per-target delivery status,
 * whether each agent has replied, and the reply body if so. The UI polls
 * this (or subscribes to SSE `rollcall_entry_updated` events) to update
 * the live results panel.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const status = getRollCallStatus(id);
    if (!status) {
      return NextResponse.json({ error: 'Roll-call not found' }, { status: 404 });
    }

    const now = Date.now();
    const expiresMs = new Date(status.rollcall.expires_at).getTime();
    const expired = now > expiresMs;

    // Aggregate summary for quick glance.
    const summary = {
      total: status.entries.length,
      delivered: status.entries.filter(e => e.delivery_status === 'sent').length,
      delivery_failed: status.entries.filter(e => e.delivery_status === 'failed' || e.delivery_status === 'skipped').length,
      replied: status.entries.filter(e => e.replied_at).length,
      pending_reply: status.entries.filter(
        e => e.delivery_status === 'sent' && !e.replied_at
      ).length,
      expired,
      seconds_remaining: Math.max(0, Math.floor((expiresMs - now) / 1000)),
    };

    return NextResponse.json({
      rollcall: status.rollcall,
      entries: status.entries,
      summary,
    });
  } catch (error) {
    console.error('[GET /api/agents/rollcall/[id]] failed:', error);
    return NextResponse.json(
      { error: `Failed to fetch roll-call status: ${(error as Error).message}` },
      { status: 500 }
    );
  }
}
