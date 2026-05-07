/**
 * POST /api/workspaces/:id/refine-conventions
 *
 * Agent-driven refine: hand the workspace's current conventions text to
 * the runner agent in a fresh session, ask it to either propose a
 * replacement or ask clarifying questions, return the structured result
 * for the operator to review.
 *
 * Spec: specs/workspace-conventions-structured.md §6.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { queryOne } from '@/lib/db';
import {
  RefineDispatchError,
  refineConventions,
} from '@/lib/workspace-conventions/refine';

export const dynamic = 'force-dynamic';

const Body = z.object({
  current_conventions: z.string().max(20000),
  operator_note: z.string().max(2000).nullish(),
});

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;

  const ws = queryOne<{
    id: string;
    name: string;
    workspace_path: string | null;
    repo_url: string | null;
    default_base_branch: string | null;
  }>(
    `SELECT id, name, workspace_path, repo_url, default_base_branch
       FROM workspaces WHERE id = ?`,
    [id],
  );
  if (!ws) {
    return NextResponse.json({ error: 'workspace not found' }, { status: 404 });
  }

  let body: z.infer<typeof Body>;
  try {
    const raw = await request.json();
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  try {
    const proposal = await refineConventions({
      workspace: ws,
      current_conventions: body.current_conventions,
      operator_note: body.operator_note ?? null,
    });
    return NextResponse.json({ proposal });
  } catch (err) {
    if (err instanceof RefineDispatchError) {
      const status =
        err.reason === 'no_runner' || err.reason === 'no_session' ? 503
        : err.reason === 'timeout' ? 504
        : err.reason === 'parse_failed' ? 502
        : 500;
      return NextResponse.json(
        { error: err.message, reason: err.reason },
        { status },
      );
    }
    console.error('[refine-conventions] unexpected', err);
    return NextResponse.json(
      { error: (err as Error).message ?? 'unexpected error' },
      { status: 500 },
    );
  }
}
