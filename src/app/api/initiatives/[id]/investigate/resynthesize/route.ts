/**
 * POST /api/initiatives/:id/investigate/resynthesize
 *
 * Re-runs ONLY the L3 synthesizer against the existing audit_manifest +
 * the most recent audit_proposal notes per descendant. Spec
 * `specs/subtree-audit-proposals-spec.md` §6.1.
 *
 * Cheap; useful when L3 fails or the operator wants to re-roll the
 * cross-cutting reasoning without re-grepping the repo.
 *
 * Authorization: same as the parent investigate route (workspace
 * membership is implicit through the initiative lookup; the route
 * doesn't gate further today).
 *
 * Request body: empty / `{ guidance?: string }` (optional focus area).
 *
 * Response (200): { ok, synthesis_note_id, dispatch_outcome }.
 * Response (400): no audit_manifest exists for this initiative — the
 *   operator should run the full audit first.
 * Response (404): initiative not found.
 * Response (503): runner agent missing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getInitiative } from '@/lib/db/initiatives';
import { getRunnerAgent } from '@/lib/agents/runner';
import { listNotes } from '@/lib/db/agent-notes';
import { queryAll } from '@/lib/db';
import {
  validateAuditNoteBody,
  type AuditManifestBody,
} from '@/lib/agents/audit-proposals/schemas';
import {
  runSynthesizer,
  loadProposalsForSubtree,
  type SynthesizerResult,
} from '@/lib/agents/audit-synthesizer';

export const dynamic = 'force-dynamic';

const ResynthSchema = z.object({
  guidance: z.string().max(2000).nullish(),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Compute the next attempt number for the synthesis dispatch. */
function nextAuditAttempt(initiativeId: string): number {
  const rows = queryAll<{ n: number }>(
    `SELECT COUNT(*) as n
       FROM mc_sessions
      WHERE scope_type = 'initiative_audit'
        AND initiative_id = ?`,
    [initiativeId],
  );
  return (rows[0]?.n ?? 0) + 1;
}

/**
 * Test seam — set via `__setSynthesizerOverrideForTests` so unit tests
 * can stub the synthesizer dispatch without exercising the openclaw
 * gateway. Mirrors the override pattern in `subtree-audit.ts`.
 */
let _synthesizerOverride:
  | ((args: Parameters<typeof runSynthesizer>[0]) => Promise<SynthesizerResult>)
  | null = null;

export function __setSynthesizerOverrideForTests(
  override:
    | ((args: Parameters<typeof runSynthesizer>[0]) => Promise<SynthesizerResult>)
    | null,
): void {
  _synthesizerOverride = override;
}

export async function POST(
  request: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  try {
    const { id } = await params;
    const raw = await request.json().catch(() => ({}));
    const parsed = ResynthSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    const { guidance } = parsed.data;

    const initiative = getInitiative(id);
    if (!initiative) {
      return NextResponse.json(
        { error: 'Initiative not found' },
        { status: 404 },
      );
    }

    const runner = getRunnerAgent();
    if (!runner) {
      return NextResponse.json(
        {
          error:
            'Runner agent not registered (mc-runner-dev / mc-runner missing)',
        },
        { status: 503 },
      );
    }

    // Pull the most recent audit_manifest. Without it, the operator
    // hasn't run a full audit yet — punt with a clear message.
    const manifestRows = listNotes({
      initiative_id: id,
      kinds: ['audit_manifest'],
      limit: 1,
      order: 'desc',
    });
    const manifestRow = manifestRows[0];
    if (!manifestRow) {
      return NextResponse.json(
        {
          error:
            'no audit_manifest exists for this initiative; run a full audit first',
        },
        { status: 400 },
      );
    }
    const manifestParsed = validateAuditNoteBody('audit_manifest', manifestRow.body);
    const manifest: AuditManifestBody | null = manifestParsed.ok
      ? (manifestParsed.parsed as AuditManifestBody)
      : null;

    const proposalSummaries = loadProposalsForSubtree(id, initiative.workspace_id);

    const attempt = nextAuditAttempt(id);
    const synthFn = _synthesizerOverride ?? runSynthesizer;
    let result: SynthesizerResult;
    try {
      result = await synthFn({
        rootId: id,
        workspaceId: initiative.workspace_id,
        attempt,
        runner,
        parentRunId: null,
        manifest,
        proposalSummaries,
        guidance: guidance ?? null,
      });
    } catch (err) {
      result = {
        synthesis: null,
        synthesisNoteId: null,
        dispatchOutcome: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    return NextResponse.json({
      ok: result.dispatchOutcome === 'ok',
      dispatch_outcome: result.dispatchOutcome,
      synthesis_note_id: result.synthesisNoteId,
      error_message: result.errorMessage ?? null,
    });
  } catch (error) {
    console.error('[investigate/resynthesize] route error:', error);
    return NextResponse.json(
      { error: (error as Error).message ?? 'Internal server error' },
      { status: 500 },
    );
  }
}
