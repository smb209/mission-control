/**
 * PM dispatch path.
 *
 * The PM is now a NAMED openclaw agent at
 *   `~/.openclaw/workspaces/mc-project-manager/`
 * (full SOUL.md/IDENTITY.md/AGENTS.md/etc. — same layout as
 * mc-coordinator/mc-builder). Migration 049 + `ensurePmAgent` link the MC
 * `agents` row to that gateway agent via `gateway_agent_id` and
 * `session_key_prefix`.
 *
 * Routing (single seam — `dispatchPm` and the plan/decompose helpers):
 *
 *   1. Look up the PM agent for the workspace.
 *   2. If it has a `gateway_agent_id` AND the openclaw client is connected,
 *      send the trigger + snapshot context (with a correlation_id) to
 *      `agent:mc-project-manager:main` via `chat.send`. Wait for the agent
 *      to call `propose_changes` (its SOUL.md instructs it to). The
 *      proposal lands in `pm_proposals` via the MCP path; we look it up
 *      by recency and return it.
 *   3. On timeout / no gateway / send failure, fall back to
 *      `synthesizeImpactAnalysis` — the deterministic parser preserved
 *      from Phase 5 so MC stays useful with or without the gateway running.
 *
 * The synthesize fallback is intentionally kept forever: it's the
 * "operator hits enter, gets something useful instantly" floor and the
 * only path that works offline. Never delete it.
 *
 * Hallucinated ids are a bug — `createProposal` validates every diff
 * against the workspace snapshot, so even the gateway path can't slip
 * through bad references.
 */

import { getRoadmapSnapshot, type RoadmapSnapshot } from '@/lib/db/roadmap';
import { previewDerivation } from '@/lib/roadmap/apply-derivation';
import { queryAll, queryOne, run } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import {
  createProposal,
  listProposals,
  setDispatchState,
  supersedeWithAgentProposal,
  type PmDiff,
  type PmProposal,
  type PmProposalTriggerKind,
} from '@/lib/db/pm-proposals';
import { broadcast } from '@/lib/events';
import { getOpenClawClient } from '@/lib/openclaw/client';
import {
  sendChatAndAwaitReply,
  __setSendChatClientForTests,
  type SendChatClient,
} from '@/lib/openclaw/send-chat';
import { buildNotesIntakeMessage } from './pm-prompts/notes-intake';
import type { Agent } from '@/lib/types';

// ─── Public API ─────────────────────────────────────────────────────

export interface DispatchPmInput {
  workspace_id: string;
  trigger_text: string;
  trigger_kind?: PmProposalTriggerKind;
  parent_proposal_id?: string | null;
  /**
   * When `false`, skip the deterministic `synthesizeImpactAnalysis`
   * fallback and propagate the gateway error instead. The
   * `propose_from_notes` flow uses this — a regex parser on freeform
   * notes is worse than nothing; the queue handles offline cases.
   * Defaults to `true` for back-compat with the disruption path.
   */
  allowFallback?: boolean;
}

export interface DispatchPmResult {
  /** The synth placeholder row, returned immediately. When awaiting_agent
   *  is true, this row's content will be replaced by the agent's row via a
   *  `pm_proposal_replaced` SSE event when the named PM agent finishes. */
  proposal: PmProposal;
  awaiting_agent: boolean;
  /** Resolves when the dispatch lifecycle settles. Tests await this; HTTP
   *  callers usually just return `proposal` immediately and let SSE drive
   *  UI updates. Same shape as DispatchPmSynthesizedResult.completion. */
  completion: Promise<{
    final: PmProposal;
    used_named_agent: boolean;
    used_synthesize_fallback: boolean;
  }>;
  /** @deprecated Use `completion` to get the final state. Retained on the
   *  result for back-compat with callers that don't await the completion;
   *  reflects whether the synth placeholder was the only output at the
   *  moment dispatchPm returned. */
  used_synthesize_fallback: boolean;
  used_named_agent?: boolean;
}

export class PmDispatchGatewayUnavailableError extends Error {
  constructor(message = 'openclaw gateway unavailable') {
    super(message);
    this.name = 'PmDispatchGatewayUnavailableError';
  }
}

/**
 * Default time we wait for the named PM agent to respond (i.e. land a
 * row via `propose_changes`) before falling back to the synth path.
 */
const NAMED_AGENT_TIMEOUT_MS = 60_000;

/**
 * Dependency seam for tests. Routes BOTH the local connection probe
 * (`isConnected()`) and the underlying chat send through a shared mock,
 * so tests can simulate "agent finishes its turn → final frame arrives"
 * without needing the real openclaw client.
 *
 * Implementation note: the seam now sets the shared
 * `__setSendChatClientForTests` hook in `send-chat.ts` so the new
 * `sendChatAndAwaitReply` primitive uses the same mock. This replaces
 * PR #55's bespoke override which only intercepted `client.call()`.
 */
type GatewayClient = SendChatClient;
let openclawClientOverride: GatewayClient | null = null;
export function __setOpenClawClientForTests(c: GatewayClient | null): void {
  openclawClientOverride = c;
  __setSendChatClientForTests(c);
}
function gatewayClient(): GatewayClient {
  return openclawClientOverride ?? (getOpenClawClient() as unknown as GatewayClient);
}

