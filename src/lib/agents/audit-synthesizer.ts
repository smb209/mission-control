/**
 * L3 synthesizer for the structured-audit pipeline.
 *
 * Runs ONE auditor dispatch scoped to the root initiative; the auditor
 * emits a single `audit_synthesis` note carrying the cross-cutting
 * proposals (merge_stories / split_story / new_story) + epic-level
 * proposals (modify_epic_dates / modify_epic_scope) + the one-line
 * completion sentinel.
 *
 * Spec: specs/subtree-audit-proposals-spec.md §3.3, §4.4, §5.1.
 *
 * On failure / no-synthesis the orchestrator does NOT emit a synthetic
 * fallback (per spec §5.5). The L2 proposal queue still gives the
 * operator full coverage; the queue UI surfaces a "synthesis missing"
 * affordance.
 */

import { listInitiatives } from '@/lib/db/initiatives';
import { listNotes } from '@/lib/db/agent-notes';
import { dispatchScope } from '@/lib/agents/dispatch-scope';
import { AUDIT_IDLE_TIMEOUT_MS } from '@/lib/agents/audit-survey';
import { buildAuditPrompt } from '@/lib/agents/audit-prompt';
import {
  validateAuditNoteBody,
  auditProposalBodySchema,
  type AuditManifestBody,
  type AuditProposalBody,
  type AuditSynthesisBody,
} from '@/lib/agents/audit-proposals/schemas';
import type { Agent } from '@/lib/types';

export interface ProposalSummaryInput {
  /** Source `audit_proposal` note id — surfaced for traceability. */
  noteId: string;
  /** Owning initiative (descendant of root). */
  initiativeId: string;
  /** Pretty title of the node, for the briefing. */
  initiativeTitle: string;
  /** Parsed proposal body. */
  body: AuditProposalBody;
}

export interface RunSynthesizerInput {
  rootId: string;
  workspaceId: string;
  attempt: number;
  /** The runner / gateway agent to dispatch through. */
  runner: Agent;
  /** Forwarded to dispatchScope. */
  parentRunId: string | null;
  /** Manifest output from L1 — included verbatim in the briefing. */
  manifest: AuditManifestBody | null;
  /** Pre-loaded L2 proposals across the descendant subtree. */
  proposalSummaries: ReadonlyArray<ProposalSummaryInput>;
  /** Optional operator-supplied focus area; threaded into the briefing. */
  guidance?: string | null;
  /** Per-dispatch timeout (ms). */
  timeoutMs?: number;
}

export interface SynthesizerResult {
  synthesis: AuditSynthesisBody | null;
  synthesisNoteId: string | null;
  /**
   * 'ok' — auditor dispatched + valid synthesis landed.
   * 'no-synthesis' — dispatch succeeded but no audit_synthesis note appeared
   *   (or the body failed validation).
   * 'failed' — dispatch threw / errored.
   */
  dispatchOutcome: 'ok' | 'failed' | 'no-synthesis';
  /** Captured for diagnostics / tests. */
  errorMessage?: string;
}

/**
 * Read back the most recent `audit_synthesis` note on the root after
 * the synthesizer dispatch returns.
 */
function loadFreshSynthesisNote(rootId: string): {
  noteId: string;
  body: string;
} | null {
  const rows = listNotes({
    initiative_id: rootId,
    kinds: ['audit_synthesis'],
    limit: 1,
    order: 'desc',
  });
  const note = rows[0];
  if (!note) return null;
  return { noteId: note.id, body: note.body };
}

/**
 * Walk the workspace's initiatives to find every descendant of `rootId`
 * (excluding the root itself). Used by callers (the orchestrator + the
 * resynthesize endpoint) to pull `audit_proposal` notes for the
 * synthesizer's briefing.
 */
export function enumerateDescendantIds(
  rootId: string,
  workspaceId: string,
): string[] {
  const all = listInitiatives({ workspace_id: workspaceId });
  const byParent = new Map<string, typeof all>();
  for (const i of all) {
    if (!i.parent_initiative_id) continue;
    const list = byParent.get(i.parent_initiative_id) ?? [];
    list.push(i);
    byParent.set(i.parent_initiative_id, list);
  }
  const out: string[] = [];
  const stack: string[] = [rootId];
  while (stack.length) {
    const cur = stack.pop()!;
    const kids = byParent.get(cur) ?? [];
    for (const k of kids) {
      out.push(k.id);
      stack.push(k.id);
    }
  }
  return out;
}

