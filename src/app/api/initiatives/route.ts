import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  createInitiative,
  listInitiatives,
  type InitiativeKind,
  type InitiativeStatus,
} from '@/lib/db/initiatives';

export const dynamic = 'force-dynamic';

const KindEnum = z.enum(['theme', 'milestone', 'epic', 'story']);
const StatusEnum = z.enum(['planned', 'in_progress', 'at_risk', 'blocked', 'done', 'cancelled']);
const ComplexityEnum = z.enum(['S', 'M', 'L', 'XL']);

const CreateInitiativeSchema = z.object({
  workspace_id: z.string().min(1),
  kind: KindEnum,
  title: z.string().min(1).max(500),
  product_id: z.string().nullish(),
  parent_initiative_id: z.string().nullish(),
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
  source_idea_id: z.string().nullish(),
});

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const parent = searchParams.get('parent_id');
    const filters = {
      workspace_id: searchParams.get('workspace_id') || undefined,
      product_id: searchParams.get('product_id') || undefined,
      // Special-case: "null" string means filter to roots; missing = no filter.
      parent_id: parent === null ? undefined : parent === 'null' ? null : parent,
      status: (searchParams.get('status') as InitiativeStatus) || undefined,
      kind: (searchParams.get('kind') as InitiativeKind) || undefined,
    };
    const rows = listInitiatives(filters);
    return NextResponse.json(rows);
  } catch (error) {
    console.error('Failed to list initiatives:', error);
    return NextResponse.json({ error: 'Failed to list initiatives' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = CreateInitiativeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    const initiative = createInitiative(parsed.data);
    return NextResponse.json(initiative, { status: 201 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to create initiative';
    if (msg.startsWith('Parent initiative not found')) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    console.error('Failed to create initiative:', error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
