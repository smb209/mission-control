/**
 * Subtree-audit orchestration for the initiative Investigate flow.
 *
 * MC-driven, bottom-up, layered fan-out. PR 4 of
 * specs/initiative-investigate.md.
 *
 * Public surface:
 *   - enumerateLayersBottomUp — pure helper that returns leaf-first
 *     layers of non-terminal descendants, with the root (when also
 *     non-terminal) as the final layer.
 *   - boundedAll — small concurrency-limited Promise.all variant. Kept
 *     local because the repo had no existing utility (< 30 lines per
 *     project guidance).
 *   - planSubtreeAudit — pure dryrun shape used by the API + UI to
 *     show planned_layers / planned_nodes / concurrency before
 *     committing.
 *   - runSubtreeAudit — the actual orchestrator. Fire-and-forget at
 *     the API boundary; per-node failures are recorded as placeholder
 *     findings and don't abort the run.
 *
 * Important behavioral choices (operator review surface):
 *   - Layer N waits for Layer N-1 to fully settle before dispatching.
 *   - Concurrency cap applies per-layer (the cap inside `boundedAll`).
 *   - On per-node timeout / dispatch error: we synthesize a placeholder
 *     "(audit failed)" finding and proceed. The next layer's roll-up
 *     researcher gets the placeholder verbatim and is instructed in the
 *     prompt to flag the gap.
 *   - Each node still mints its own attempt suffix off
 *     `initiative-${id}:audit:${N}` and its own scope_key. mc_sessions
 *     bookkeeping is identical to narrow mode.
 */

import { listInitiatives, type Initiative } from '@/lib/db/initiatives';
import { createNote, listNotes } from '@/lib/db/agent-notes';
import { dispatchScope } from '@/lib/agents/dispatch-scope';
import { buildAuditPrompt } from '@/lib/agents/audit-prompt';
import type { Agent } from '@/lib/types';
import { queryAll } from '@/lib/db';
import { markRunRollup, startAgentRun } from '@/lib/db/agent-runs';
import { v4 as uuidv4 } from 'uuid';
import {
  runSurveyor,
  buildFallbackManifest,
  type SurveyorResult,
} from '@/lib/agents/audit-survey';
import {
  auditProposalBodySchema,
  type AuditManifestBody,
  type AuditManifestNode,
} from '@/lib/agents/audit-proposals/schemas';

const TERMINAL_STATUSES = new Set(['done', 'cancelled']);

/**
 * Fraction of child node failures above which the synthetic parent
 * agent_runs row rolls up to `failed` instead of `complete`. Pure
 * display semantic — orchestration always finishes the layered fan-out.
 */
export const SUBTREE_FAILURE_THRESHOLD = 0.5;

/** Initiative shape we need internally — kept narrow on purpose. */
type LiteInitiative = Pick<
  Initiative,
  | 'id'
  | 'title'
  | 'kind'
  | 'status'
  | 'description'
  | 'status_check_md'
  | 'target_start'
  | 'target_end'
  | 'parent_initiative_id'
  | 'workspace_id'
>;

/**
 * Enumerate non-terminal descendants of `rootId`, returning bottom-up
 * layers (leaves first, root last).
 *
 * Rules:
 *   - Skip nodes whose status ∈ {done, cancelled}.
 *   - "Layer" is determined by the LONGEST path from a node to any
 *     non-terminal descendant. Leaves (no non-terminal children of
 *     their own) are layer 0; their parents layer 1; etc. This keeps
 *     the layer-N parent dispatch *after* every reachable child has
 *     finished, even when the tree is unbalanced.
 *   - The original root is always included if it is itself
 *     non-terminal. If the root is terminal, the helper throws — the
 *     caller should reject the request before calling.
 *   - If the root has zero non-terminal descendants, returns a single
 *     layer containing only the root.
 */
