import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  listSuggestions,
  type SuggestionKind,
  type SuggestionStatus,
} from '@/lib/db/research-suggestions';
import { generateSuggestions } from '@/lib/research/suggest';

export const dynamic = 'force-dynamic';

const ALLOWED_KINDS: SuggestionKind[] = ['topic', 'brief', 'recurring_brief'];
const ALLOWED_STATUSES: SuggestionStatus[] = ['pending', 'accepted', 'rejected', 'dismissed'];

const PostSchema = z.object({
  workspace_id: z.string().min(1),
  kind: z.enum(['topic', 'brief']),
});

/**
 * GET /api/research/suggestions?workspace_id=...&kind=...&status=...
 * Lists suggestions in the workspace (default: status=pending).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const workspaceId = searchParams.get('workspace_id');
    if (!workspaceId) {
      return NextResponse.json({ error: 'workspace_id is required' }, { status: 400 });
    }
    const kindParam = searchParams.get('kind');
    const statusParam = searchParams.get('status') ?? 'pending';
    if (kindParam && !ALLOWED_KINDS.includes(kindParam as SuggestionKind)) {
      return NextResponse.json({ error: `kind must be one of: ${ALLOWED_KINDS.join(', ')}` }, { status: 400 });
    }
    if (statusParam && !ALLOWED_STATUSES.includes(statusParam as SuggestionStatus)) {
      return NextResponse.json({ error: `status must be one of: ${ALLOWED_STATUSES.join(', ')}` }, { status: 400 });
    }
    return NextResponse.json(listSuggestions(workspaceId, {
      kind: (kindParam as SuggestionKind | null) ?? undefined,
      status: statusParam as SuggestionStatus,
    }));
  } catch (error) {
    console.error('Failed to list research_suggestions:', error);
    return NextResponse.json({ error: 'Failed to list suggestions' }, { status: 500 });
  }
}

/**
 * POST /api/research/suggestions { workspace_id, kind }
 * Kicks the PM dispatch synchronously and returns the new pending
 * suggestions. Long-running (30–90s typical) — caller should show a
 * spinner. Prior pending suggestions of the same kind are dismissed.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = PostSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    const result = await generateSuggestions({
      workspace_id: parsed.data.workspace_id,
      kind: parsed.data.kind,
    });
    if (result.state === 'rejected') {
      return NextResponse.json(
        { error: result.reason, suggestions: [] },
        { status: 409 },
      );
    }
    if (result.state === 'failed') {
      return NextResponse.json(
        { error: result.reason, suggestions: [], raw: result.raw },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { state: 'ok', suggestions: result.suggestions },
      { status: 201 },
    );
  } catch (error) {
    console.error('Failed to generate research suggestions:', error);
    const msg = error instanceof Error ? error.message : 'Failed to generate suggestions';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