/** Likewise — tests override the timeout to keep the suite fast. */
let namedAgentTimeoutOverride: number | null = null;
export function __setNamedAgentTimeoutForTests(ms: number | null): void {
  namedAgentTimeoutOverride = ms;
}
function namedAgentTimeoutMs(): number {
  return namedAgentTimeoutOverride ?? NAMED_AGENT_TIMEOUT_MS;
}

/**
 * Top-level disruption dispatch. Returns the synth placeholder row
 * synchronously so the API can respond fast; the named-agent dispatch
 * runs in the background and either supersedes the placeholder via SSE
 * (`pm_proposal_replaced`) when the agent's `propose_changes` lands, or
 * leaves the synth row as the operator's draft when no agent reply
 * arrives within the tail window.
 *
 * Mirror of `dispatchPmSynthesized` for the disruption code path. See
 * specs/pm-dispatch-async.md for the architectural rationale.
 *
 * `allowFallback: false` (used by `propose_from_notes`) keeps the strict
 * gateway-required behavior: if the gateway is down we throw
 * `PmDispatchGatewayUnavailableError` instead of persisting a synth row.
 */
export function dispatchPm(input: DispatchPmInput): DispatchPmResult {
  const snapshot = getRoadmapSnapshot({ workspace_id: input.workspace_id });
  const pm = lookupPmAgent(input.workspace_id);
  const allowFallback = input.allowFallback ?? true;
  const gw = gatewayClient();
  const gatewayUp = !!(pm && pm.gateway_agent_id && gw.isConnected());

  // Strict-gateway path (propose_from_notes / queue replay): no synth row,
  // no chat echo — surface the unavailability cleanly.
  if (!allowFallback && !gatewayUp) {
    throw new PmDispatchGatewayUnavailableError(
      pm && pm.gateway_agent_id
        ? 'openclaw gateway unavailable'
        : 'PM agent missing gateway_agent_id; cannot dispatch without fallback',
    );
  }

  // Echo the operator's trigger as a user message so the /pm chat
  // reflects the conversation faithfully.
  try {
    postPmChatMessage({
      workspace_id: input.workspace_id,
      content: input.trigger_text,
      role: 'user',
    });
  } catch (err) {
    console.warn('[pm-dispatch] user chat insert failed:', (err as Error).message);
  }

  // Always persist the synth placeholder first — operator gets *something*
  // to react to even if the gateway times out, and the row id is stable
  // so the /pm UI's chat card can subscribe to SSE updates from the
  // moment dispatchPm returns.
  const synth = synthesizeImpactAnalysis(snapshot, input.trigger_text);
  const placeholder = createProposal({
    workspace_id: input.workspace_id,
    trigger_text: input.trigger_text,
    trigger_kind: input.trigger_kind ?? 'manual',
    impact_md: synth.impact_md,
    proposed_changes: synth.changes,
    parent_proposal_id: input.parent_proposal_id ?? null,
    dispatch_state: gatewayUp ? 'pending_agent' : 'synth_only',
  });
  try {
    postPmChatMessage({
      workspace_id: input.workspace_id,
      content: synth.impact_md,
      proposal_id: placeholder.id,
      role: 'assistant',
    });
  } catch (err) {
    console.warn('[pm-dispatch] chat insert failed:', (err as Error).message);
  }

  if (!gatewayUp) {
    return {
      proposal: placeholder,
      awaiting_agent: false,
      completion: Promise.resolve({
        final: placeholder,
        used_named_agent: false,
        used_synthesize_fallback: true,
      }),
      used_synthesize_fallback: true,
      used_named_agent: false,
    };
  }

  // Fire the named-agent dispatch + late-arrival reconciler in the
  // background. Same architecture as dispatchPmSynthesized: when the
  // agent's `propose_changes` lands, supersede the placeholder, broadcast
  // `pm_proposal_replaced`, and re-echo the agent's impact_md into chat.
  const completion = runDisruptionDispatchInBackground({
    input,
    snapshot,
    pm: pm!,
    placeholder,
    allowFallback,
  });
  return {
    proposal: placeholder,
    awaiting_agent: true,
    completion,
    used_synthesize_fallback: true, // Placeholder is synth at the moment we return.
    used_named_agent: false,
  };
}

interface RunDisruptionDispatchInput {
  input: DispatchPmInput;
  snapshot: RoadmapSnapshot;
  pm: NonNullable<ReturnType<typeof lookupPmAgent>>;
  placeholder: PmProposal;
  allowFallback: boolean;
}