export function enumerateLayersBottomUp(
  rootId: string,
  workspaceInitiatives: ReadonlyArray<LiteInitiative>,
): LiteInitiative[][] {
  const byId = new Map<string, LiteInitiative>();
  const byParent = new Map<string, LiteInitiative[]>();
  for (const i of workspaceInitiatives) {
    byId.set(i.id, i);
    if (i.parent_initiative_id) {
      const list = byParent.get(i.parent_initiative_id) ?? [];
      list.push(i);
      byParent.set(i.parent_initiative_id, list);
    }
  }

  const root = byId.get(rootId);
  if (!root) throw new Error(`enumerateLayersBottomUp: root ${rootId} not found`);
  if (TERMINAL_STATUSES.has(root.status)) {
    throw new Error(
      `enumerateLayersBottomUp: root ${rootId} has terminal status '${root.status}'`,
    );
  }

  // Walk subtree, collect non-terminal descendants (incl. root).
  const included: LiteInitiative[] = [];
  const stack: LiteInitiative[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    if (TERMINAL_STATUSES.has(cur.status)) continue;
    included.push(cur);
    const kids = byParent.get(cur.id) ?? [];
    for (const k of kids) stack.push(k);
  }

  // Memoized depth: longest path from `id` down to any included leaf.
  const depthCache = new Map<string, number>();
  const includedSet = new Set(included.map((i) => i.id));
  const depth = (id: string): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    const kids = (byParent.get(id) ?? []).filter((k) => includedSet.has(k.id));
    if (kids.length === 0) {
      depthCache.set(id, 0);
      return 0;
    }
    const d = 1 + Math.max(...kids.map((k) => depth(k.id)));
    depthCache.set(id, d);
    return d;
  };

  const layers: LiteInitiative[][] = [];
  for (const i of included) {
    const d = depth(i.id);
    if (!layers[d]) layers[d] = [];
    layers[d].push(i);
  }
  // Drop any unexpected gaps (shouldn't happen — depth is contiguous
  // when computed from leaves up — but defensive).
  return layers.filter((l) => l && l.length > 0);
}

/**
 * Concurrency-bounded Promise.all over a heterogeneous task list. Each
 * task is a thunk so it isn't started until a slot is free.
 *
 * Resolves to the array of results in input order. If any task
 * rejects, the rejection is surfaced via a `{ ok: false, error }`
 * envelope rather than throwing — the orchestrator wants per-task
 * outcomes, not abort-on-first-failure.
 */
