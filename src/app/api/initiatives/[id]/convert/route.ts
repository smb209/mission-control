import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { convertInitiative, getInitiative } from '@/lib/db/initiatives';
import { emitConvertEvent } from '@/lib/db/promotion';

export const dynamic = 'force-dynamic';

const ConvertSchema = z.object({
  new_kind: z.enum(['theme', 'milestone', 'epic', 'story']),
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
    const parsed = ConvertSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    // Capture from_kind before mutation so the event records the actual
    // transition (spec §16 #5).
    const before = getInitiative(id);
    if (!before) {
      return NextResponse.json({ error: 'Initiative not found' }, { status: 404 });
    }
    const updated = convertInitiative(
      id,
      parsed.data.new_kind,
      parsed.data.moved_by_agent_id ?? null,
      parsed.data.reason ?? null,
    );
    emitConvertEvent({
      initiative_id: id,
      initiative_title: updated.title,
      from_kind: before.kind,
      to_kind: updated.kind,
      agent_id: parsed.data.moved_by_agent_id ?? null,
      reason: parsed.data.reason ?? null,
    });
    return NextResponse.json(updated);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to convert initiative';
    if (msg.startsWith('Initiative not found')) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    console.error('Failed to convert initiative:', error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
