/**
 * L1 surveyor for the structured-audit pipeline.
 *
 * Runs ONE auditor dispatch scoped to the root initiative; the auditor
 * emits an `audit_manifest` note that narrows the per-node fan-out for
 * the L2 layer. On failure / no-manifest the orchestrator falls back to
 * a full-fanout manifest derived synthetically from the planned layers.
 *
 * Spec: specs/subtree-audit-proposals-spec.md §3.1, §5.1, §5.5.
 */

import { listInitiatives } from '@/lib/db/initiatives';
import { listNotes } from '@/lib/db/agent-notes';
import { dispatchScope } from '@/lib/agents/dispatch-scope';
import { buildAuditPrompt } from '@/lib/agents/audit-prompt';
import {
  validateAuditNoteBody,
  type AuditManifestBody,
  type AuditManifestNode,
} from '@/lib/agents/audit-proposals/schemas';
import type { Agent } from '@/lib/types';

const TERMINAL_STATUSES = new Set(['done', 'cancelled']);

export interface RunSurveyorInput {
  rootId: string;
  workspaceId: string;
  attempt: number;
  /** The runner / gateway agent to dispatch through. */
  runner: Agent;
  /** Forwarded to dispatchScope. */
  parentRunId: string | null;
  /** Optional operator-supplied focus area; threaded into the briefing. */
  guidance?: string | null;
  /** Per-dispatch timeout (ms). */
  timeoutMs?: number;
  /** Optional pre-computed git-activity excerpt; surveyors don't shell out. */
  gitActivity?: string | null;
}

export interface SurveyorResult {
  manifest: AuditManifestBody | null;
  surveyorNoteId: string | null;
  /**
   * 'ok' — auditor dispatched + valid manifest landed.
   * 'no-manifest' — dispatch succeeded but no audit_manifest note appeared.
   * 'failed' — dispatch threw / errored.
   */
  dispatchOutcome: 'ok' | 'failed' | 'no-manifest';
  /** Captured for diagnostics / tests. */
  errorMessage?: string;
}

type LiteForFallback = {
  id: string;
  title: string;
  kind: string;
  status: string;
  parent_initiative_id: string | null;
};

/**
 * Build a synthetic full-fanout manifest used when the surveyor
 * dispatch fails or returns no manifest. Every non-terminal descendant
 * is marked `hypothesis: 'needs-deep-dive'`, `skip: false`, so the
 * orchestrator dispatches every node — same coverage as today's
 * mode: 'subtree' run.
 */
export function buildFallbackManifest(
  rootId: string,
  layers: ReadonlyArray<ReadonlyArray<LiteForFallback>>,
  attempt: number,
): AuditManifestBody {
  const nodes: AuditManifestNode[] = [];
  for (const layer of layers) {
    for (const n of layer) {
      // Skip the root itself — manifest covers descendants; the root
      // gets the existing per-node audit at the top layer regardless.
      if (n.id === rootId) continue;
      nodes.push({
        initiative_id: n.id,
        title: n.title,
        current_status: n.status,
        hypothesis: 'needs-deep-dive',
        confidence: 'low',
        investigation_prompt: `(fallback) Audit ${n.title} against repo + MC reality and emit a structured proposal.`,
        scoped_evidence_hints: [],
        skip: false,
      });
    }
  }
  return {
    version: 1,
    root_initiative_id: rootId,
    attempt,
    previous_synthesis_run_group_id: null,
    summary:
      'Synthetic fallback manifest — surveyor dispatch failed or returned no manifest. Full fan-out across non-terminal descendants.',
    nodes,
    cross_cutting_questions: [],
  };
}

/**
 * Look up the most recent prior `audit_synthesis` note on the root —
 * used for delta runs in Phase 5. Phase 2 doesn't change behavior on
 * this read, but threads it through so the briefing renders the prior
 * if/when one exists.
 */
function loadPriorSynthesis(rootId: string): string | null {
  const rows = listNotes({
    initiative_id: rootId,
    kinds: ['audit_synthesis'],
    limit: 1,
    order: 'desc',
  });
  return rows[0]?.body ?? null;
}

