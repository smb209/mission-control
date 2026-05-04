import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getSuggestion,
  markAccepted,
  markDismissed,
  markRejected,
  type BriefSuggestionPayload,
  type TopicSuggestionPayload,
} from '@/lib/db/research-suggestions';
import { createTopic } from '@/lib/db/topics';
import { createBriefWithRun } from '@/lib/db/briefs';

export const dynamic = 'force-dynamic';

const ActionSchema = z.object({
  action: z.enum(['accept', 'reject', 'dismiss']),
});

/**
 * POST /api/research/suggestions/[id] { action: 'accept' | 'reject' | 'dismiss' }
 *
 * Accept: creates the real topic / brief from the suggestion's
 * payload, marks the suggestion accepted with `accepted_as_id`
 * pointing at the new row. Briefs land queued (no auto-dispatch).
 *
 * Reject: marks rejected (signal for the PM not to re-suggest).
 * Dismiss: marks dismissed (just noise; weaker signal).
 */
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const suggestion = getSuggestion(id);
  if (!suggestion) {
    return NextResponse.json({ error: 'Suggestion not found' }, { status: 404 });
  }
  if (suggestion.status !== 'pending') {
    return NextResponse.json(
      { error: `Suggestion is ${suggestion.status}, not pending` },
      { status: 409 },
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }
  const parsed = ActionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.issues },
      { status: 400 },
    );
  }

  if (parsed.data.action === 'reject') {
    return NextResponse.json(markRejected(id));
  }
  if (parsed.data.action === 'dismiss') {
    return NextResponse.json(markDismissed(id));
  }

  // Accept: materialize the suggestion into a real topic or brief.
  try {
    if (suggestion.kind === 'topic') {
      const p = suggestion.payload as TopicSuggestionPayload;
      const topic = createTopic({
        workspace_id: suggestion.workspace_id,
        name: p.name,
        description: p.description,
        tags: p.tags,
        default_brief_template: p.default_brief_template ?? null,
      });
      const updated = markAccepted(id, topic.id);
      return NextResponse.json({ suggestion: updated, created: { kind: 'topic', topic } }, { status: 201 });
    }

    if (suggestion.kind === 'brief') {
      const p = suggestion.payload as BriefSuggestionPayload;
      const created = createBriefWithRun({
        workspace_id: suggestion.workspace_id,
        template: p.template,
        title: p.title,
        prompt: p.prompt,
        topic_id: p.topic_id ?? null,
        requested_by: `suggestion:${suggestion.id}`,
      });
      const updated = markAccepted(id, created.brief.id);
      return NextResponse.json(
        { suggestion: updated, created: { kind: 'brief', brief: created.brief, agent_run: created.agent_run } },
        { status: 201 },
      );
    }

    // recurring_brief is reserved for phase-2 schedules.
    return NextResponse.json(
      { error: `Cannot accept suggestion of kind '${suggestion.kind}' yet` },
      { status: 501 },
    );
  } catch (error) {
    console.error('Failed to accept research suggestion:', error);
    const msg = error instanceof Error ? error.message : 'Failed to accept suggestion';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
