/**
 * GET /api/initiatives/:id/pm-chat
 *
 * Returns the most recent PM-chat messages whose provenance points at
 * this initiative — either via `metadata.target_initiative_id` directly
 * or via `metadata.source_note_ids` containing a note that belongs to
 * the initiative (the audit/notes-intake path).
 *
 * Drives the "Recent PM activity" rail on the initiative detail page.
 * See docs/proposals/pm-chat-context-strip.md.
 *
 * Query:
 *   limit?: 1..50 (default 10)
 *
 * Response:
 *   { messages: Array<{
 *       id, role, content, created_at, metadata,
 *       // Convenience-derived for the rail UI:
 *       trigger_kind?, proposal_id?, source_note_ids?, audit_run_group_id?
 *     }> }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getInitiative } from '@/lib/db/initiatives';
import { queryAll } from '@/lib/db';

export const dynamic = 'force-dynamic';

const Query = z.object({
  limit: z
    .preprocess(
      v => (typeof v === 'string' ? parseInt(v, 10) : v),
      z.number().int().min(1).max(50),
    )
    .optional()
    .default(10),
});

interface ChatRow {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  metadata: string | null;
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const init = getInitiative(id);
  if (!init) {
    return NextResponse.json({ error: 'initiative not found' }, { status: 404 });
  }

  const parsed = Query.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid query', issues: parsed.error.format() },
      { status: 400 },
    );
  }
  const limit = parsed.data.limit;

  // The PM agent is per-workspace (is_pm=1). Scope the chat query to it
  // so we don't accidentally pick up rows from a worker agent that
  // happens to share a metadata convention.
  const rows = queryAll<ChatRow>(
    `SELECT m.id, m.role, m.content, m.created_at, m.metadata
       FROM agent_chat_messages m
       JOIN agents a ON a.id = m.agent_id
      WHERE a.workspace_id = ?
        AND a.role = 'pm'
        AND m.metadata IS NOT NULL
        AND (
          -- Direct anchor: metadata.target_initiative_id == this id.
          json_extract(m.metadata, '$.target_initiative_id') = ?
          -- OR a source note that belongs to this initiative.
          OR EXISTS (
            SELECT 1 FROM json_each(json_extract(m.metadata, '$.source_note_ids'))
             WHERE json_each.value IN (
               SELECT id FROM agent_notes WHERE initiative_id = ?
             )
          )
        )
      ORDER BY m.created_at DESC
      LIMIT ?`,
    [init.workspace_id, id, id, limit],
  );

  const messages = rows.map(r => {
    let meta: Record<string, unknown> = {};
    if (r.metadata) {
      try {
        meta = JSON.parse(r.metadata);
      } catch {
        // leave empty
      }
    }
    return {
      id: r.id,
      role: r.role,
      content: r.content,
      created_at: r.created_at,
      metadata: meta,
      trigger_kind: meta.trigger_kind as string | undefined,
      proposal_id: meta.proposal_id as string | undefined,
      source_note_ids: meta.source_note_ids as string[] | undefined,
      audit_run_group_id: meta.audit_run_group_id as string | undefined,
    };
  });

  return NextResponse.json({ messages });
}