/**
 * Read back the most recent `audit_manifest` note on the root after
 * the surveyor dispatch returns.
 */
function loadFreshManifestNote(rootId: string): {
  noteId: string;
  body: string;
} | null {
  const rows = listNotes({
    initiative_id: rootId,
    kinds: ['audit_manifest'],
    limit: 1,
    order: 'desc',
  });
  const note = rows[0];
  if (!note) return null;
  return { noteId: note.id, body: note.body };
}

/**
 * Dispatch the L1 surveyor. Returns the parsed manifest + outcome
 * marker. The orchestrator decides what to do with a non-'ok' outcome
 * (typically: fall back to `buildFallbackManifest`).
 */
export async function runSurveyor(input: RunSurveyorInput): Promise<SurveyorResult> {
  const { rootId, workspaceId, attempt, runner, parentRunId, guidance, timeoutMs, gitActivity } =
    input;

  // Build the descendants list from workspace initiatives.
  const all = listInitiatives({ workspace_id: workspaceId });
  const root = all.find((i) => i.id === rootId);
  if (!root) {
    return {
      manifest: null,
      surveyorNoteId: null,
      dispatchOutcome: 'failed',
      errorMessage: `surveyor: root ${rootId} not found in workspace ${workspaceId}`,
    };
  }

  // Walk the subtree, collect non-terminal descendants (excluding root).
  const byParent = new Map<string, typeof all>();
  for (const i of all) {
    if (!i.parent_initiative_id) continue;
    const list = byParent.get(i.parent_initiative_id) ?? [];
    list.push(i);
    byParent.set(i.parent_initiative_id, list);
  }
  const descendants: LiteForFallback[] = [];
  const stack: string[] = [rootId];
  while (stack.length) {
    const cur = stack.pop()!;
    const kids = byParent.get(cur) ?? [];
    for (const k of kids) {
      if (TERMINAL_STATUSES.has(k.status)) continue;
      descendants.push({
        id: k.id,
        title: k.title,
        kind: k.kind,
        status: k.status,
        parent_initiative_id: k.parent_initiative_id ?? null,
      });
      stack.push(k.id);
    }
  }

  const priorSynthesisBody = loadPriorSynthesis(rootId);

  const triggerBody = buildAuditPrompt({
    initiative: root,
    tasks: [],
    childInitiatives: [],
    guidance: guidance ?? null,
    priorFindings: [],
    childFindings: [],
    mode: 'survey',
    surveyInput: {
      rootId,
      attempt,
      descendants,
      gitActivity: gitActivity ?? null,
      priorSynthesisBody,
    },
  });

  const sessionSuffix = `initiative-${rootId}:audit-survey:${attempt}`;

  try {
    await dispatchScope({
      workspace_id: workspaceId,
      role: 'auditor',
      agent: runner,
      session_suffix: sessionSuffix,
      scope_type: 'initiative_audit',
      initiative_id: rootId,
      trigger_body: triggerBody,
      attempt_strategy: 'fresh',
      timeoutMs: timeoutMs ?? 5 * 60_000,
      idempotencyKey: `audit-survey-${rootId}-${attempt}-${Date.now()}`,
      parent_run_id: parentRunId,
      source_kind: 'fanout',
      source_ref: rootId,
      label: `Audit survey: ${root.title}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      manifest: null,
      surveyorNoteId: null,
      dispatchOutcome: 'failed',
      errorMessage: message,
    };
  }

  const fresh = loadFreshManifestNote(rootId);
  if (!fresh) {
    return {
      manifest: null,
      surveyorNoteId: null,
      dispatchOutcome: 'no-manifest',
      errorMessage: 'surveyor dispatch returned but no audit_manifest note appeared',
    };
  }
  const parsed = validateAuditNoteBody('audit_manifest', fresh.body);
  if (!parsed.ok) {
    return {
      manifest: null,
      surveyorNoteId: fresh.noteId,
      dispatchOutcome: 'no-manifest',
      errorMessage: `surveyor manifest body did not validate: ${parsed.error}`,
    };
  }
  return {
    manifest: parsed.parsed as AuditManifestBody,
    surveyorNoteId: fresh.noteId,
    dispatchOutcome: 'ok',
  };
}