async function runDisruptionDispatchInBackground(
  params: RunDisruptionDispatchInput,
): Promise<{ final: PmProposal; used_named_agent: boolean; used_synthesize_fallback: boolean }> {
  const { input, snapshot, pm, placeholder } = params;
  // Re-mint the message + sinceIso so we can poll for the agent's row.
  const correlationId = uuidv4();
  const sinceIso = new Date().toISOString();
  const summary = buildSnapshotSummary(snapshot);
  const message =
    input.trigger_kind === 'notes_intake'
      ? buildNotesIntakeMessage({ correlationId, notes: input.trigger_text, summary })
      : `**PM dispatch (correlation_id: ${correlationId})**\n\n` +
        `Operator-reported event:\n> ${input.trigger_text}\n\n` +
        `Workspace snapshot summary (call \`get_roadmap_snapshot\` via MCP for full detail):\n\n` +
        `${summary}\n\n` +
        `Per your SOUL.md: analyse the disruption and call \`propose_changes\` ` +
        `with a structured PmDiff[] and impact_md. Reference only ids that ` +
        `appear in the snapshot. Output discipline: tool call FIRST, then a single-line ` +
        `\`Proposal {id}.\` reply — no freeform summary (it's discarded).`;
  const sessionSuffix = input.trigger_kind === 'notes_intake' ? `notes-${correlationId}` : 'dispatch-main';

  let result: Awaited<ReturnType<typeof sendChatAndAwaitReply>> | null = null;
  try {
    result = await sendChatAndAwaitReply({
      agent: pm,
      message,
      idempotencyKey: `pm-dispatch-${correlationId}`,
      timeoutMs: namedAgentTimeoutMs(),
      sessionSuffix,
    });
  } catch (err) {
    console.warn(
      '[pm-dispatch] disruption named-agent dispatch failed:',
      (err as Error).message,
    );
  }

  const tailMs = result?.sent ? RECONCILER_TAIL_MS : 0;
  const found = await pollForAgentProposal(input.workspace_id, sinceIso, placeholder.id, tailMs);

  if (found) {
    console.log(
      `[pm-dispatch] disruption reconciler matched agent row ${found.id} for placeholder ${placeholder.id} ` +
        `(workspace=${input.workspace_id})`,
    );
    try {
      supersedeWithAgentProposal(placeholder.id, found.id, {
        trigger_kind: input.trigger_kind ?? 'manual',
        target_initiative_id: null,
      });
      // Re-echo the agent's (richer) impact_md into chat — the placeholder
      // already posted the synth content, but the agent's reasoning is
      // what the operator actually wants to see.
      try {
        postPmChatMessage({
          workspace_id: input.workspace_id,
          content: found.impact_md,
          proposal_id: found.id,
          role: 'assistant',
        });
      } catch (err) {
        console.warn('[pm-dispatch] agent chat re-echo failed:', (err as Error).message);
      }
      broadcast({
        type: 'pm_proposal_replaced',
        payload: {
          workspace_id: input.workspace_id,
          old_id: placeholder.id,
          new_id: found.id,
          target_initiative_id: null,
          trigger_kind: input.trigger_kind ?? 'manual',
        },
      });
      return { final: found, used_named_agent: true, used_synthesize_fallback: false };
    } catch (err) {
      console.warn('[pm-dispatch] disruption supersede failed:', (err as Error).message);
    }
  }

  console.log(
    `[pm-dispatch] disruption reconciler timed out for placeholder ${placeholder.id} (workspace=${input.workspace_id}); marking synth_only`,
  );
  setDispatchState(placeholder.id, 'synth_only');
  broadcast({
    type: 'pm_proposal_dispatch_state_changed',
    payload: {
      workspace_id: input.workspace_id,
      proposal_id: placeholder.id,
      dispatch_state: 'synth_only',
    },
  });
  return {
    final: { ...placeholder, dispatch_state: 'synth_only' },
    used_named_agent: false,
    used_synthesize_fallback: true,
  };
}

// ─── Named-agent dispatch ───────────────────────────────────────────

/**
 * Build a compact roadmap snapshot summary so the PM agent doesn't have
 * to round-trip MCP for `get_roadmap_snapshot` on every dispatch. Only
 * fields the PM needs to reason about disruptions: ids, titles, owners,
 * status, target dates. Capped at 50 initiatives so the prompt stays
 * sane on busy workspaces.
 */
function buildSnapshotSummary(snapshot: RoadmapSnapshot): string {
  const lines: string[] = [`Workspace: ${snapshot.workspace_id}`];
  const initiatives = snapshot.initiatives.slice(0, 50);
  if (initiatives.length > 0) {
    lines.push('', 'Initiatives:');
    for (const i of initiatives) {
      lines.push(
        `- ${i.id} | ${i.kind} | "${i.title}" | status=${i.status}` +
          (i.target_end ? ` | target_end=${i.target_end}` : '') +
          (i.owner_agent_id ? ` | owner=${i.owner_agent_id}` : ''),
      );
    }
    if (snapshot.initiatives.length > 50) {
      lines.push(
        `(... ${snapshot.initiatives.length - 50} more not shown — call get_roadmap_snapshot via MCP for full list)`,
      );
    }
  }
  return lines.join('\n');
}

// ─── Helpers ────────────────────────────────────────────────────────

function lookupPmAgent(workspaceId: string): Agent | null {
  const row = queryOne<Agent>(
    `SELECT * FROM agents WHERE workspace_id = ? AND role = 'pm' LIMIT 1`,
    [workspaceId],
  );
  return row ?? null;
}

