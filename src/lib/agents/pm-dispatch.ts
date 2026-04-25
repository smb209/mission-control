/**
 * PM dispatch path (Phase 5).
 *
 * Translates an operator-supplied disruption text into a `pm_proposals`
 * row. Phase 5 ships the **synthesize fallback** — a deterministic parser
 * that does naive regex extraction (dates, owner names, initiative refs)
 * and produces a valid PmDiff[] from the snapshot.
 *
 * Why a fallback rather than an LLM call:
 *
 *   - MC has no Anthropic SDK wired today. Adding one is its own
 *     project (auth, model selection, cost cap integration, eval).
 *   - The lifecycle (disruption → proposal → accept → DB change) needs
 *     to be exercised end-to-end before we layer in LLM polish. A
 *     deterministic path is testable and cheap.
 *   - The MCP `propose_changes` tool is ALSO available, so an out-of-band
 *     PM session running through openclaw + sc-mission-control can
 *     produce richer proposals; the synthesize path is the "operator
 *     hits enter, gets something useful back instantly" floor.
 *
 * The contract: given a workspace snapshot and a free-text trigger,
 * return a draft proposal whose changes only reference real ids in the
 * snapshot. Hallucinated ids are a bug (tests cover this).
 *
 * Phase 6 may swap this implementation for an LLM-driven one — the
 * caller surface (`synthesizeImpactAnalysis`) stays stable.
 */

import { getRoadmapSnapshot, type RoadmapSnapshot } from '@/lib/db/roadmap';
import { previewDerivation } from '@/lib/roadmap/apply-derivation';
import { queryAll, queryOne, run } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';
import {
  createProposal,
  type PmDiff,
  type PmProposal,
  type PmProposalTriggerKind,
} from '@/lib/db/pm-proposals';

// ─── Public API ─────────────────────────────────────────────────────

export interface DispatchPmInput {
  workspace_id: string;
  trigger_text: string;
  trigger_kind?: PmProposalTriggerKind;
  parent_proposal_id?: string | null;
}

export interface DispatchPmResult {
  proposal: PmProposal;
  used_synthesize_fallback: true;
}

/**
 * Top-level dispatch entry. Today it always uses the synthesize fallback;
 * Phase 6 may add a route to an LLM. Persists the proposal as a side
 * effect and posts a chat message on the PM agent's chat thread referencing
 * the proposal_id (so the /pm UI's card renderer fires).
 */
export function dispatchPm(input: DispatchPmInput): DispatchPmResult {
  const snapshot = getRoadmapSnapshot({ workspace_id: input.workspace_id });
  const synth = synthesizeImpactAnalysis(snapshot, input.trigger_text);

  const proposal = createProposal({
    workspace_id: input.workspace_id,
    trigger_text: input.trigger_text,
    trigger_kind: input.trigger_kind ?? 'manual',
    impact_md: synth.impact_md,
    proposed_changes: synth.changes,
    parent_proposal_id: input.parent_proposal_id ?? null,
  });

  // Best-effort: post the impact summary into the PM agent's chat with
  // a metadata.proposal_id so the /pm UI renders it as a card. Fails
  // silently (the proposal still exists; the chat is a UX nicety).
  try {
    postPmChatMessage({
      workspace_id: input.workspace_id,
      content: synth.impact_md,
      proposal_id: proposal.id,
      role: 'assistant',
    });
    // Also echo the operator's trigger as a 'user' message so the chat
    // shows the conversation. Safe to add here because this dispatch is
    // currently the only entry point — when Phase 6 adds a real chat
    // input pipe we'll move this to that route.
    postPmChatMessage({
      workspace_id: input.workspace_id,
      content: input.trigger_text,
      role: 'user',
    });
  } catch (err) {
    console.warn('[pm-dispatch] chat insert failed:', (err as Error).message);
  }

  return { proposal, used_synthesize_fallback: true };
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
