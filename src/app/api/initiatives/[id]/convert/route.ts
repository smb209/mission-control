import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { convertInitiative } from '@/lib/db/initiatives';

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
    const updated = convertInitiative(
      id,
      parsed.data.new_kind,
      parsed.data.moved_by_agent_id ?? null,
      parsed.data.reason ?? null,
    );
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