/**
 * Same routing as `dispatchPm` but for already-synthesized proposals
 * (plan-initiative + decompose-initiative paths). Tries the named PM
 * session first; falls back to persisting the caller's synth output
 * when the gateway is unreachable.
 *
 * The plan/decompose synthesizers produce ADVISORY proposals (no diffs
 * to apply for plan_initiative; pre-wired children for decompose), so
 * the round-trip semantics are slightly different than dispatchPm: we
 * still poll for any new draft proposal in the workspace, but on
 * timeout we persist the synthesized proposal we were given so the
 * operator always sees something. Returns whichever proposal landed
 * plus fallback flags.
 */
export interface DispatchSynthesizedInput {
  workspace_id: string;
  trigger_text: string;
  trigger_kind: PmProposalTriggerKind;
  /** Synth output ready to persist as a fallback. */
  synth: { impact_md: string; changes: PmDiff[]; plan_suggestions?: Record<string, unknown> | null };
  /** Free-text prompt sent to the named agent. */
  agent_prompt: string;
  parent_proposal_id?: string | null;
  /**
   * Set when the proposal is being generated FOR a real initiative
   * (e.g. the operator clicked Plan with PM on the detail page).
   * Persisted on the proposal row so the panel can resume the draft on
   * re-open instead of throwing away their refinements.
   */
  target_initiative_id?: string | null;
  /**
   * Gateway session suffix to use instead of the default ':main' session.
   * Pass 'plan-<uuid>' (minted by the caller) for plan_initiative and
   * decompose_initiative dispatches so each planning conversation starts
   * with a clean context. Pass the same key on subsequent refine calls so
   * multi-turn refinements share the session and the PM remembers prior
   * turns. When omitted, falls back to ':main'.
   */
  planSessionKey?: string | null;
  /**
   * Per-call override for the named-agent wait. Disruption + refine paths
   * are happy with the 60s default; plan_initiative and decompose_initiative
   * dispatches benefit from longer (~120s) because the PM agent has to
   * compose structured output from a sizable input. When omitted falls back
   * to `namedAgentTimeoutMs()`.
   */
  timeoutMs?: number;
}

export interface DispatchSynthesizedResult {
  /** The synth placeholder row, returned immediately so the API can respond
   *  without waiting for the named-agent round trip. */
  proposal: PmProposal;
  /** Whether a named-agent dispatch is in flight. When true, the panel
   *  should subscribe to `pm_proposal_replaced` SSE events; when the agent
   *  responds, the synth row will be superseded by the agent's row. */
  awaiting_agent: boolean;
  /** Promise that resolves when the dispatch lifecycle is complete: either
   *  the agent's `propose_changes` lands and supersedes the synth row, or
   *  the tail window elapses and the synth row is marked `synth_only`.
   *  Tests await this to assert the post-state; callers that don't care can
   *  ignore it. */
  completion: Promise<{
    final: PmProposal;
    used_named_agent: boolean;
    used_synthesize_fallback: boolean;
  }>;
}

/** Tail window the reconciler keeps watching for an agent proposal AFTER the
 *  configured timeout elapses, in case the agent is just slow. The current
 *  60s + 60s tail covers all observed cold-session round trips (~70s). */
const RECONCILER_TAIL_MS = 60_000;
/** Polling interval inside the tail window — cheap because most of the time
 *  no rows match. */
const RECONCILER_POLL_MS = 2_000;

/**
 * Persist a synth-derived placeholder row immediately, then dispatch the
 * named PM agent in the background. Returns the placeholder + a completion
 * promise so callers can either:
 *
 *   - Return the placeholder right away (Tier 3, the common API path) and
 *     let SSE notify the UI when the agent's proposal supersedes it; OR
 *   - `await result.completion` to block until the lifecycle settles
 *     (tests, code paths that need the final state synchronously).
 *
 * If the gateway is unreachable, the placeholder is returned with
 * `awaiting_agent: false` and `dispatch_state: 'synth_only'`.
 */
export function dispatchPmSynthesized(
  input: DispatchSynthesizedInput,
): DispatchSynthesizedResult {
  const pm = lookupPmAgent(input.workspace_id);
  const gw = gatewayClient();
  const gatewayUp = !!(pm && pm.gateway_agent_id && gw.isConnected());

  // 1. Always persist the synth row first — the operator gets *something*
  //    even if the agent never replies, and the row id is stable so the UI
  //    can subscribe to it from the moment the API returns.
  const placeholder = createProposal({
    workspace_id: input.workspace_id,
    trigger_text: input.trigger_text,
    trigger_kind: input.trigger_kind,
    impact_md: input.synth.impact_md,
    proposed_changes: input.synth.changes,
    plan_suggestions: input.synth.plan_suggestions ?? null,
    parent_proposal_id: input.parent_proposal_id ?? null,
    target_initiative_id: input.target_initiative_id ?? null,
    dispatch_state: gatewayUp ? 'pending_agent' : 'synth_only',
  });

  if (!gatewayUp) {
    return {
      proposal: placeholder,
      awaiting_agent: false,
      completion: Promise.resolve({
        final: placeholder,
        used_named_agent: false,
        used_synthesize_fallback: true,
      }),
    };
  }

  // 2. Kick off the named-agent dispatch + late-arrival reconciler as a
  //    fire-and-forget background promise. The placeholder is returned
  //    immediately so the API can respond without waiting.
  const completion = runNamedAgentDispatchInBackground(input, pm!, placeholder);
  return { proposal: placeholder, awaiting_agent: true, completion };
}

