import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  createTopic,
  listTopics,
  TopicValidationError,
} from '@/lib/db/topics';

export const dynamic = 'force-dynamic';

const CreateTopicSchema = z.object({
  workspace_id: z.string().min(1),
  name: z.string().min(1).max(500),
  description: z.string().max(10000).optional(),
  tags: z.array(z.string().max(64)).max(64).optional(),
  default_brief_template: z.string().max(64).nullish(),
});

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get('workspace_id');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspace_id is required' }, { status: 400 });
    }
    const includeArchived = searchParams.get('include') === 'archived';
    return NextResponse.json(listTopics(workspaceId, { includeArchived }));
  } catch (error) {
    console.error('Failed to list topics:', error);
    return NextResponse.json({ error: 'Failed to list topics' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = CreateTopicSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    const topic = createTopic({
      ...parsed.data,
      default_brief_template: parsed.data.default_brief_template ?? null,
    });
    return NextResponse.json(topic, { status: 201 });
  } catch (error) {
    if (error instanceof TopicValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('Failed to create topic:', error);
    const msg = error instanceof Error ? error.message : 'Failed to create topic';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
