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
  type PmDiff,
  type PmProposal,
  type PmProposalTriggerKind,
} from '@/lib/db/pm-proposals';
import { getOpenClawClient } from '@/lib/openclaw/client';
import {
  sendChatAndAwaitReply,
  __setSendChatClientForTests,
  type SendChatClient,
} from '@/lib/openclaw/send-chat';
import type { Agent } from '@/lib/types';

// ─── Public API ─────────────────────────────────────────────────────

export interface DispatchPmInput {
  workspace_id: string;
  trigger_text: string;
  trigger_kind?: PmProposalTriggerKind;
  parent_proposal_id?: string | null;
}

export interface DispatchPmResult {
  proposal: PmProposal;
  used_synthesize_fallback: boolean;
  used_named_agent?: boolean;
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
 * Top-level dispatch entry. Routes through the named openclaw agent when
 * available; falls back to `synthesizeImpactAnalysis` otherwise. Always
 * persists a proposal + posts the operator/PM messages into the PM
 * agent's chat thread so the /pm UI's card renderer fires.
 */
export async function dispatchPm(input: DispatchPmInput): Promise<DispatchPmResult> {
  const snapshot = getRoadmapSnapshot({ workspace_id: input.workspace_id });
  const pm = lookupPmAgent(input.workspace_id);

  // Always echo the operator's trigger as a user message regardless of
  // path so the /pm chat reflects the conversation faithfully.
  try {
    postPmChatMessage({
      workspace_id: input.workspace_id,
      content: input.trigger_text,
      role: 'user',
    });
  } catch (err) {
    console.warn('[pm-dispatch] user chat insert failed:', (err as Error).message);
  }

  // ── 1. Try the named-agent path ────────────────────────────────────
  if (pm && pm.gateway_agent_id) {
    const gw = gatewayClient();
    if (gw.isConnected()) {
      try {
        const proposal = await dispatchViaNamedAgent({
          input,
          snapshot,
          pm,
        });
        if (proposal) {
          try {
            postPmChatMessage({
              workspace_id: input.workspace_id,
              content: proposal.impact_md,
              proposal_id: proposal.id,
              role: 'assistant',
            });
          } catch (err) {
            console.warn('[pm-dispatch] assistant chat insert failed:', (err as Error).message);
          }
          return { proposal, used_synthesize_fallback: false, used_named_agent: true };
        }
      } catch (err) {
        console.warn(
          '[pm-dispatch] named-agent dispatch failed; falling back to synth:',
          (err as Error).message,
        );
      }
    }
  }

  // ── 2. Synthesize fallback ────────────────────────────────────────
  const synth = synthesizeImpactAnalysis(snapshot, input.trigger_text);
  const proposal = createProposal({
    workspace_id: input.workspace_id,
    trigger_text: input.trigger_text,
    trigger_kind: input.trigger_kind ?? 'manual',
    impact_md: synth.impact_md,
    proposed_changes: synth.changes,
    parent_proposal_id: input.parent_proposal_id ?? null,
  });
  try {
    postPmChatMessage({
      workspace_id: input.workspace_id,
      content: synth.impact_md,
      proposal_id: proposal.id,
      role: 'assistant',
    });
  } catch (err) {
    console.warn('[pm-dispatch] chat insert failed:', (err as Error).message);
  }
  return { proposal, used_synthesize_fallback: true, used_named_agent: false };
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

interface DispatchNamedAgentParams {
  input: DispatchPmInput;
  snapshot: RoadmapSnapshot;
  pm: Pick<Agent, 'id' | 'name' | 'session_key_prefix' | 'gateway_agent_id' | 'workspace_id'>;
}

/**
 * Send the trigger to the gateway-hosted PM session and wait for the
 * agent's `final` chat frame (signalling its turn is over). Then look up
 * the proposal it created via the MCP `propose_changes` tool and return
 * it.
 *
 * Replaces the original "poll pm_proposals every 500ms by recency"
 * workaround with a proper subscription-based wait via
 * `sendChatAndAwaitReply`. The chat-listener's existing `state==='final'`
 * is the same signal the per-agent chat surface already uses, so we get
 * "agent turn complete" deterministically.
 *
 * Correlation: we still embed a `correlation_id` in the message body
 * (audit trail). Lookup remains "most recent draft draft created since
 * we sent" — that's deterministic given dispatch is single-flight from
 * the operator's perspective.
 *
 * Returns:
 *   - the PmProposal the agent created during this round-trip, or
 *   - `null` if the timeout elapses, the send fails, or the agent never
 *     called `propose_changes`. The caller falls back to synth.
 */
async function dispatchViaNamedAgent(params: DispatchNamedAgentParams): Promise<PmProposal | null> {
  const { input, snapshot, pm } = params;
  const correlationId = uuidv4();
  const sinceIso = new Date().toISOString();

  const summary = buildSnapshotSummary(snapshot);
  const message =
    `**PM dispatch (correlation_id: ${correlationId})**\n\n` +
    `Operator-reported event:\n> ${input.trigger_text}\n\n` +
    `Workspace snapshot summary (call \`get_roadmap_snapshot\` via MCP for full detail):\n\n` +
    `${summary}\n\n` +
    `Per your SOUL.md: analyse the disruption and call \`propose_changes\` ` +
    `with a structured PmDiff[] and impact_md. Reference only ids that ` +
    `appear in the snapshot.`;

  const result = await sendChatAndAwaitReply({
    agent: pm,
    message,
    idempotencyKey: `pm-dispatch-${correlationId}`,
    timeoutMs: namedAgentTimeoutMs(),
    // Stable session keeps the PM agent warm between disruption dispatches.
    // Fresh plan-<uuid> sessions are used for plan/decompose flows instead.
    sessionSuffix: 'dispatch-main',
  });

  // Send failed — caller falls back to synth.
  if (!result.sent) return null;

  // Whether we got a `final` frame or hit the timeout, do one final
  // check for a proposal landed by the agent's MCP `propose_changes`
  // call. The named-agent path is "useful" only if the agent actually
  // wrote a proposal during the round-trip.
  return findProposalCreatedSince(input.workspace_id, sinceIso);
}

function findProposalCreatedSince(workspaceId: string, sinceIso: string): PmProposal | null {
  const drafts = listProposals({ workspace_id: workspaceId, status: 'draft', since: sinceIso });
  // listProposals returns DESC by created_at — pick the newest.
  return drafts[0] ?? null;
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
  synth: { impact_md: string; changes: PmDiff[] };
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
}

export async function dispatchPmSynthesized(
  input: DispatchSynthesizedInput,
): Promise<{ proposal: PmProposal; used_synthesize_fallback: boolean; used_named_agent: boolean }> {
  const pm = lookupPmAgent(input.workspace_id);
  if (pm && pm.gateway_agent_id) {
    const gw = gatewayClient();
    if (gw.isConnected()) {
      try {
        const correlationId = uuidv4();
        const sinceIso = new Date().toISOString();
        const sessionSuffix = input.planSessionKey ?? 'main';
        const result = await sendChatAndAwaitReply({
          agent: pm,
          message:
            `**PM ${input.trigger_kind} (correlation_id: ${correlationId})**\n\n` +
            input.agent_prompt,
          idempotencyKey: `pm-${input.trigger_kind}-${correlationId}`,
          timeoutMs: namedAgentTimeoutMs(),
          sessionSuffix,
        });
        if (result.sent) {
          // Whether we got a `final` frame or hit the timeout, the agent
          // either landed a proposal via MCP `propose_changes` or didn't.
          // Either way, this is the moment to look — same semantics as
          // dispatchViaNamedAgent.
          const found = findProposalCreatedSince(input.workspace_id, sinceIso);
          if (found) {
            // Reconcile the row with this dispatch's intent. The PM
            // agent's `propose_changes` call is freeform — it can pass
            // a wrong trigger_kind (defaults to 'manual' if omitted)
            // and doesn't accept target_initiative_id at all. We know
            // what kind of dispatch this was and where it came from,
            // so stamp both onto the row so the downstream Apply path
            // (which validates trigger_kind === 'plan_initiative' when
            // target_initiative_id is supplied) doesn't reject what is
            // really a plan_initiative proposal.
            const fixes: string[] = [];
            const vals: unknown[] = [];
            let nextTriggerKind = found.trigger_kind;
            let nextTarget = found.target_initiative_id;
            if (found.trigger_kind !== input.trigger_kind) {
              fixes.push('trigger_kind = ?');
              vals.push(input.trigger_kind);
              nextTriggerKind = input.trigger_kind;
            }
            if (input.target_initiative_id && !found.target_initiative_id) {
              fixes.push('target_initiative_id = ?');
              vals.push(input.target_initiative_id);
              nextTarget = input.target_initiative_id;
            }
            if (fixes.length > 0) {
              try {
                run(`UPDATE pm_proposals SET ${fixes.join(', ')} WHERE id = ?`, [...vals, found.id]);
                return {
                  proposal: {
                    ...found,
                    trigger_kind: nextTriggerKind,
                    target_initiative_id: nextTarget,
                  },
                  used_synthesize_fallback: false,
                  used_named_agent: true,
                };
              } catch (err) {
                console.warn('[pm-dispatch] post-hoc stamp failed:', (err as Error).message);
              }
            }
            return { proposal: found, used_synthesize_fallback: false, used_named_agent: true };
          }
        }
      } catch (err) {
        console.warn(
          '[pm-dispatch] synthesized named-agent dispatch failed; falling back:',
          (err as Error).message,
        );
      }
    }
  }
  // Fallback — persist the synthesized proposal exactly like before.
  const proposal = createProposal({
    workspace_id: input.workspace_id,
    trigger_text: input.trigger_text,
    trigger_kind: input.trigger_kind,
    impact_md: input.synth.impact_md,
    proposed_changes: input.synth.changes,
    parent_proposal_id: input.parent_proposal_id ?? null,
    target_initiative_id: input.target_initiative_id ?? null,
  });
  return { proposal, used_synthesize_fallback: true, used_named_agent: false };
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

function nextWeekStart(d: Date): Date {
  return addDays(thisWeekStart(d), 7);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