async function runNamedAgentDispatchInBackground(
  input: DispatchSynthesizedInput,
  pm: NonNullable<ReturnType<typeof lookupPmAgent>>,
  placeholder: PmProposal,
): Promise<{ final: PmProposal; used_named_agent: boolean; used_synthesize_fallback: boolean }> {
  const correlationId = uuidv4();
  const sinceIso = new Date().toISOString();
  const sessionSuffix = input.planSessionKey ?? 'main';
  const timeoutMs = input.timeoutMs ?? namedAgentTimeoutMs();

  let result: Awaited<ReturnType<typeof sendChatAndAwaitReply>> | null = null;
  try {
    result = await sendChatAndAwaitReply({
      agent: pm,
      message:
        `**PM ${input.trigger_kind} (correlation_id: ${correlationId})**\n\n` +
        input.agent_prompt,
      idempotencyKey: `pm-${input.trigger_kind}-${correlationId}`,
      timeoutMs,
      sessionSuffix,
    });
  } catch (err) {
    console.warn(
      '[pm-dispatch] synthesized named-agent dispatch failed:',
      (err as Error).message,
    );
  }

  // 3. Keep watching for an agent-produced row up to RECONCILER_TAIL_MS
  //    past the original timeout. Cold sessions can land their
  //    `propose_changes` after the primary timeout; without this tail
  //    window those proposals are orphaned (the §2.3 regression that
  //    motivated this whole refactor).
  //
  //    When send succeeded → the agent is still likely composing, so we
  //    keep the full tail window. When send failed outright (no session,
  //    network error, throw) → there's no agent to wait for, so a single
  //    immediate check is enough.
  const tailMs = result?.sent ? RECONCILER_TAIL_MS : 0;
  const found = await pollForAgentProposal(
    input.workspace_id,
    sinceIso,
    placeholder.id,
    tailMs,
  );

  if (found) {
    console.log(
      `[pm-dispatch] reconciler matched agent row ${found.id} for placeholder ${placeholder.id} ` +
        `(workspace=${input.workspace_id}, trigger_kind=${input.trigger_kind})`,
    );
    try {
      supersedeWithAgentProposal(placeholder.id, found.id, {
        trigger_kind: input.trigger_kind,
        target_initiative_id: input.target_initiative_id ?? null,
      });
      // plan_initiative-specific backfill: if the agent omitted dates in
      // its plan_suggestions, fill from the synth's (always populated)
      // target window so the operator's Apply form has dates to apply.
      // Observed in the wild: the agent sometimes returns
      // `target_start: null, target_end: null` and the operator gets a
      // suggestion card with empty date fields.
      if (input.trigger_kind === 'plan_initiative') {
        try {
          const agentSuggestions = (found.plan_suggestions ?? null) as
            | { target_start?: string | null; target_end?: string | null }
            | null;
          const synthSuggestions = (input.synth.plan_suggestions ?? null) as
            | { target_start?: string | null; target_end?: string | null }
            | null;
          if (agentSuggestions && synthSuggestions) {
            const merged = { ...agentSuggestions };
            let dirty = false;
            if (!merged.target_start && synthSuggestions.target_start) {
              merged.target_start = synthSuggestions.target_start;
              dirty = true;
            }
            if (!merged.target_end && synthSuggestions.target_end) {
              merged.target_end = synthSuggestions.target_end;
              dirty = true;
            }
            if (dirty) {
              run(
                `UPDATE pm_proposals SET plan_suggestions = ? WHERE id = ?`,
                [JSON.stringify(merged), found.id],
              );
              console.log(
                `[pm-dispatch] backfilled plan_suggestions dates from synth for agent row ${found.id}`,
              );
            }
          }
        } catch (err) {
          console.warn('[pm-dispatch] plan_suggestions backfill failed:', (err as Error).message);
        }
      }
      const refreshed = listProposals({ workspace_id: input.workspace_id, limit: 1, since: sinceIso }).find(p => p.id === found.id) ?? found;
      broadcast({
        type: 'pm_proposal_replaced',
        payload: {
          workspace_id: input.workspace_id,
          old_id: placeholder.id,
          new_id: found.id,
          target_initiative_id: input.target_initiative_id ?? null,
          trigger_kind: input.trigger_kind,
        },
      });
      return { final: refreshed, used_named_agent: true, used_synthesize_fallback: false };
    } catch (err) {
      console.warn('[pm-dispatch] supersede failed:', (err as Error).message);
    }
  }

  // 4. No agent row arrived. Mark the placeholder as the operator's final
  //    draft so the UI can stop showing the "PM agent is working" indicator
  //    and re-enable Accept.
  console.log(
    `[pm-dispatch] reconciler timed out waiting for agent reply on placeholder ${placeholder.id} ` +
      `(workspace=${input.workspace_id}, trigger_kind=${input.trigger_kind}); marking synth_only`,
  );
  setDispatchState(placeholder.id, 'synth_only');
  broadcast({
    type: 'pm_proposal_dispatch_state_changed',
    payload: {
      workspace_id: input.workspace_id,
      proposal_id: placeholder.id,
      dispatch_state: 'synth_only',
    },
  });
  return {
    final: { ...placeholder, dispatch_state: 'synth_only' },
    used_named_agent: false,
    used_synthesize_fallback: true,
  };
}