/**
 * Pull the most-recent `audit_proposal` note for each descendant of
 * `rootId`. Synthetic-keep proposals (Phase 2) and synthetic-fallback
 * proposals (Phase 3) ARE included — they're valid `audit_proposal`
 * rows. Used by both the orchestrator (immediately after L2 settles)
 * and the resynthesize endpoint.
 */
export function loadProposalsForSubtree(
  rootId: string,
  workspaceId: string,
): ProposalSummaryInput[] {
  const all = listInitiatives({ workspace_id: workspaceId });
  const titlesById = new Map(all.map((i) => [i.id, i.title]));
  const descendantIds = enumerateDescendantIds(rootId, workspaceId);
  const out: ProposalSummaryInput[] = [];
  for (const id of descendantIds) {
    const rows = listNotes({
      initiative_id: id,
      kinds: ['audit_proposal'],
      limit: 1,
      order: 'desc',
    });
    const row = rows[0];
    if (!row) continue;
    let parsed: AuditProposalBody;
    try {
      const result = auditProposalBodySchema.safeParse(JSON.parse(row.body));
      if (!result.success) continue;
      parsed = result.data;
    } catch {
      continue;
    }
    out.push({
      noteId: row.id,
      initiativeId: id,
      initiativeTitle: titlesById.get(id) ?? `(initiative ${id})`,
      body: parsed,
    });
  }
  return out;
}

/**
 * Dispatch the L3 synthesizer. Returns the parsed synthesis + outcome
 * marker. The caller decides what to do with a non-'ok' outcome —
 * spec §5.5 says NO synthetic fallback at the orchestrator; the L2
 * proposal queue is the operator's safety net.
 */
export async function runSynthesizer(
  input: RunSynthesizerInput,
): Promise<SynthesizerResult> {
  const {
    rootId,
    workspaceId,
    attempt,
    runner,
    parentRunId,
    manifest,
    proposalSummaries,
    guidance,
    timeoutMs,
  } = input;

  const all = listInitiatives({ workspace_id: workspaceId });
  const root = all.find((i) => i.id === rootId);
  if (!root) {
    return {
      synthesis: null,
      synthesisNoteId: null,
      dispatchOutcome: 'failed',
      errorMessage: `synthesizer: root ${rootId} not found in workspace ${workspaceId}`,
    };
  }

  const triggerBody = buildAuditPrompt({
    initiative: root,
    tasks: [],
    childInitiatives: [],
    guidance: guidance ?? null,
    priorFindings: [],
    childFindings: [],
    mode: 'synthesis',
    synthesisInput: {
      rootId,
      attempt,
      manifest,
      proposalSummaries: proposalSummaries.map((p) => ({
        noteId: p.noteId,
        initiativeId: p.initiativeId,
        initiativeTitle: p.initiativeTitle,
        body: p.body,
      })),
    },
  });

  const sessionSuffix = `initiative-${rootId}:audit-synthesis:${attempt}`;

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
      idleTimeoutMs: AUDIT_IDLE_TIMEOUT_MS,
      idempotencyKey: `audit-synthesis-${rootId}-${attempt}-${Date.now()}`,
      parent_run_id: parentRunId,
      source_kind: 'fanout',
      source_ref: rootId,
      label: `Audit synthesis: ${root.title}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      synthesis: null,
      synthesisNoteId: null,
      dispatchOutcome: 'failed',
      errorMessage: message,
    };
  }

  const fresh = loadFreshSynthesisNote(rootId);
  if (!fresh) {
    return {
      synthesis: null,
      synthesisNoteId: null,
      dispatchOutcome: 'no-synthesis',
      errorMessage:
        'synthesizer dispatch returned but no audit_synthesis note appeared',
    };
  }
  const parsed = validateAuditNoteBody('audit_synthesis', fresh.body);
  if (!parsed.ok) {
    return {
      synthesis: null,
      synthesisNoteId: fresh.noteId,
      dispatchOutcome: 'no-synthesis',
      errorMessage: `synthesizer body did not validate: ${parsed.error}`,
    };
  }
  return {
    synthesis: parsed.parsed as AuditSynthesisBody,
    synthesisNoteId: fresh.noteId,
    dispatchOutcome: 'ok',
  };
}
