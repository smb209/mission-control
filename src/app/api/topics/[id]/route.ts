import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  archiveTopic,
  getTopic,
  TopicValidationError,
  unarchiveTopic,
  updateTopic,
} from '@/lib/db/topics';

export const dynamic = 'force-dynamic';

const PatchTopicSchema = z.object({
  name: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional(),
  tags: z.array(z.string().max(64)).max(64).optional(),
  default_brief_template: z.string().max(64).nullable().optional(),
  // Setting archived to false unarchives; true archives. Distinct
  // from PATCH on other fields so the soft-delete intent stays
  // explicit in the API surface.
  archived: z.boolean().optional(),
});

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const topic = getTopic(id);
  if (!topic) return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
  return NextResponse.json(topic);
}

export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  try {
    const body = await request.json();
    const parsed = PatchTopicSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    const { archived, ...fields } = parsed.data;

    const current = getTopic(id);
    if (!current) return NextResponse.json({ error: 'Topic not found' }, { status: 404 });

    let topic = current;
    if (Object.keys(fields).length > 0) {
      const updated = updateTopic(id, fields);
      if (!updated) return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
      topic = updated;
    }
    if (archived === true) {
      const archivedTopic = archiveTopic(id);
      if (archivedTopic) topic = archivedTopic;
    } else if (archived === false) {
      const unarchivedTopic = unarchiveTopic(id);
      if (unarchivedTopic) topic = unarchivedTopic;
    }
    return NextResponse.json(topic);
  } catch (error) {
    if (error instanceof TopicValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Failed to update topic:', error);
    const msg = error instanceof Error ? error.message : 'Failed to update topic';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const current = getTopic(id);
  if (!current) return NextResponse.json({ error: 'Topic not found' }, { status: 404 });
  // Soft-delete only — phase 1 has no hard-delete affordance because
  // briefs reference topic_id (FK SET NULL). If you really want the
  // row gone, do it from SQL.
  const archived = archiveTopic(id);
  return NextResponse.json(archived);
}
