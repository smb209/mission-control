import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  addInitiativeDependency,
  getInitiative,
  getInitiativeDependencies,
} from '@/lib/db/initiatives';

export const dynamic = 'force-dynamic';

const AddDependencySchema = z.object({
  depends_on_initiative_id: z.string().min(1),
  kind: z.enum(['finish_to_start', 'start_to_start', 'blocking', 'informational']).optional(),
  note: z.string().max(2000).nullish(),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const initiative = getInitiative(id);
    if (!initiative) {
      return NextResponse.json({ error: 'Initiative not found' }, { status: 404 });
    }
    return NextResponse.json(getInitiativeDependencies(id));
  } catch (error) {
    console.error('Failed to fetch dependencies:', error);
    return NextResponse.json({ error: 'Failed to fetch dependencies' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const parsed = AddDependencySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    const dep = addInitiativeDependency({
      initiative_id: id,
      depends_on_initiative_id: parsed.data.depends_on_initiative_id,
      kind: parsed.data.kind,
      note: parsed.data.note ?? null,
    });
    return NextResponse.json(dep, { status: 201 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to add dependency';
    if (msg.includes('not found')) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    if (msg.includes('itself') || msg.includes('already exists')) {
      return NextResponse.json({ error: msg }, { status: 409 });
    }
    console.error('Failed to add dependency:', error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
