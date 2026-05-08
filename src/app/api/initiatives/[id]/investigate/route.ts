/**
 * POST /api/initiatives/:id/investigate
 *
 * Dispatches a researcher to audit an initiative against reality.
 * See specs/initiative-investigate.md.
 *
 * PR 2: narrow mode (one researcher dispatch).
 * PR 4: subtree mode — MC-driven layered fan-out.
 *
 * Request body:
 *   {
 *     mode: 'narrow' | 'subtree',
 *     guidance?: string,                // optional operator focus area
 *     reaudit?: 'fresh' | 'build_on'    // narrow only; subtree always fresh
 *   }
 *
 * Response (200):
 *   For narrow: { ok, mode: 'narrow', scope_key, scope_keys, attempt, dispatched_at }
 *   For subtree: { ok, mode: 'subtree', root_scope_key, planned_layers,
 *                  planned_nodes, concurrency, per_node_timeout_ms,
 *                  dispatched_at }
 *
 * GET /api/initiatives/:id/investigate?dryrun=1&mode=subtree
 *   Returns the subtree plan ({ planned_layers, planned_nodes,
 *   concurrency, per_node_timeout_ms }) for the modal's ETA/banner.
 *   Cheap + side-effect-free.
 *
 * The dispatch runs **fire-and-forget**. The route returns as soon as
 * the briefing has been queued at the gateway (narrow) or the
 * orchestration promise has been kicked off (subtree); the per-node
 * take_note rows land asynchronously and are surfaced via SSE / the
 * initiative detail page.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getInitiative, listInitiatives } from '@/lib/db/initiatives';
import { listNotes } from '@/lib/db/agent-notes';
import { getRunnerAgent } from '@/lib/agents/runner';
import { dispatchScope } from '@/lib/agents/dispatch-scope';
import { buildAuditPrompt } from '@/lib/agents/audit-prompt';
import { queryAll } from '@/lib/db';
import { getAuditSettings } from '@/lib/db/workspaces';
import { planSubtreeAudit, runSubtreeAudit } from '@/lib/agents/subtree-audit';
import { cancelAgentRun, AgentRunNotCancellableError } from '@/lib/db/agent-runs';
import type { AgentRun } from '@/lib/db/agent-runs';

export const dynamic = 'force-dynamic';

const InvestigateSchema = z.object({
  mode: z.enum(['narrow', 'subtree']).default('narrow'),
  guidance: z.string().max(2000).nullish(),
  reaudit: z.enum(['fresh', 'build_on']).default('fresh'),
  /**
   * When `true`, cancel any in-flight `initiative_audit` runs on this
   * initiative before dispatching a fresh one. When `false` (default),
   * an in-flight audit causes the route to refuse with 409. See
   * specs/dedupe-investigations.md §2.
   */
  supersede: z.boolean().optional().default(false),
});

/**
 * Find queued/running `initiative_audit` runs already scoped to this
 * initiative. Used by the dispatch-time guard so a second click of
 * "Audit" on the same initiative doesn't silently spawn a duplicate.
 */
function findInFlightAudits(initiativeId: string): AgentRun[] {
  return queryAll<AgentRun>(
    `SELECT * FROM agent_runs
      WHERE initiative_id = ?
        AND kind = 'initiative_audit'
        AND status IN ('queued', 'running')
      ORDER BY created_at ASC`,
    [initiativeId],
  );
}

/**
 * Find the most recent successfully-completed `initiative_audit` for
 * this initiative. Surfaced via `?dryrun=1` so the modal can render a
 * soft "audited recently" cooldown hint. See
 * specs/dedupe-investigations.md §3.
 */
function lastCompleteAudit(initiativeId: string): { run_id: string; completed_at: string | null } | null {
  const rows = queryAll<{ id: string; completed_at: string | null }>(
    `SELECT id, completed_at FROM agent_runs
      WHERE initiative_id = ?
        AND kind = 'initiative_audit'
        AND status = 'complete'
      ORDER BY COALESCE(completed_at, created_at) DESC
      LIMIT 1`,
    [initiativeId],
  );
  if (rows.length === 0) return null;
  return { run_id: rows[0].id, completed_at: rows[0].completed_at };
}

interface RouteParams {
  params: Promise<{ id: string }>;
}