/**
 * Poll `pm_proposals` for a draft created by the named PM agent during this
 * dispatch's window. The agent's `propose_changes` call lands as a fresh
 * row; we identify it by "newest draft created since `sinceIso` whose id is
 * NOT the placeholder we just wrote".
 *
 * `extraWaitMs` is the additional tail window beyond the original timeout —
 * 0 to bail right after the configured timeout, RECONCILER_TAIL_MS for the
 * full late-arrival catch.
 */
async function pollForAgentProposal(
  workspaceId: string,
  sinceIso: string,
  placeholderId: string,
  extraWaitMs: number,
): Promise<PmProposal | null> {
  const deadline = Date.now() + extraWaitMs;
  // The candidate filter is: a draft proposal that isn't our placeholder
  // AND whose dispatch_state is NOT 'pending_agent' (i.e. NOT another
  // concurrent placeholder). Without the second clause, two simultaneous
  // dispatches would cross-supersede each other's placeholders before
  // either agent row landed. See §2.3 cross-supersede finding.
  const isAgentRow = (p: PmProposal) => p.id !== placeholderId && p.dispatch_state !== 'pending_agent';
  do {
    const drafts = listProposals({ workspace_id: workspaceId, status: 'draft', since: sinceIso });
    const hit = drafts.find(isAgentRow);
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    await new Promise(resolve => setTimeout(resolve, RECONCILER_POLL_MS));
  } while (Date.now() < deadline);
  const drafts = listProposals({ workspace_id: workspaceId, status: 'draft', since: sinceIso });
  return drafts.find(isAgentRow) ?? null;
}

// ─── Synthesize fallback ────────────────────────────────────────────

export interface SynthesizeResult {
  impact_md: string;
  changes: PmDiff[];
  /** Diagnostics for tests / debug logs. */
  parsed: {
    owner_matches: Array<{ token: string; agent_id: string; agent_name: string }>;
    initiative_matches: Array<{ token: string; initiative_id: string; title: string }>;
    date_windows: Array<{ start: string; end: string; raw: string }>;
    explicit_dates: string[];
  };
}

/**
 * Deterministic parser. Extracts:
 *
 *   - Owner names → matched against snapshot owner_agent rows + workspace
 *     agents (so "Sarah out next week" finds Sarah even when she doesn't
 *     own anything yet).
 *   - Date windows: "next week", "this week", "Apr 25 – May 2", or
 *     ISO ranges. Falls back to "today + 7 days" when an owner is
 *     mentioned without a window.
 *   - Initiative references: title substring match against snapshot
 *     initiatives, longest-match-first to avoid "feature" matching when
 *     "big feature" is meant.
 *   - Action verbs: "delay", "slip", "block", "cancel", "out", "delayed".
 *
 * Maps these into PmDiff[]:
 *
 *   - Owner mentioned + window → `add_availability` for that owner.
 *   - Initiative mentioned + delay/slip + new date → `shift_initiative_target`.
 *   - Initiative mentioned + block/at-risk → `set_initiative_status`.
 *
 * If nothing parses, returns an empty changes array and an impact_md that
 * tells the operator the PM didn't understand. (Better honest empty than
 * a false-positive proposal.)
 */
