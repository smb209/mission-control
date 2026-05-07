/**
 * POST /api/jobs/:id/cancel
 *
 * Operator cancel for an in-flight agent_runs row, surfaced as the
 * Cancel button on /jobs live rows. Behavior:
 *   - 404 if the row doesn't exist.
 *   - 409 if the row is already terminal (complete/failed/cancelled).
 *   - 200 → flip the row to `cancelled` with `error_md='Cancelled by
 *     operator'` and cascade to any non-terminal direct children
 *     (parent_run_id = id) with `'Parent cancelled by operator'`.
 *
 * Gateway abort is fire-and-forget: if the row had an openclaw
 * session id we kick `sessions.abort` with a 2s timeout but don't
 * block the cancel response on its result. The DB write IS the
 * cancel; the gateway call is just a courtesy nudge so the underlying
 * agent shuts down sooner. See specs/jobs-in-progress.md PR 4.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  cancelAgentRun,
  AgentRunNotFoundError,
  AgentRunNotCancellableError,
} from '@/lib/db/agent-runs';
import { getOpenClawClient } from '@/lib/openclaw/client';

export const dynamic = 'force-dynamic';

const GATEWAY_ABORT_TIMEOUT_MS = 2000;

/** Best-effort gateway session abort. Never throws; never blocks > 2s. */
async function fireAndForgetAbort(sessionKey: string): Promise<void> {
  try {
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      console.warn(`[jobs.cancel] gateway not connected; skipping abort for ${sessionKey}`);
      return;
    }
    await Promise.race([
      client.abortSession(sessionKey),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('gateway abort timeout')), GATEWAY_ABORT_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    console.warn(
      `[jobs.cancel] gateway abort failed for ${sessionKey}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: 'job id required' }, { status: 400 });
  }

  try {
    const result = cancelAgentRun(id);
    if (result.openclaw_session_id) {
      // Fire-and-forget — don't await. Errors are swallowed inside.
      void fireAndForgetAbort(result.openclaw_session_id);
    }
    return NextResponse.json({
      id: result.id,
      status: result.status,
      children_cancelled: result.children_cancelled,
    });
  } catch (err) {
    if (err instanceof AgentRunNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof AgentRunNotCancellableError) {
      return NextResponse.json(
        { error: err.message, status: err.status },
        { status: 409 },
      );
    }
    console.error('Failed to cancel job:', err);
    return NextResponse.json({ error: 'Failed to cancel job' }, { status: 500 });
  }
}
