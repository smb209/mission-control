import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getInitiative,
  updateInitiative,
  deleteInitiative,
} from '@/lib/db/initiatives';

export const dynamic = 'force-dynamic';

const StatusEnum = z.enum(['planned', 'in_progress', 'at_risk', 'blocked', 'done', 'cancelled']);
const ComplexityEnum = z.enum(['S', 'M', 'L', 'XL']);

const PatchInitiativeSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).nullish(),
  status: StatusEnum.optional(),
  owner_agent_id: z.string().nullish(),
  estimated_effort_hours: z.number().nullish(),
  complexity: ComplexityEnum.nullish(),
  target_start: z.string().nullish(),
  target_end: z.string().nullish(),
  committed_end: z.string().nullish(),
  status_check_md: z.string().nullish(),
  sort_order: z.number().int().optional(),
  product_id: z.string().nullish(),
  source_idea_id: z.string().nullish(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const include = (searchParams.get('include') || '').split(',').map(s => s.trim());
    const initiative = getInitiative(id, {
      includeChildren: include.includes('children'),
      includeTasks: include.includes('tasks'),
    });
    if (!initiative) {
      return NextResponse.json({ error: 'Initiative not found' }, { status: 404 });
    }
    return NextResponse.json(initiative);
  } catch (error) {
    console.error('Failed to fetch initiative:', error);
    return NextResponse.json({ error: 'Failed to fetch initiative' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const parsed = PatchInitiativeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    const updated = updateInitiative(id, parsed.data);
    return NextResponse.json(updated);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to update initiative';
    if (msg.startsWith('Initiative not found')) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    console.error('Failed to update initiative:', error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    deleteInitiative(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to delete initiative';
    if (msg.startsWith('Initiative not found')) {
      return NextResponse.json({ error: msg }, { status: 404 });
    }
    if (msg.startsWith('Cannot delete')) {
      return NextResponse.json({ error: msg }, { status: 409 });
    }
    console.error('Failed to delete initiative:', error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