export async function boundedAll<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number,
): Promise<Array<{ ok: true; value: T } | { ok: false; error: Error }>> {
  const cap = Math.max(1, Math.floor(limit));
  const results: Array<{ ok: true; value: T } | { ok: false; error: Error }> =
    new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const idx = next++;
      if (idx >= tasks.length) return;
      try {
        results[idx] = { ok: true, value: await tasks[idx]() };
      } catch (e) {
        results[idx] = {
          ok: false,
          error: e instanceof Error ? e : new Error(String(e)),
        };
      }
    }
  };
  const workers = Array.from({ length: Math.min(cap, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export interface SubtreePlan {
  layers: LiteInitiative[][];
  plannedLayers: number;
  plannedNodes: number;
}

/**
 * Pure planning helper. Pulls the workspace's initiatives, enumerates
 * the layers, and returns counts. Used by the API to populate the
 * 202 response and (optionally) by a `?dryrun=1` GET for the modal.
 */
export function planSubtreeAudit(rootId: string, workspaceId: string): SubtreePlan {
  const all = listInitiatives({ workspace_id: workspaceId }) as LiteInitiative[];
  const layers = enumerateLayersBottomUp(rootId, all);
  const plannedNodes = layers.reduce((acc, l) => acc + l.length, 0);
  return { layers, plannedLayers: layers.length, plannedNodes };
}

export interface RunSubtreeAuditInput {
  rootId: string;
  workspaceId: string;
  guidance?: string | null;
  perNodeTimeoutMs: number;
  subtreeConcurrency: number;
  runner: Agent;
  /**
   * Output mode for the subtree audit.
   * - 'subtree' — today's free-form per-node `observation` notes (PR 4
   *   shape, default).
   * - 'subtree-proposal' — Phase 2 of the structured-proposals spec:
   *   adds an L1 surveyor + manifest-driven filter; L2 still emits
   *   free-form notes (Phase 3 will switch them to typed proposals).
   * Defaults to 'subtree' for back-compat with existing call sites.
   */
  mode?: 'subtree' | 'subtree-proposal';
  /**
   * Test seam — overrides the surveyor function so tests can stub
   * dispatch + manifest readback without exercising openclaw.
   */
  surveyorOverride?: (
    args: Parameters<typeof runSurveyor>[0],
  ) => Promise<SurveyorResult>;
}

export interface SubtreeAuditResult {
  rootId: string;
  /** ID of the synthetic root agent_runs row that owns this fan-out. */
  parentRunId: string | null;
  totalDispatched: number;
  failedCount: number;
  perNodeOutcomes: Array<{
    initiativeId: string;
    layerIndex: number;
    scopeKey: string;
    status: 'ok' | 'failed';
    note?: string;
    error?: string;
  }>;
}

/**
 * Compute the next `:audit:N` attempt suffix for a given initiative.
 * Mirrors the helper inlined in the route — duplicated here to avoid
 * a circular import via the route module.
 */
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
 * Orchestrate a subtree audit. Fire-and-forget at the API boundary —
 * the caller awaits the planning + first-layer kickoff and then lets
 * the rest of the run finish in the background.
 *
 * Returns when every layer has settled. Per-node results — including
 * the take_note body extracted from the agent_notes table — are
 * collected so callers / tests can assert layer-by-layer behavior.
 */
export async function runSubtreeAudit(
  input: RunSubtreeAuditInput,
): Promise<SubtreeAuditResult> {
  const {
    rootId,
    workspaceId,
    guidance,
    perNodeTimeoutMs,
    subtreeConcurrency,
    runner,
    mode = 'subtree',
    surveyorOverride,
  } = input;
  const { layers } = planSubtreeAudit(rootId, workspaceId);

  // Synthetic root agent_runs row — exists purely so the /jobs UI can
  // group per-node child dispatches under one parent. Uses the
  // representative scope/role/agent of a child for a clean join. Not
  // dispatched to openclaw.
  const rootInitiative = layers[layers.length - 1]?.[0];
  const rootScopeKey = (runner as { session_key_prefix?: string | null })
    .session_key_prefix
    ? `${(runner as { session_key_prefix?: string | null }).session_key_prefix}:initiative-${rootId}:audit-subtree`
    : `initiative-${rootId}:audit-subtree`;
  let parentRunId: string | null = null;
  try {
    parentRunId = startAgentRun({
      workspace_id: workspaceId,
      kind: 'initiative_audit',
      scope_key: rootScopeKey,
      scope_type: 'initiative_audit',
      role: 'researcher',
      agent_id: runner.id,
      initiative_id: rootId,
      parent_run_id: null,
      source_kind: 'fanout',
      source_ref: rootId,
      label: rootInitiative
        ? `Subtree audit: ${rootInitiative.title}`
        : `Subtree audit: ${rootId}`,
    });
  } catch (err) {
    // Don't let an agent_runs write failure block orchestration; the
    // /jobs UI will just show the children flat. Mirrors the
    // dispatchScope guard.
    console.warn(
      '[subtree-audit] failed to create synthetic parent agent_run:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // Map of initiative_id → most-recent finding body (or "(audit failed)" placeholder).
  const findingsByInitiative = new Map<string, { body: string; failed: boolean }>();
  const perNodeOutcomes: SubtreeAuditResult['perNodeOutcomes'] = [];

  // ─── L1 surveyor + manifest filter (mode: 'subtree-proposal') ──────
  // Skipped nodes (manifest.skip === true && confidence === 'high') are
  // not dispatched; instead we emit a synthetic `audit_proposal` note
  // and record an 'ok' outcome so the synthesized body flows up to
  // parent layers via the existing childFindings path.
  let manifest: AuditManifestBody | null = null;
  let manifestNoteId: string | null = null;
  if (mode === 'subtree-proposal') {
    const surveyAttempt = nextAuditAttempt(rootId);
    const surveyorFn = surveyorOverride ?? runSurveyor;
    let surveyResult: SurveyorResult;
    try {
      surveyResult = await surveyorFn({
        rootId,
        workspaceId,
        attempt: surveyAttempt,
        runner,
        parentRunId,
        guidance: guidance ?? null,
        timeoutMs: perNodeTimeoutMs,
        gitActivity: null,
      });
    } catch (err) {
      surveyResult = {
        manifest: null,
        surveyorNoteId: null,
        dispatchOutcome: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    if (surveyResult.dispatchOutcome === 'ok' && surveyResult.manifest) {
      manifest = surveyResult.manifest;
      manifestNoteId = surveyResult.surveyorNoteId;
    } else {
      console.warn(
        `[subtree-audit] surveyor outcome=${surveyResult.dispatchOutcome}; ` +
          `falling back to full-fanout manifest. error=${surveyResult.errorMessage ?? '(none)'}`,
      );
      manifest = buildFallbackManifest(rootId, layers, surveyAttempt);
      manifestNoteId = surveyResult.surveyorNoteId;
    }
  }

  /** Returns the manifest entry for a node, or null if not in manifest. */
  const manifestNodeFor = (id: string): AuditManifestNode | null => {
    if (!manifest) return null;
    return manifest.nodes.find((n) => n.initiative_id === id) ?? null;
  };

  /** Should the orchestrator skip dispatch for this node (manifest-driven)? */
  const isManifestSkip = (id: string): boolean => {
    const m = manifestNodeFor(id);
    return !!m && m.skip === true && m.confidence === 'high';
  };

  /**
   * Emit a synthetic `audit_proposal` note for a manifest-skipped node.
   * Direct DB write — bypasses the MCP take_note validator path because
   * this is server-side. We still validate the body against the Zod
   * schema as a sanity check.
   */
  const emitSyntheticKeepProposal = (
    node: LiteInitiative,
    manifestEntry: AuditManifestNode,
  ): { noteId: string; body: string } | null => {
    const bodyObj = {
      version: 1 as const,
      node_initiative_id: node.id,
      current_mc_status: node.status,
      current_mc_target_end: node.target_end ?? null,
      proposed_action: 'keep' as const,
      proposed_changes: {},
      repo_evidence: [
        {
          kind: 'note' as const,
          ref: manifestNoteId ?? `manifest:fallback:initiative-${rootId}`,
        },
      ],
      rationale: `Skipped by manifest hypothesis: ${manifestEntry.hypothesis} (high confidence). ${manifestEntry.investigation_prompt.slice(0, 240)}`,
      confidence: 'high' as const,
      would_confirm_by: null,
      continuation_note_id: null,
    };
    const parsed = auditProposalBodySchema.safeParse(bodyObj);
    if (!parsed.success) {
      console.warn(
        `[subtree-audit] synthetic keep proposal failed schema check for ${node.id}: ${parsed.error.message}`,
      );
      return null;
    }
    const body = JSON.stringify(parsed.data);
    try {
      const created = createNote({
        workspace_id: workspaceId,
        agent_id: null,
        initiative_id: node.id,
        scope_key: `initiative-${rootId}:audit-subtree:synthetic-keep:${node.id}`,
        role: 'orchestrator',
        run_group_id: uuidv4(),
        kind: 'audit_proposal',
        audience: 'pm',
        body,
        importance: 1,
      });
      return { noteId: created.id, body };
    } catch (err) {
      console.warn(
        `[subtree-audit] createNote(synthetic keep) failed for ${node.id}: ${(err as Error).message}`,
      );
      return null;
    }
  };

  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layer = layers[layerIdx];
    const tasks = layer.map((node) => async () => {
      const attempt = nextAuditAttempt(node.id);
      const sessionSuffix = `initiative-${node.id}:audit:${attempt}`;
      const scopeKey = (runner as { session_key_prefix?: string | null })
        .session_key_prefix
        ? `${(runner as { session_key_prefix?: string | null }).session_key_prefix}:${sessionSuffix}`
        : sessionSuffix;

      // Manifest-driven skip: don't dispatch — emit a synthetic keep
      // proposal and record the outcome so the parent layer's
      // childFindings includes a synthesized body.
      if (mode === 'subtree-proposal') {
        const m = manifestNodeFor(node.id);
        if (m && isManifestSkip(node.id)) {
          const synth = emitSyntheticKeepProposal(node, m);
          const body =
            synth?.body ??
            `(synthetic keep proposal for ${node.id} — manifest-skipped, but createNote failed)`;
          findingsByInitiative.set(node.id, { body, failed: false });
          perNodeOutcomes.push({
            initiativeId: node.id,
            layerIndex: layerIdx,
            scopeKey,
            status: 'ok',
            note: `manifest-skip: ${m.hypothesis} (${m.confidence})`,
          });
          return;
        }
      }

      // Pull the immediate children's findings (only those that are
      // in our included set — terminal children are skipped). We
      // re-enumerate from `layers` rather than re-walking the tree.
      const childFindings: Array<{
        childId: string;
        childTitle: string;
        body: string;
        failed?: boolean;
      }> = [];
      // Children-of-this-node within prior layers:
      for (let prior = 0; prior < layerIdx; prior++) {
        for (const candidate of layers[prior]) {
          if (candidate.parent_initiative_id === node.id) {
            const f = findingsByInitiative.get(candidate.id);
            childFindings.push({
              childId: candidate.id,
              childTitle: candidate.title,
              body: f?.body ?? '_(no finding recorded — child audit did not run)_',
              failed: f?.failed ?? true,
            });
          }
        }
      }

      // Tasks attached to this initiative (narrow already loads them
      // via getInitiative({ includeTasks: true }); we mirror that).
      const tasksForNode = queryAll<{ id: string; title: string; status: string }>(
        `SELECT id, title, status FROM tasks WHERE initiative_id = ?`,
        [node.id],
      );

      // Direct child initiatives of this node — the structural list,
      // separate from `childFindings` (which is the synthesized audit
      // body for already-completed children). Including both lets the
      // researcher cross-reference the structural set against the
      // finding set and notice a child whose audit failed silently.
      const childInitiativesForNode = queryAll<{
        id: string;
        title: string;
        kind: string;
        status: string;
      }>(
        `SELECT id, title, kind, status FROM initiatives
          WHERE parent_initiative_id = ?
          ORDER BY sort_order, created_at`,
        [node.id],
      );

      const triggerBody = buildAuditPrompt({
        initiative: node,
        tasks: tasksForNode,
        childInitiatives: childInitiativesForNode,
        guidance: guidance ?? null,
        priorFindings: [],
        childFindings,
        mode: 'subtree',
      });

      try {
        await dispatchScope({
          workspace_id: workspaceId,
          role: 'researcher',
          agent: runner,
          session_suffix: sessionSuffix,
          scope_type: 'initiative_audit',
          initiative_id: node.id,
          trigger_body: triggerBody,
          attempt_strategy: 'fresh',
          timeoutMs: perNodeTimeoutMs,
          idempotencyKey: `subtree-audit-${node.id}-${attempt}-${Date.now()}`,
          parent_run_id: parentRunId,
          source_kind: 'fanout',
          source_ref: rootId,
          label: `Audit: ${node.title}`,
        });

        // Pull the most recent observation/pm/importance=2 note for
        // this initiative — the researcher's report. listNotes orders
        // by created_at desc by default.
        const notes = listNotes({
          initiative_id: node.id,
          audience: 'pm',
          min_importance: 2,
          limit: 1,
          order: 'desc',
        });
        const body = notes[0]?.body?.trim();
        if (body) {
          findingsByInitiative.set(node.id, { body, failed: false });
          perNodeOutcomes.push({
            initiativeId: node.id,
            layerIndex: layerIdx,
            scopeKey,
            status: 'ok',
            note: body,
          });
        } else {
          // Researcher returned but didn't take_note — treat as failure.
          const placeholder = `(audit failed: researcher reply received but no take_note(initiative_id=${node.id}, audience='pm', importance=2) row landed)`;
          findingsByInitiative.set(node.id, { body: placeholder, failed: true });
          perNodeOutcomes.push({
            initiativeId: node.id,
            layerIndex: layerIdx,
            scopeKey,
            status: 'failed',
            error: 'no take_note row',
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const placeholder = `(audit failed: ${message})`;
        findingsByInitiative.set(node.id, { body: placeholder, failed: true });
        perNodeOutcomes.push({
          initiativeId: node.id,
          layerIndex: layerIdx,
          scopeKey,
          status: 'failed',
          error: message,
        });
        console.error(
          `[subtree-audit] node ${node.id} (layer ${layerIdx}) failed:`,
          message,
        );
      }
    });

    await boundedAll(tasks, subtreeConcurrency);
  }

  const failedCount = perNodeOutcomes.filter((o) => o.status === 'failed').length;

  // Roll up the synthetic parent based on child success ratio. Pure
  // display semantic — orchestration has already finished. Soft-fail:
  // if the parent insert earlier failed, skip the rollup.
  if (parentRunId) {
    try {
      markRunRollup(
        parentRunId,
        perNodeOutcomes.map((o) => ({ status: o.status, error: o.error })),
        SUBTREE_FAILURE_THRESHOLD,
      );
    } catch (err) {
      console.warn(
        '[subtree-audit] rollup of synthetic parent failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return {
    rootId,
    parentRunId,
    totalDispatched: perNodeOutcomes.length,
    failedCount,
    perNodeOutcomes,
  };
}
