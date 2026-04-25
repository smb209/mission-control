import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { moveInitiative } from '@/lib/db/initiatives';

export const dynamic = 'force-dynamic';

const MoveSchema = z.object({
  to_parent_id: z.string().nullable(),
  moved_by_agent_id: z.string().nullish(),
  reason: z.string().max(2000).nullish(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const parsed = MoveSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    const updated = moveInitiative(
      id,
      parsed.data.to_parent_id,
      parsed.data.moved_by_agent_id ?? null,
      parsed.data.reason ?? null,
    );
    return NextResponse.json(updated);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to move initiative';
    if (msg.startsWith('Initiative not found')) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    if (msg.startsWith('Target parent not found')) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    if (msg.includes('cycle') || msg.includes('under itself')) {
      return NextResponse.json({ error: msg }, { status: 409 });
    }
    console.error('Failed to move initiative:', error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
