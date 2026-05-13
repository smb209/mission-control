import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  BriefValidationError,
  createBriefWithRun,
  listBriefs,
} from '@/lib/db/briefs';
import { logApiError } from '@/lib/debug-log';

export const dynamic = 'force-dynamic';

const CreateBriefSchema = z.object({
  workspace_id: z.string().min(1),
  template: z.literal('general_brief'),
  title: z.string().min(1).max(500),
  prompt: z.string().min(1).max(20000),
  topic_id: z.string().nullish(),
  initiative_id: z.string().nullish(),
  requested_by: z.string().max(128).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get('workspace_id');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspace_id is required' }, { status: 400 });
    }
    const topicId = searchParams.get('topic_id') || undefined;
    const initiativeId = searchParams.get('initiative_id') || undefined;
    const limitParam = searchParams.get('limit');
    const limit = limitParam ? Math.max(1, Math.min(500, parseInt(limitParam, 10))) : undefined;
    return NextResponse.json(listBriefs(workspaceId, {
      topic_id: topicId,
      initiative_id: initiativeId,
      limit,
    }));
  } catch (error) {
    logApiError({ route: '/api/briefs', method: 'GET', status: 500, error });
    return NextResponse.json({ error: 'Failed to list briefs' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = CreateBriefSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    const result = createBriefWithRun({
      ...parsed.data,
      topic_id: parsed.data.topic_id ?? null,
      initiative_id: parsed.data.initiative_id ?? null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof BriefValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logApiError({ route: '/api/briefs', method: 'POST', status: 500, error });
    const msg = error instanceof Error ? error.message : 'Failed to create brief';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
