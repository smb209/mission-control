/**
 * POST /api/initiatives/:id/investigate
 *
 * Dispatches a researcher to audit an initiative against reality.
 * See specs/initiative-investigate.md.
 *
 * PR 2 ships **narrow mode only** — one researcher dispatch per call.
 * Subtree mode lands with PR 4 (it'll add a child-findings synthesis
 * step before the parent-level dispatch).
 *
 * Request body:
 *   {
 *     mode: 'narrow',          // PR 4: 'subtree'
 *     guidance?: string,       // optional operator focus area
 *     reaudit?: 'fresh' | 'build_on'  // default 'fresh'
 *   }
 *
 * Response (200):
 *   {
 *     ok: true,
 *     scope_key: string,
 *     scope_keys: string[],     // single-element for narrow; subtree
 *                                // returns one per node (PR 4)
 *     attempt: number,
 *     dispatched_at: string,
 *   }
 *
 * The dispatch runs **fire-and-forget**. The route returns as soon as
 * the briefing has been queued at the gateway; the researcher's
 * take_note + final reply land asynchronously and are surfaced via
 * SSE / the initiative detail page.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getInitiative } from '@/lib/db/initiatives';
import { listNotes } from '@/lib/db/agent-notes';
import { getRunnerAgent } from '@/lib/agents/runner';
import { dispatchScope } from '@/lib/agents/dispatch-scope';
import { buildAuditPrompt } from '@/lib/agents/audit-prompt';
import { queryAll } from '@/lib/db';

export const dynamic = 'force-dynamic';

const InvestigateSchema = z.object({
  mode: z.enum(['narrow']).default('narrow'),
  guidance: z.string().max(2000).nullish(),
  reaudit: z.enum(['fresh', 'build_on']).default('fresh'),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Compute the next `:audit:N` attempt suffix for fresh-mode dispatch.
 * Counts all prior `initiative_audit` rows for this initiative across
 * any status; the next attempt is `count + 1`. Build-on mode reuses
 * `:audit:1` to inherit the prior trajectory.
 */
function nextAuditAttempt(initiativeId: string): number {
  const rows = queryAll<{ n: number }>(
    `SELECT COUNT(*) as n
       FROM mc_sessions
      WHERE scope_type = 'initiative_audit'
        AND initiative_id = ?`,
    [initiativeId],
  );
  const count = rows[0]?.n ?? 0;
  return count + 1;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    const raw = await request.json().catch(() => ({}));
    const parsed = InvestigateSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    const { mode, guidance, reaudit } = parsed.data;

    const initiative = getInitiative(id, { includeTasks: true });
    if (!initiative) {
      return NextResponse.json(
        { error: 'Initiative not found' },
        { status: 404 },
      );
    }

    const runner = getRunnerAgent();
    if (!runner) {
      return NextResponse.json(
        { error: 'Runner agent not registered (mc-runner-dev / mc-runner missing)' },
        { status: 503 },
      );
    }

    // Build-on mode: reuse `:audit:1` so the researcher resumes the
    // prior session AND inline the prior audit notes. Fresh mode: mint
    // a brand new attempt suffix and pass priorFindings: [].
    const attempt = reaudit === 'build_on' ? 1 : nextAuditAttempt(id);
    const sessionSuffix = `initiative-${id}:audit:${attempt}`;

    const priorFindings = reaudit === 'build_on'
      ? listNotes({
          initiative_id: id,
          audience: 'pm',
          min_importance: 2,
          limit: 5,
          order: 'desc',
        })
      : [];

    const triggerBody = buildAuditPrompt({
      initiative,
      tasks: initiative.tasks ?? [],
      guidance: guidance ?? null,
      priorFindings,
    });

    // Compute scope_key + a synthetic run_group_id up front so the
    // route can respond immediately. Audits run for up to 15 min; we
    // can't make the operator's HTTP request hang on that. The actual
    // dispatchScope call runs detached — its reply is consumed by
    // openclaw's session log and the take_note row that lands when the
    // researcher finishes. The `is_resume` bookkeeping inside
    // dispatchScope still happens via upsertSession on the same tick.
    const dispatchedAt = new Date().toISOString();
    const scopeKey = (runner as { session_key_prefix?: string | null })
      .session_key_prefix
      ? `${(runner as { session_key_prefix?: string | null }).session_key_prefix}:${sessionSuffix}`
      : sessionSuffix;

    // Kick off the dispatch but don't await it. Errors are logged so
    // operators see them in MC server logs; the route already
    // responded.
    void dispatchScope({
      workspace_id: initiative.workspace_id,
      role: 'researcher',
      agent: runner,
      session_suffix: sessionSuffix,
      scope_type: 'initiative_audit',
      initiative_id: id,
      trigger_body: triggerBody,
      attempt_strategy: reaudit === 'build_on' ? 'reuse' : 'fresh',
      timeoutMs: 15 * 60_000,
      idempotencyKey: `investigate-${id}-${attempt}-${Date.now()}`,
    }).catch((err) => {
      console.error(
        `[investigate] dispatch failed for initiative ${id} (attempt ${attempt}):`,
        (err as Error).message,
      );
    });

    return NextResponse.json({
      ok: true,
      mode,
      scope_key: scopeKey,
      scope_keys: [scopeKey],
      attempt,
      dispatched_at: dispatchedAt,
    });
  } catch (error) {
    console.error('[investigate] route error:', error);
    return NextResponse.json(
      { error: (error as Error).message ?? 'Internal server error' },
      { status: 500 },
    );
  }
}