const TERMINAL_STATUSES = new Set(['done', 'cancelled']);

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

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const url = request.nextUrl;
  if (url.searchParams.get('dryrun') !== '1') {
    return NextResponse.json(
      { error: 'Use POST to dispatch; pass ?dryrun=1 for plan info.' },
      { status: 400 },
    );
  }
  const mode = url.searchParams.get('mode') ?? 'subtree';
  const initiative = getInitiative(id);
  if (!initiative) {
    return NextResponse.json({ error: 'Initiative not found' }, { status: 404 });
  }
  const settings = getAuditSettings(initiative.workspace_id);
  if (mode === 'narrow') {
    return NextResponse.json({
      ok: true,
      mode: 'narrow',
      planned_nodes: 1,
      planned_layers: 1,
      concurrency: 1,
      per_node_timeout_ms: settings.perNodeTimeoutMs,
      last_complete_audit: lastCompleteAudit(id),
    });
  }
  if (TERMINAL_STATUSES.has(initiative.status)) {
    return NextResponse.json(
      {
        error: `Cannot plan a subtree audit for an initiative in terminal status '${initiative.status}'.`,
      },
      { status: 400 },
    );
  }
  const plan = planSubtreeAudit(id, initiative.workspace_id);
  return NextResponse.json({
    ok: true,
    mode: 'subtree',
    planned_nodes: plan.plannedNodes,
    planned_layers: plan.plannedLayers,
    concurrency: settings.subtreeConcurrency,
    per_node_timeout_ms: settings.perNodeTimeoutMs,
    last_complete_audit: lastCompleteAudit(id),
  });
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
    const { mode, guidance, reaudit, supersede } = parsed.data;

    // Concurrent-audit guard (specs/dedupe-investigations.md §2). An
    // operator clicking "Audit" twice in a row used to silently spawn
    // duplicates; require an explicit `supersede` to cancel the
    // in-flight run, otherwise refuse with 409 + the live run's id so
    // the UI can surface it.
    const inFlight = findInFlightAudits(id);
    if (inFlight.length > 0) {
      if (!supersede) {
        return NextResponse.json(
          {
            error: 'audit_in_flight',
            message:
              `An initiative audit is already ${inFlight[0].status} for this initiative. ` +
              `Re-issue with { "supersede": true } to cancel and redispatch.`,
            in_flight: inFlight.map((r) => ({
              run_id: r.id,
              status: r.status,
              kind: r.kind,
              started_at: r.started_at,
              created_at: r.created_at,
            })),
          },
          { status: 409 },
        );
      }
      // supersede=true → cancel each. cancelAgentRun is idempotent on
      // already-terminal rows; a NotCancellable error means someone
      // raced us to the cancel path, which is fine.
      for (const r of inFlight) {
        try {
          cancelAgentRun(r.id);
        } catch (err) {
          if (!(err instanceof AgentRunNotCancellableError)) {
            console.warn(
              `[investigate] supersede: cancelAgentRun(${r.id}) failed:`,
              (err as Error).message,
            );
          }
        }
      }
    }

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
        {
          error:
            'Runner agent not registered (mc-runner-dev / mc-runner missing)',
        },
        { status: 503 },
      );
    }

    if (mode === 'subtree') {
      // Subtree mode: reject terminal-status roots — auditing a
      // done/cancelled initiative's whole subtree is meaningless.
      if (TERMINAL_STATUSES.has(initiative.status)) {
        return NextResponse.json(
          {
            error: `Subtree audit on a terminal-state initiative ('${initiative.status}') is meaningless — there are no non-terminal descendants to audit and the root itself is closed.`,
          },
          { status: 400 },
        );
      }

      const settings = getAuditSettings(initiative.workspace_id);
      const plan = planSubtreeAudit(id, initiative.workspace_id);
      const dispatchedAt = new Date().toISOString();
      const rootSessionSuffix = `initiative-${id}:audit:subtree`;
      const rootScopeKey = (runner as { session_key_prefix?: string | null })
        .session_key_prefix
        ? `${(runner as { session_key_prefix?: string | null }).session_key_prefix}:${rootSessionSuffix}`
        : rootSessionSuffix;

      // Fire-and-forget — the orchestration runs as a background
      // promise. Per-layer concurrency cap is enforced inside the
      // helper. Per-node failures are recorded as placeholders and
      // don't abort the rest of the run.
      void runSubtreeAudit({
        rootId: id,
        workspaceId: initiative.workspace_id,
        guidance: guidance ?? null,
        perNodeTimeoutMs: settings.perNodeTimeoutMs,
        subtreeConcurrency: settings.subtreeConcurrency,
        runner,
      }).catch((err) => {
        console.error(
          `[investigate] subtree run failed for initiative ${id}:`,
          (err as Error).message,
        );
      });

      return NextResponse.json({
        ok: true,
        mode: 'subtree',
        root_scope_key: rootScopeKey,
        planned_nodes: plan.plannedNodes,
        planned_layers: plan.plannedLayers,
        concurrency: settings.subtreeConcurrency,
        per_node_timeout_ms: settings.perNodeTimeoutMs,
        dispatched_at: dispatchedAt,
      });
    }

    // ----- narrow mode (unchanged from PR 2) ----------------------
    const attempt = reaudit === 'build_on' ? 1 : nextAuditAttempt(id);
    const sessionSuffix = `initiative-${id}:audit:${attempt}`;

    const priorFindings =
      reaudit === 'build_on'
        ? listNotes({
            initiative_id: id,
            audience: 'pm',
            min_importance: 2,
            limit: 5,
            order: 'desc',
          })
        : [];

    // Direct child initiatives — themes' epics, epics' stories, etc.
    // Without this, narrow audits on parent kinds saw "no child tasks"
    // and had to greenfield-discover the decomposition (see chat-mc-runner).
    const childInitiatives = listInitiatives({
      workspace_id: initiative.workspace_id,
      parent_id: id,
    }).map((c) => ({
      id: c.id,
      title: c.title,
      kind: c.kind,
      status: c.status,
    }));

    const triggerBody = buildAuditPrompt({
      initiative,
      tasks: initiative.tasks ?? [],
      childInitiatives,
      guidance: guidance ?? null,
      priorFindings,
      mode: 'narrow',
    });

    const dispatchedAt = new Date().toISOString();
    const scopeKey = (runner as { session_key_prefix?: string | null })
      .session_key_prefix
      ? `${(runner as { session_key_prefix?: string | null }).session_key_prefix}:${sessionSuffix}`
      : sessionSuffix;

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
      mode: 'narrow',
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
