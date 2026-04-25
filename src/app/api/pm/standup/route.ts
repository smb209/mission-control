/**
 * POST /api/pm/standup
 *
 *   body { workspace_id, force?: boolean }
 *
 * Manually triggers the proactive PM standup synthesizer (Phase 6).
 *
 * Behaviour mirrors the schedule path:
 *   - 200 with `{ proposal, used_synthesize_fallback: true }` when a new
 *     draft proposal was created.
 *   - 200 with `{ proposal: null, skipped: true, reason: 'no_drift' | 'already_today' }`
 *     when nothing was created.
 *
 * `force=true` bypasses the once-per-day idempotency check, which is the
 * "Run standup now" UI button's behaviour — the operator explicitly asked.
 *
 * Use cases:
 *   - Operator clicks "Run standup now" in /pm.
 *   - Demos / scripts that want the standup card on demand.
 *   - Recovery from a missed cron tick.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { generateStandup } from '@/lib/agents/pm-standup';
import { applyDerivation } from '@/lib/roadmap/apply-derivation';

export const dynamic = 'force-dynamic';

const Body = z.object({
  workspace_id: z.string().min(1),
  force: z.boolean().optional(),
  /**
   * When true, also run `applyDerivation` first so derived_* columns reflect
   * the latest velocity / availability data. Defaults to true — the manual
   * caller almost always wants the freshest possible read. Tests pass false
   * to skip the derivation pass.
   */
  derive_first: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    if (parsed.data.derive_first !== false) {
      try {
        applyDerivation(parsed.data.workspace_id);
      } catch (err) {
        // Don't fail the standup just because derivation hit a snag — the
        // standup synthesizer also recomputes a preview internally and
        // will degrade gracefully.
        console.warn(
          '[POST /api/pm/standup] applyDerivation failed (continuing):',
          (err as Error).message,
        );
      }
    }
    const result = generateStandup({
      workspace_id: parsed.data.workspace_id,
      force: parsed.data.force,
    });
    // generateStandup returns a proposal AND a non-null skipped_reason when
    // the lookup hits an existing draft (already_today). Treat that as
    // "skipped" from the route's perspective so the operator's UI can tell
    // the difference between "I just made you a card" vs "already done".
    if (result.proposal && result.skipped_reason == null) {
      return NextResponse.json(
        {
          proposal: result.proposal,
          used_synthesize_fallback: true,
          drift_count: result.drift_count,
        },
        { status: 201 },
      );
    }
    return NextResponse.json({
      proposal: result.proposal,
      skipped: true,
      reason: result.skipped_reason,
      drift_count: result.drift_count,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to generate standup';
    console.error('Failed to generate PM standup:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
