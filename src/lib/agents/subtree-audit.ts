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
  AUDIT_IDLE_TIMEOUT_MS,
  type SurveyorResult,
} from '@/lib/agents/audit-survey';
import {
  auditProposalBodySchema,
  type AuditManifestBody,
  type AuditManifestNode,
} from '@/lib/agents/audit-proposals/schemas';
import { summarizeProposalForBriefing } from './subtree-audit-summarize';
import {
  runSynthesizer,
  loadProposalsForSubtree,
  type SynthesizerResult,
} from '@/lib/agents/audit-synthesizer';

const TERMINAL_STATUSES = new Set(['done', 'cancelled']);

/**
 * Fraction of child node failures above which the synthetic parent
 * agent_runs row rolls up to `failed` instead of `complete`. Pure
 * display semantic — orchestration always finishes the layered fan-out.
 */
export const SUBTREE_FAILURE_THRESHOLD = 0.5;

/**
 * Re-export of `summarizeProposalForBriefing` — moved to
 * `subtree-audit-summarize.ts` in Phase 4 to break a cycle between
 * `audit-prompt.ts` (which now also renders proposal summaries in the
 * synthesizer briefing) and this file.
 */
export { summarizeProposalForBriefing };

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
   * - 'subtree-proposal' — the only supported subtree shape (Phase 4
   *   hard cutover). L1 surveyor + manifest-driven filter; L2 typed
   *   `audit_proposal` per node; L3 synthesizer emits `audit_synthesis`
   *   on the root.
   *
   * The legacy 'subtree' mode (free-form per-node `observation` notes)
   * was removed in Phase 4 — see specs/subtree-audit-proposals-spec.md
   * §6.3.
   */
  mode?: 'subtree-proposal';
  /**
   * Test seam — overrides the surveyor function so tests can stub
   * dispatch + manifest readback without exercising openclaw.
   */
  surveyorOverride?: (
    args: Parameters<typeof runSurveyor>[0],
  ) => Promise<SurveyorResult>;
  /**
   * Test seam — overrides the synthesizer function so tests can stub
   * dispatch + synthesis-note readback. Parallels `surveyorOverride`.
   */
  synthesizerOverride?: (
    args: Parameters<typeof runSynthesizer>[0],
  ) => Promise<SynthesizerResult>;
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
    mode = 'subtree-proposal',
    surveyorOverride,
    synthesizerOverride,
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

  // ─── L1 surveyor + manifest filter ────────────────────────────────
  // Skipped nodes (manifest.skip === true && confidence === 'high') are
  // not dispatched; instead we emit a synthetic `audit_proposal` note
  // and record an 'ok' outcome so the synthesized body flows up to
  // parent layers via the existing childFindings path.
  // (Phase 4: `mode` is always 'subtree-proposal' at this point.)
  let manifest: AuditManifestBody | null = null;
  let manifestNoteId: string | null = null;
  // Eagerly bind `mode` so callers reading deeper-down still see it.
  void mode;
  {
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

  /**
   * Emit a synthetic fallback `audit_proposal` (proposed_action: 'keep',
   * confidence: 'low') for an L2 node where the auditor returned but
   * didn't land a valid proposal. Spec §5.5.
   */
  const emitFallbackKeepProposal = (
    node: LiteInitiative,
  ): { noteId: string; body: string } | null => {
    const bodyObj = {
      version: 1 as const,
      node_initiative_id: node.id,
      current_mc_status: node.status,
      current_mc_target_end: node.target_end ?? null,
      proposed_action: 'keep' as const,
      proposed_changes: {},
      repo_evidence: [
        { kind: 'note' as const, ref: `audit-fallback:initiative-${node.id}` },
      ],
      rationale: '(audit failed: invalid proposal body after retries)',
      confidence: 'low' as const,
      would_confirm_by: 'Re-running the audit on this node specifically.',
      continuation_note_id: null,
    };
    const parsed = auditProposalBodySchema.safeParse(bodyObj);
    if (!parsed.success) {
      console.warn(
        `[subtree-audit] synthetic fallback proposal failed schema check for ${node.id}: ${parsed.error.message}`,
      );
      return null;
    }
    const body = JSON.stringify(parsed.data);
    try {
      const created = createNote({
        workspace_id: workspaceId,
        agent_id: null,
        initiative_id: node.id,
        scope_key: `initiative-${rootId}:audit-subtree:fallback-keep:${node.id}`,
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
        `[subtree-audit] createNote(fallback keep) failed for ${node.id}: ${(err as Error).message}`,
      );
      return null;
    }
  };

  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layer = layers[layerIdx];
    const isRootLayer = layerIdx === layers.length - 1;
    const tasks = layer.map((node) => async () => {
      const attempt = nextAuditAttempt(node.id);
      const sessionSuffix = `initiative-${node.id}:audit:${attempt}`;
      const scopeKey = (runner as { session_key_prefix?: string | null })
        .session_key_prefix
        ? `${(runner as { session_key_prefix?: string | null }).session_key_prefix}:${sessionSuffix}`
        : sessionSuffix;

      // Root deferred to L3 synthesizer. The L3 dispatch lands AFTER
      // the layer loop completes, and updates the root's outcome at
      // that point. For now, skip the L2 dispatch.
      if (isRootLayer && node.id === rootId) {
        return;
      }

      // Manifest-driven skip: don't dispatch — emit a synthetic keep
      // proposal and record the outcome so the parent layer's
      // childFindings includes a synthesized body.
      {
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
            let renderedBody =
              f?.body ?? '_(no finding recorded — child audit did not run)_';
            // In subtree-proposal mode, child findings are JSON
            // audit_proposal bodies — summarize them as prose for the
            // parent auditor.
            if (f?.body && !f.failed) {
              try {
                const parsed = auditProposalBodySchema.safeParse(JSON.parse(f.body));
                if (parsed.success) {
                  renderedBody = summarizeProposalForBriefing(parsed.data);
                }
              } catch {
                // Leave renderedBody as-is; the parent briefing will
                // still see the raw JSON or placeholder.
              }
            }
            childFindings.push({
              childId: candidate.id,
              childTitle: candidate.title,
              body: renderedBody,
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

      const manifestEntryForNode = manifestNodeFor(node.id);
      const triggerBody = buildAuditPrompt({
        initiative: node,
        tasks: tasksForNode,
        childInitiatives: childInitiativesForNode,
        guidance: guidance ?? null,
        priorFindings: [],
        childFindings,
        mode: 'subtree-proposal',
        proposalInput: {
          rootId,
          attempt,
          manifestNode: {
            hypothesis: manifestEntryForNode?.hypothesis ?? 'needs-deep-dive',
            confidence: manifestEntryForNode?.confidence ?? 'low',
            investigation_prompt:
              manifestEntryForNode?.investigation_prompt ??
              `Audit ${node.title} against repo + MC reality and emit a structured proposal.`,
            scoped_evidence_hints:
              manifestEntryForNode?.scoped_evidence_hints ?? [],
          },
        },
      });

      const dispatchRole = 'auditor' as const;

      try {
        await dispatchScope({
          workspace_id: workspaceId,
          role: dispatchRole,
          agent: runner,
          session_suffix: sessionSuffix,
          scope_type: 'initiative_audit',
          initiative_id: node.id,
          trigger_body: triggerBody,
          attempt_strategy: 'fresh',
          timeoutMs: perNodeTimeoutMs,
          idleTimeoutMs: AUDIT_IDLE_TIMEOUT_MS,
          idempotencyKey: `subtree-audit-${node.id}-${attempt}-${Date.now()}`,
          parent_run_id: parentRunId,
          source_kind: 'fanout',
          source_ref: rootId,
          label: `Audit: ${node.title}`,
        });

        // Look for the most recent audit_proposal note on this node.
        // The MCP take_note validator from Phase 1 has already
        // enforced schema validity at write time — if a row exists,
        // it parses cleanly.
        const propNotes = listNotes({
          initiative_id: node.id,
          kinds: ['audit_proposal'],
          limit: 1,
          order: 'desc',
        });
        const propBody = propNotes[0]?.body?.trim();
        if (propBody) {
          findingsByInitiative.set(node.id, { body: propBody, failed: false });
          perNodeOutcomes.push({
            initiativeId: node.id,
            layerIndex: layerIdx,
            scopeKey,
            status: 'ok',
            note: propBody,
          });
        } else {
          // No audit_proposal landed — emit synthetic fallback.
          const synth = emitFallbackKeepProposal(node);
          const fallbackBody =
            synth?.body ??
            `(audit failed: invalid proposal body after retries; synthetic fallback createNote also failed for ${node.id})`;
          findingsByInitiative.set(node.id, {
            body: fallbackBody,
            failed: true,
          });
          perNodeOutcomes.push({
            initiativeId: node.id,
            layerIndex: layerIdx,
            scopeKey,
            status: 'failed',
            error: 'no audit_proposal landed; synthetic fallback emitted',
          });
        }
        return;
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

  // ─── L3 synthesizer dispatch (root layer replacement) ─────────────
  // Pre-load every L2 audit_proposal across the descendant subtree —
  // synthetic-keep + synthetic-fallback rows are valid proposals and
  // MUST be included so the synthesizer sees full coverage.
  // The result is recorded as the root's per-node outcome. On failure
  // / no-synthesis we do NOT emit a synthetic fallback (spec §5.5);
  // the queue UI surfaces a "synthesis missing — re-run synth only"
  // affordance instead.
  {
    const synthAttempt = nextAuditAttempt(rootId);
    const proposalSummaries = loadProposalsForSubtree(rootId, workspaceId);
    const synthFn = synthesizerOverride ?? runSynthesizer;
    const rootScopeKey = (runner as { session_key_prefix?: string | null })
      .session_key_prefix
      ? `${(runner as { session_key_prefix?: string | null }).session_key_prefix}:initiative-${rootId}:audit-synthesis:${synthAttempt}`
      : `initiative-${rootId}:audit-synthesis:${synthAttempt}`;
    let synthResult: SynthesizerResult;
    try {
      synthResult = await synthFn({
        rootId,
        workspaceId,
        attempt: synthAttempt,
        runner,
        parentRunId,
        manifest,
        proposalSummaries,
        guidance: guidance ?? null,
        timeoutMs: perNodeTimeoutMs,
      });
    } catch (err) {
      synthResult = {
        synthesis: null,
        synthesisNoteId: null,
        dispatchOutcome: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
    const rootLayerIdx = Math.max(0, layers.length - 1);
    if (synthResult.dispatchOutcome === 'ok' && synthResult.synthesis) {
      perNodeOutcomes.push({
        initiativeId: rootId,
        layerIndex: rootLayerIdx,
        scopeKey: rootScopeKey,
        status: 'ok',
        note: synthResult.synthesis.completion_sentinel,
      });
    } else {
      perNodeOutcomes.push({
        initiativeId: rootId,
        layerIndex: rootLayerIdx,
        scopeKey: rootScopeKey,
        status: 'failed',
        error: `(synthesis ${synthResult.dispatchOutcome}: ${synthResult.errorMessage ?? 'no error message'})`,
      });
    }
    void manifestNoteId; // reference kept for traceability; not surfaced in outcome.
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