export function synthesizeImpactAnalysis(
  snapshot: RoadmapSnapshot,
  triggerText: string,
): SynthesizeResult {
  const text = triggerText.trim();
  const lower = text.toLowerCase();
  const today = new Date();

  // 1. Build agent lookup. We pull every agent in the workspace, not
  //    just initiative owners — operators talk about teammates by name.
  const agents = queryAll<{ id: string; name: string }>(
    `SELECT id, name FROM agents WHERE workspace_id = ? AND is_active = 1`,
    [snapshot.workspace_id],
  );

  const ownerMatches: SynthesizeResult['parsed']['owner_matches'] = [];
  for (const a of agents) {
    if (!a.name) continue;
    // Match whole-word, case-insensitive. First name OR full name.
    const firstName = a.name.split(/\s+/)[0];
    const re = new RegExp(`\\b(${escapeRe(a.name)}|${escapeRe(firstName)})\\b`, 'i');
    const m = text.match(re);
    if (m) {
      ownerMatches.push({ token: m[1], agent_id: a.id, agent_name: a.name });
    }
  }

  // 2. Initiative title matches (longest-first).
  const initiativeMatches: SynthesizeResult['parsed']['initiative_matches'] = [];
  const sortedByLen = [...snapshot.initiatives].sort((a, b) => b.title.length - a.title.length);
  const consumed: Array<[number, number]> = []; // ranges already claimed
  for (const i of sortedByLen) {
    if (i.title.length < 4) continue; // too noisy
    const re = new RegExp(`\\b${escapeRe(i.title)}\\b`, 'i');
    const m = lower.match(re);
    if (!m || m.index == null) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (consumed.some(([s, e]) => !(end <= s || start >= e))) continue;
    consumed.push([start, end]);
    initiativeMatches.push({ token: m[0], initiative_id: i.id, title: i.title });
  }

  // 3. Date windows. Order of attempts: explicit ISO ranges → month-day
  //    ranges → "next week" / "this week" / "X days".
  const dateWindows: SynthesizeResult['parsed']['date_windows'] = [];
  const explicitDates: string[] = [];

  // ISO range "YYYY-MM-DD to YYYY-MM-DD" / "YYYY-MM-DD - YYYY-MM-DD"
  const isoRangeRe = /(\d{4}-\d{2}-\d{2})\s*(?:[-–—to]+|until)\s*(\d{4}-\d{2}-\d{2})/gi;
  for (const m of text.matchAll(isoRangeRe)) {
    dateWindows.push({ start: m[1], end: m[2], raw: m[0] });
  }
  // Single ISO date — captured if no range already covers it.
  const isoSingleRe = /\b(\d{4}-\d{2}-\d{2})\b/g;
  for (const m of text.matchAll(isoSingleRe)) {
    if (!dateWindows.some(w => w.raw.includes(m[1]))) explicitDates.push(m[1]);
  }

  // "next week" / "this week" / "next N days"
  if (dateWindows.length === 0) {
    if (/\bnext week\b/i.test(text)) {
      const start = nextWeekStart(today);
      const end = addDays(start, 6);
      dateWindows.push({ start: iso(start), end: iso(end), raw: 'next week' });
    } else if (/\bthis week\b/i.test(text)) {
      const start = thisWeekStart(today);
      const end = addDays(start, 6);
      dateWindows.push({ start: iso(start), end: iso(end), raw: 'this week' });
    } else {
      const ndays = text.match(/\b(\d{1,3})\s*(?:days?|d)\b/i);
      if (ndays) {
        const days = parseInt(ndays[1], 10);
        const start = today;
        const end = addDays(start, days - 1);
        dateWindows.push({ start: iso(start), end: iso(end), raw: ndays[0] });
      }
    }
  }

  // 4. Action verbs to dispatch on.
  const verbs = {
    out: /\b(out|away|off|unavailable|sick|vacation|pto|ooo)\b/i.test(lower),
    delay: /\b(delay|delayed|slip|slipping|push(ed)? back|shift(ed)?)\b/i.test(lower),
    block: /\bblock(ed|ing)?\b/i.test(lower),
    risk: /\b(at[- ]?risk|risk(y)?)\b/i.test(lower),
  };

  // 5. Build changes.
  const changes: PmDiff[] = [];
  const summaryBullets: string[] = [];

  // 5a. Availability rows for each owner mention with a window. If no
  //     window was extracted but the verb "out" is present, default to
  //     a 7-day window starting today.
  if (ownerMatches.length > 0 && (verbs.out || dateWindows.length > 0)) {
    const window = dateWindows[0] ?? {
      start: iso(today),
      end: iso(addDays(today, 6)),
      raw: 'today+7d',
    };
    for (const om of ownerMatches) {
      changes.push({
        kind: 'add_availability',
        agent_id: om.agent_id,
        start: window.start,
        end: window.end,
        reason: text.length > 200 ? text.slice(0, 200) + '…' : text,
      });
      summaryBullets.push(
        `Adds availability: ${om.agent_name} unavailable ${window.start} – ${window.end}`,
      );
    }
  }

  // 5b. Initiative shifts. Pick the latest explicit date as the new
  //     target_end if one was supplied; otherwise we don't shift, we
  //     just flag at_risk.
  for (const im of initiativeMatches) {
    if (verbs.delay && explicitDates.length > 0) {
      const newEnd = explicitDates.sort()[explicitDates.length - 1];
      changes.push({
        kind: 'shift_initiative_target',
        initiative_id: im.initiative_id,
        target_end: newEnd,
        reason: text.length > 200 ? text.slice(0, 200) + '…' : text,
      });
      summaryBullets.push(`"${im.title}" target_end → ${newEnd}`);
    } else if (verbs.block) {
      changes.push({
        kind: 'set_initiative_status',
        initiative_id: im.initiative_id,
        status: 'blocked',
      });
      summaryBullets.push(`"${im.title}" → blocked`);
    } else if (verbs.risk || (verbs.delay && ownerMatches.length > 0)) {
      changes.push({
        kind: 'set_initiative_status',
        initiative_id: im.initiative_id,
        status: 'at_risk',
      });
      summaryBullets.push(`"${im.title}" → at_risk`);
    }
  }

  // 5c. If owners were mentioned out-of-office and there are NO
  //     explicit initiative refs, flag every initiative they own as
  //     at_risk so the operator can still see schedule impact.
  if (
    initiativeMatches.length === 0 &&
    ownerMatches.length > 0 &&
    (verbs.out || verbs.delay) &&
    changes.length > 0 // we already added availability
  ) {
    const owned = new Set(ownerMatches.map(o => o.agent_id));
    for (const i of snapshot.initiatives) {
      if (i.owner_agent_id && owned.has(i.owner_agent_id) && i.status !== 'done' && i.status !== 'cancelled') {
        changes.push({
          kind: 'set_initiative_status',
          initiative_id: i.id,
          status: 'at_risk',
        });
        summaryBullets.push(`"${i.title}" → at_risk (owner unavailable)`);
        if (summaryBullets.length >= 8) break; // cap output
      }
    }
  }

  // 6. Run a what-if derivation using the staged availability so the
  //    impact summary can mention slipped milestones too. We only
  //    consult the result; the changes are unchanged.
  const availabilityOverrides = changes
    .filter((c): c is Extract<PmDiff, { kind: 'add_availability' }> => c.kind === 'add_availability')
    .map(c => ({
      agent_id: c.agent_id,
      unavailable_start: c.start,
      unavailable_end: c.end,
      reason: c.reason ?? null,
    }));

  let preview: ReturnType<typeof previewDerivation> | null = null;
  try {
    preview = previewDerivation(snapshot, { availabilityOverrides });
  } catch (err) {
    console.warn('[synthesize] previewDerivation failed:', (err as Error).message);
  }

  if (preview && preview.diffs.length > 0) {
    const headline = preview.diffs[0];
    summaryBullets.unshift(
      `Schedule shift: "${headline.title}" derived_end ${headline.before.derived_end ?? '∅'} → ${headline.after.derived_end ?? '∅'} (and ${preview.diffs.length - 1} other${preview.diffs.length - 1 === 1 ? '' : 's'})`,
    );
  }

  // 7. Compose impact_md.
  const headline =
    changes.length === 0
      ? 'No structured changes inferred — disruption acknowledged'
      : `Disruption parsed: ${changes.length} proposed change${changes.length === 1 ? '' : 's'}`;

  const impactLines: string[] = [`### ${headline}`];
  if (summaryBullets.length > 0) {
    impactLines.push('');
    for (const b of summaryBullets.slice(0, 8)) {
      impactLines.push(`- ${b}`);
    }
  } else {
    impactLines.push(
      '',
      '_The synthesize fallback could not extract specific owners, dates, or initiative references. Refine your request with explicit names and dates._',
    );
  }

  return {
    impact_md: impactLines.join('\n'),
    changes,
    parsed: {
      owner_matches: ownerMatches,
      initiative_matches: initiativeMatches,
      date_windows: dateWindows,
      explicit_dates: explicitDates,
    },
  };
}

