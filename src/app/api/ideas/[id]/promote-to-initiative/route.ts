import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { promoteIdeaToInitiative } from '@/lib/db/promotion';

export const dynamic = 'force-dynamic';

const KindEnum = z.enum(['theme', 'milestone', 'epic', 'story']);

const Schema = z.object({
  kind: KindEnum.optional(),
  parent_initiative_id: z.string().nullish(),
  copy_description: z.boolean().optional(),
  created_by_agent_id: z.string().nullish(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const parsed = Schema.safeParse(body ?? {});
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    const result = promoteIdeaToInitiative(id, {
      kind: parsed.data.kind,
      parent_initiative_id: parsed.data.parent_initiative_id ?? null,
      copy_description: parsed.data.copy_description,
      created_by_agent_id: parsed.data.created_by_agent_id ?? null,
    });
    if (result.alreadyPromoted) {
      return NextResponse.json(
        { error: 'Idea already promoted', initiative: result.initiative },
        { status: 409 },
      );
    }
    return NextResponse.json(result.initiative, { status: 201 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to promote idea';
    if (msg.startsWith('Idea not found')) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    if (msg.startsWith('Parent initiative not found')) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    if (msg.includes('references missing initiative')) {
      return NextResponse.json({ error: msg }, { status: 409 });
    }
    console.error('Failed to promote idea to initiative:', error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