// ─── PM chat helper ─────────────────────────────────────────────────

interface PostPmChatMessage {
  workspace_id: string;
  content: string;
  role: 'user' | 'assistant';
  proposal_id?: string;
}

/**
 * Insert one row into agent_chat_messages on the workspace's PM agent.
 * The /pm UI polls + SSE-listens for these. Throws when the PM agent
 * doesn't exist (caller is responsible for ensuring the migration ran).
 */
export function postPmChatMessage(input: PostPmChatMessage): void {
  const pm = queryOne<{ id: string }>(
    `SELECT id FROM agents WHERE workspace_id = ? AND role = 'pm' LIMIT 1`,
    [input.workspace_id],
  );
  if (!pm) {
    throw new Error(
      `No PM agent for workspace ${input.workspace_id} — migration 045 should have seeded one`,
    );
  }
  const metadata = input.proposal_id
    ? JSON.stringify({ proposal_id: input.proposal_id })
    : null;
  run(
    `INSERT INTO agent_chat_messages (id, agent_id, role, content, status, metadata)
     VALUES (?, ?, ?, ?, 'delivered', ?)`,
    [uuidv4(), pm.id, input.role, input.content, metadata],
  );
}

// ─── Date utils ─────────────────────────────────────────────────────

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

function thisWeekStart(d: Date): Date {
  // Monday of the current week (UTC).
  const day = d.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  return addDays(d, offset);
}

/**
 * Conversational "next week" semantics: tomorrow through the Friday of
 * the following workweek. This matches how operators (and the named PM
 * agent) talk about the phrase — "Sarah out next week" said on a
 * Monday means Tue-Fri-and-Mon-Fri, not the ISO-week-after-next which
 * is what `thisWeekStart(d) + 7` would have produced.
 *
 * The window is anchored to "the Monday after today (or today, if today
 * is a Sunday)". Saturdays/Sundays roll forward to the next Monday so
 * a weekend operator saying "out next week" still means the upcoming
 * Mon-Fri.
 */
function nextWeekStart(d: Date): Date {
  const day = d.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0) return addDays(d, 1); // Sunday → tomorrow (Monday)
  if (day === 6) return addDays(d, 2); // Saturday → Monday after
  return addDays(d, 1); // Mon-Fri → tomorrow
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
