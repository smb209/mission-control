/**
 * Brief execution orchestrator.
 *
 * Phase 2 (feat/research-phase-2-runner-dispatch): briefs are now
 * dispatched through the workspace runner via `dispatchScope`, the
 * scope-keyed-sessions primitive that composes the role's briefing
 * (SOUL.md + AGENTS.md + IDENTITY.md from `agent-templates/researcher/`)
 * into the session BEFORE the prompt is sent.
 *
 * This corrects phase 1's design mistake — phase 1 used raw
 * `send-chat` directly against an `agents` row whose `gateway_agent_id`
 * had to point at a real openclaw agent. The agent system is built
 * around exactly two real gateway agents per workspace (the runner +
 * the PM); every other "agent" is a *role-only roster entry* that the
 * runner takes on via persona-scoped sessions.
 *
 * The roster entry must still exist — `resolveResearcherRosterEntry`
 * verifies the workspace has opted in to research by adding a
 * researcher row (operator does this via the Add Agents picker). If
 * not, we surface a clean message instead of silently inventing one.
 *
 * Flow:
 *   1. Verify workspace has a researcher roster entry.
 *   2. Verify a runner agent exists.
 *   3. markRunning + emit brief_started.
 *   4. dispatchScope({ role: 'researcher', agent: runner, ... }) —
 *      buildBriefing applies the researcher persona.
 *   5. Tap onEvent for throttled brief_progress broadcasts.
 *   6. On reply: parse citations, setBriefResult, markComplete,
 *      emit brief_completed.
 *   7. On any failure: setBriefError, markFailed, emit brief_failed.
 *
 * Fire-and-forget at the API boundary; the UI subscribes to SSE.
 */

import { queryOne } from '@/lib/db';
import {
  getAgentRun,
  markComplete,
  markFailed,
  markRunning,
} from '@/lib/db/agent-runs';
import {
  getBrief,
  setBriefError,
  setBriefResult,
  type Brief,
  type BriefCitation,
  type BriefTemplate,
} from '@/lib/db/briefs';
import { getTopic } from '@/lib/db/topics';
import { recordBriefOutcome } from '@/lib/db/recurring-jobs';
import { broadcast } from '@/lib/events';
import { dispatchScope } from '@/lib/agents/dispatch-scope';
import { getRunnerAgent } from '@/lib/agents/runner';
import type { ChatEvent } from '@/lib/openclaw/send-chat';

const DEFAULT_BRIEF_TIMEOUT_MS = 5 * 60 * 1000;
const PROGRESS_BROADCAST_INTERVAL_MS = 750;

/** When dispatchScope returns `no_session`, retry with a small
 *  backoff for up to this many attempts before giving up. Catches
 *  transient gateway-reconnect windows (HMR restarts, dev server
 *  bounces) where the brief otherwise fails instantly for what is
 *  really a sub-second outage. */
const NO_SESSION_MAX_RETRIES = 5;
const NO_SESSION_RETRY_DELAY_MS = 1500;

export interface RunBriefOptions {
  timeoutMs?: number;
  /** Test-only: when true, runBrief awaits the dispatch promise rather
   *  than returning immediately. */
  awaitCompletionForTesting?: boolean;
  /** Override the no_session retry backoff (ms). Tests pass small
   *  values to keep the test wall-clock low. */
  noSessionRetryDelayMs?: number;
  /** Override the no_session max retries. Default 5. */
  noSessionMaxRetries?: number;
}

export interface RunBriefResult {
  brief_id: string;
  agent_run_id: string;
  state: 'started' | 'rejected';
  reason?: string;
}

/**
 * The researcher roster entry — any agent row in the workspace with
 * role='researcher'. The row may be `source='local'` with no
 * `gateway_agent_id` (role-only ephemeral marker, the canonical
 * shape) or a real gateway-bound row (legacy / hand-provisioned).
 * We don't care which; presence is what matters.
 */
interface ResearcherRosterEntry {
  id: string;
  name: string;
}

function resolveResearcherRosterEntry(workspaceId: string): ResearcherRosterEntry | null {
  return (
    queryOne<ResearcherRosterEntry>(
      `SELECT id, name FROM agents
        WHERE workspace_id = ? AND role = 'researcher' AND COALESCE(is_active, 1) = 1
        LIMIT 1`,
      [workspaceId],
    ) ?? null
  );
}

/**
 * Phase 1 templates. Adding a new template means widening this map
 * AND the CHECK constraint in migration 075 (via a follow-up
 * additive migration).
 */
const TEMPLATE_INSTRUCTIONS: Record<BriefTemplate, string> = {
  general_brief:
    `Produce a research brief in your standard output format ` +
    `(executive summary → key findings with citations → gaps and ` +
    `open questions → recommended next steps). Cite sources inline ` +
    `as markdown links. Keep the brief between 200 and 2000 words.`,
};

export interface BuildPromptInput {
  template: BriefTemplate;
  title: string;
  prompt: string;
  topicContext?: { name: string; description: string } | null;
}

export function buildBriefPrompt(input: BuildPromptInput): string {
  const sections: string[] = [];
  sections.push(`# Research Brief request: ${input.title}`);
  // Override the persona's task-completion sequence. The researcher
  // AGENTS.md instructs the agent to call `register_deliverable` /
  // `update_task_status` keyed on `task_id` — but briefs aren't
  // tasks, so those calls fail. The orchestrator captures the agent's
  // reply text directly via sendChatAndAwaitReply. Tell the agent
  // explicitly so it doesn't waste tokens (and produce a confused
  // "couldn't find that task" trail) on the deliverable flow.
  sections.push(
    `## How to deliver this brief\n\n` +
    `**This is a Research Brief, NOT a Mission Control task.** Do NOT call ` +
    `\`register_deliverable\`, \`update_task_status\`, or \`log_activity\`. ` +
    `The \`task_id\` you see in your briefing is a synthetic scope key — ` +
    `there is no underlying task row, and these tool calls will fail.\n\n` +
    `**Deliver by replying with the brief body as your final assistant ` +
    `message.** The orchestrator captures whatever text you reply with as ` +
    `the brief's \`result_md\` and parses citations from inline markdown ` +
    `links. No \`take_note\` / breadcrumb chain is needed — there is no ` +
    `next stage; the operator reads your reply directly.`,
  );
  if (input.topicContext) {
    sections.push(
      `## Topic context\n` +
      `**${input.topicContext.name}**\n\n` +
      input.topicContext.description,
    );
  }
  sections.push(`## Question\n\n${input.prompt}`);
  sections.push(`## Output instructions\n\n${TEMPLATE_INSTRUCTIONS[input.template]}`);
  // Required: explicit "## Sources" section at the end. Inline links
  // are great for context but they're easy to miss in regex parsing
  // and don't carry a "what this gave us" annotation. The Sources
  // section is the canonical list — every URL the agent consulted,
  // titled, with a one-line note. parseCitations prefers this
  // section and falls back to inline links when missing.
  sections.push(
    `## Sources (REQUIRED)\n\n` +
    `End your brief with a **\`## Sources\`** heading followed by a ` +
    `markdown list of every URL you actually consulted while ` +
    `synthesizing this brief. Format each entry as:\n\n` +
    `\`- [Title](url) — one-line note on what this source contributed.\`\n\n` +
    `Include every source — even ones cited only once inline. If you ` +
    `consulted no live sources (i.e. answered from training only), ` +
    `say so explicitly: \`- No live sources consulted; brief reflects ` +
    `model knowledge as of the training cutoff.\``,
  );
  return sections.join('\n\n');
}

/**
 * Citation extraction from a brief's markdown body. Two-pass:
 *
 *   1. Look for an explicit "## Sources" (or "## References") section
 *      and extract entries from its markdown list. Each entry can
 *      include a `— note` after the link, captured as `snippet`.
 *      This is the agent's canonical "what I consulted" list.
 *
 *   2. Fall back to scanning every inline markdown link in the body
 *      when no Sources section exists (older briefs, agents that
 *      ignore the prompt instruction).
 *
 * Sources-section entries take precedence — if a URL appears both
 * inline and in the section, the section's title + note win.
 */
export function parseCitations(markdown: string): BriefCitation[] {
  if (!markdown) return [];
  const accessedAt = new Date().toISOString();
  const seen = new Map<string, BriefCitation>();

  const sectionBody = extractSourcesSection(markdown);
  if (sectionBody) {
    // Per-line walk; expect markdown list items like
    //   - [Title](url) — note text
    // We accept indented lines and either em-dash or hyphen as the
    // note delimiter. Important: use `[ \t]` not `\s` between the
    // URL and the note delimiter so we never cross a newline into
    // the next list item (which would steal the next item as our
    // own snippet).
    const lineRe = /^[ \t]*[-*][ \t]+\[([^\]]+)\]\(([^)\s]+)\)[ \t]*(?:[—–-][ \t]+(.*))?$/gm;
    let m: RegExpExecArray | null;
    while ((m = lineRe.exec(sectionBody)) !== null) {
      const [, title, url, note] = m;
      if (!url.startsWith('http://') && !url.startsWith('https://')) continue;
      seen.set(url, {
        url,
        title: title.trim(),
        accessed_at: accessedAt,
        snippet: note?.trim() || undefined,
      });
    }
  }

  // Inline-link sweep for URLs that didn't appear in the Sources
  // section (or for briefs without one).
  const inlineRe = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = inlineRe.exec(markdown)) !== null) {
    const [, label, url] = m;
    if (!url.startsWith('http://') && !url.startsWith('https://')) continue;
    if (seen.has(url)) continue;
    seen.set(url, { url, title: label, accessed_at: accessedAt });
  }
  return Array.from(seen.values());
}

/**
 * Returns the body of the Sources/References section, or null if no
 * such heading exists. Section ends at the next heading of equal or
 * higher level, or at end-of-document.
 */
function extractSourcesSection(markdown: string): string | null {
  // Find the heading line. We accept `## Sources`, `## References`,
  // `## Sources (REQUIRED)`, etc. — the parenthetical is the prompt's
  // own annotation that some agents echo into the body.
  const headingRe = /^(\#{2,})\s+(sources|references)\b[^\n]*$/im;
  const headingMatch = headingRe.exec(markdown);
  if (!headingMatch) return null;

  const start = headingMatch.index + headingMatch[0].length;
  const rest = markdown.slice(start);
  // Section ends at the next markdown heading (any level). JavaScript
  // regex lacks `\Z`, so use a lookahead for the next heading and fall
  // through to end-of-string when none matches.
  const endRe = /^\#{1,}\s/m;
  const endMatch = endRe.exec(rest);
  return endMatch ? rest.slice(0, endMatch.index) : rest;
}

/**
 * Extract the brief body from the gateway's ChatEvents.
 *
 * The naive read — concatenate everything or use the `done` event's
 * message — fails when the researcher makes tool calls. A typical
 * problem run interleaves narration messages with `register_deliverable`
 * / file-write tool calls; the `done` event then carries only the
 * final narration ("A copy has been saved to research-brief-*.md")
 * and we lose the actual brief body that landed in an earlier
 * assistant message.
 *
 * Heuristic, in priority order:
 *
 *   1. If any assistant message contains a markdown heading
 *      (`# `, `## `, `### `, with optional leading `***`/`---`
 *      separator), pick the LONGEST such message. Briefs always
 *      open with a heading; narrations almost never do.
 *   2. Otherwise fall back to the `done` event's text.
 *   3. Otherwise concatenate the stream.
 */
export function extractReplyText(reply: ChatEvent[], doneEvent?: ChatEvent): string {
  const candidates = reply
    .map(e => readMessageText(e.message))
    .filter((s): s is string => !!s)
    .map(s => s.trim())
    .filter(Boolean);

  // Headings the brief writer reliably emits. Allow optional leading
  // `***`/`---`/whitespace so a leading separator before the heading
  // isn't a miss.
  const HEADING_RE = /(^|\n)\s*(?:[*-]{3,}\s*\n+)?\s*#{1,3}\s+\S/;
  const headingMatches = candidates.filter(s => HEADING_RE.test(s));
  if (headingMatches.length > 0) {
    headingMatches.sort((a, b) => b.length - a.length);
    return headingMatches[0];
  }

  const fromDone = readMessageText(doneEvent?.message)?.trim();
  if (fromDone) return fromDone;
  return candidates.join('').trim();
}

function readMessageText(message: unknown): string | null {
  if (!message) return null;
  if (typeof message === 'string') return message;
  if (typeof message === 'object' && 'content' in message) {
    const content = (message as { content: unknown }).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map(c => (typeof c === 'string' ? c : typeof c === 'object' && c && 'text' in c && typeof (c as { text: unknown }).text === 'string' ? (c as { text: string }).text : ''))
        .filter(Boolean)
        .join('');
    }
  }
  return null;
}

function emit(
  type: 'brief_started' | 'brief_progress' | 'brief_completed' | 'brief_failed',
  payload: Record<string, unknown>,
): void {
  try {
    broadcast({ type, payload });
  } catch (err) {
    console.error(`[run-brief] failed to broadcast ${type}:`, err);
  }
  // Async outcome tracking for research schedules: when a brief that
  // came from a recurring schedule terminates, update the schedule's
  // failure counter so async failures bump consecutive_failures and
  // pause-after-3 fires correctly. The dispatch path's
  // markRunSuccess already advanced next_run_at — we only adjust the
  // failure book-keeping here. Non-schedule briefs return null and
  // this is a no-op.
  if (type === 'brief_completed' || type === 'brief_failed') {
    const agentRunId = payload.agent_run_id;
    if (typeof agentRunId === 'string' && agentRunId) {
      try {
        recordBriefOutcome(agentRunId, type === 'brief_completed' ? 'completed' : 'failed');
      } catch (err) {
        console.error(`[run-brief] recordBriefOutcome failed:`, err);
      }
    }
  }
}

async function runBriefInternal(briefId: string, options: RunBriefOptions): Promise<void> {
  const brief = getBrief(briefId);
  if (!brief) {
    console.error(`[run-brief] brief ${briefId} not found at dispatch time`);
    return;
  }
  const run = getAgentRun(brief.agent_run_id);
  if (!run) {
    console.error(`[run-brief] agent_run ${brief.agent_run_id} missing for brief ${briefId}`);
    return;
  }
  if (run.status !== 'queued') {
    console.warn(`[run-brief] brief ${briefId} agent_run is ${run.status}, not queued — refusing to dispatch`);
    return;
  }

  // 1. Verify the workspace has opted in to research by adding a
  //    researcher to its roster. The row is a roster marker only —
  //    actual dispatch goes through the runner with the persona
  //    applied at briefing time.
  const researcher = resolveResearcherRosterEntry(brief.workspace_id);
  if (!researcher) {
    const msg =
      `This workspace has no researcher in its roster. Add one via ` +
      `Agents → "Add agents" → pick a team that includes a researcher ` +
      `(e.g. "Research & write") or pick the Researcher role directly. ` +
      `Then re-run this brief.`;
    setBriefError(briefId, msg);
    markFailed(brief.agent_run_id, { error_md: msg });
    emit('brief_failed', briefShape(brief, { error: msg, reason: 'no_researcher_in_roster' }));
    return;
  }

  // 2. Resolve the workspace runner — the only gateway agent that
  //    actually hosts the chat session.
  const runner = getRunnerAgent();
  if (!runner) {
    const msg =
      `No runner agent registered. The runner (mc-runner-dev) is the ` +
      `gateway-bound host for all role-scoped sessions. Provision it ` +
      `via the openclaw gateway, then re-run.`;
    setBriefError(briefId, msg);
    markFailed(brief.agent_run_id, { error_md: msg });
    emit('brief_failed', briefShape(brief, { error: msg, reason: 'no_runner' }));
    return;
  }

  const topic = brief.topic_id ? getTopic(brief.topic_id) : null;
  const triggerBody = buildBriefPrompt({
    template: brief.template,
    title: brief.title,
    prompt: brief.prompt,
    topicContext: topic ? { name: topic.name, description: topic.description } : null,
  });

  // 3. Move into running BEFORE we send so SSE consumers see the
  //    state transition as the source of truth for "this brief is alive."
  markRunning(brief.agent_run_id, {
    model_used: runner.model ?? null,
  });
  emit('brief_started', briefShape(brief, { workspace_id: brief.workspace_id }));

  let lastProgressBroadcastAt = 0;
  const onEvent = (event: ChatEvent) => {
    const now = Date.now();
    if (now - lastProgressBroadcastAt < PROGRESS_BROADCAST_INTERVAL_MS) return;
    lastProgressBroadcastAt = now;
    emit('brief_progress', briefShape(brief, {
      seq: typeof event.seq === 'number' ? event.seq : null,
      state: typeof event.state === 'string' ? event.state : null,
    }));
  };

  // 4. dispatchScope handles: scope_key derivation, mc_sessions
  //    bookkeeping, briefing composition (researcher persona),
  //    chat.send + reply collection.
  //
  // Retry loop: when the gateway client is mid-reconnect (HMR,
  // dev-server restart, transient WebSocket drop), dispatchScope
  // returns reply.reason='no_session' immediately. Failing the
  // brief on a sub-second connection blip is bad UX — wait briefly
  // and retry. Other failure modes (timeout, send_failed) are real
  // and we don't retry them.
  const maxRetries = options.noSessionMaxRetries ?? NO_SESSION_MAX_RETRIES;
  const retryDelayMs = options.noSessionRetryDelayMs ?? NO_SESSION_RETRY_DELAY_MS;
  let result;
  let lastNoSessionAt: number | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      result = await dispatchScope({
        workspace_id: brief.workspace_id,
        role: 'researcher',
        agent: runner,
        session_suffix: `brief-${brief.id}`,
        trigger_body: triggerBody,
        timeoutMs: options.timeoutMs ?? DEFAULT_BRIEF_TIMEOUT_MS,
        onEvent,
        attempt_strategy: 'fresh',
        // run-brief.ts already manages a kind='brief' agent_runs row
        // externally (markRunning above). Skip dispatchScope's own
        // bookkeeping to avoid double-writing.
        skip_run_row: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBriefError(briefId, msg);
      markFailed(brief.agent_run_id, { error_md: msg });
      emit('brief_failed', briefShape(brief, { error: msg, reason: 'dispatch_threw' }));
      return;
    }

    if (result.reply?.sent) break;
    if (result.reply?.reason !== 'no_session') break;

    // Transient: gateway not connected at this exact instant. Surface
    // it as a progress event so the UI can show "reconnecting…", then
    // back off and try again.
    lastNoSessionAt = Date.now();
    emit('brief_progress', briefShape(brief, {
      state: 'awaiting_gateway',
      attempt,
      max_attempts: maxRetries,
    }));
    if (attempt < maxRetries) {
      await new Promise(r => setTimeout(r, retryDelayMs));
    }
  }

  // result is guaranteed assigned above (the loop sets it on every
  // iteration before the break checks).
  if (!result) {
    // Defensive — should not happen.
    const msg = 'Internal: dispatch loop exited without a result.';
    setBriefError(briefId, msg);
    markFailed(brief.agent_run_id, { error_md: msg });
    emit('brief_failed', briefShape(brief, { error: msg, reason: 'no_result' }));
    return;
  }
  void lastNoSessionAt;

  const reply = result.reply;
  if (!reply) {
    // dry_run path — should not happen in production. Fail loudly.
    const msg = 'dispatchScope returned no reply (dry-run?); cannot complete brief.';
    setBriefError(briefId, msg);
    markFailed(brief.agent_run_id, { error_md: msg });
    emit('brief_failed', briefShape(brief, { error: msg, reason: 'no_reply' }));
    return;
  }

  if (!reply.sent) {
    const msg = reply.reason === 'no_session'
      ? 'Openclaw gateway is not connected; cannot dispatch researcher.'
      : reply.reason === 'send_failed'
        ? `chat.send failed: ${reply.error?.message ?? 'unknown error'}`
        : `dispatch failed: ${reply.reason ?? 'unknown'}`;
    setBriefError(briefId, msg);
    markFailed(brief.agent_run_id, { error_md: msg });
    emit('brief_failed', briefShape(brief, { error: msg, reason: reply.reason ?? 'dispatch_failed' }));
    return;
  }

  if (reply.timedOut) {
    const msg = `Researcher did not return a final reply within ${(options.timeoutMs ?? DEFAULT_BRIEF_TIMEOUT_MS) / 1000}s`;
    setBriefError(briefId, msg);
    markFailed(brief.agent_run_id, { error_md: msg });
    emit('brief_failed', briefShape(brief, { error: msg, reason: 'timeout' }));
    return;
  }

  const body = extractReplyText(reply.reply ?? [], reply.doneEvent);
  if (!body || body.trim().length === 0) {
    const msg = 'Researcher returned an empty body.';
    setBriefError(briefId, msg);
    markFailed(brief.agent_run_id, { error_md: msg });
    emit('brief_failed', briefShape(brief, { error: msg, reason: 'empty_reply' }));
    return;
  }

  const citations = parseCitations(body);
  setBriefResult(briefId, { result_md: body, citations });
  markComplete(brief.agent_run_id);
  emit('brief_completed', briefShape(brief, {
    citation_count: citations.length,
    scope_key: result.scope_key,
    briefing_bytes: result.briefing_bytes,
  }));
  // Touch researcher to mark "use" — silences unused-var lint while
  // also providing a hook if we want to surface researcher attribution
  // in completion events later.
  void researcher;
}

function briefShape(brief: Brief, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    brief_id: brief.id,
    agent_run_id: brief.agent_run_id,
    workspace_id: brief.workspace_id,
    topic_id: brief.topic_id,
    template: brief.template,
    ...extras,
  };
}

export async function runBrief(
  briefId: string,
  options: RunBriefOptions = {},
): Promise<RunBriefResult> {
  const brief = getBrief(briefId);
  if (!brief) {
    return { brief_id: briefId, agent_run_id: '', state: 'rejected', reason: 'brief_not_found' };
  }
  const run = getAgentRun(brief.agent_run_id);
  if (!run) {
    return { brief_id: briefId, agent_run_id: brief.agent_run_id, state: 'rejected', reason: 'agent_run_not_found' };
  }
  if (run.status !== 'queued') {
    return {
      brief_id: briefId,
      agent_run_id: brief.agent_run_id,
      state: 'rejected',
      reason: `agent_run is ${run.status}, expected queued`,
    };
  }

  const promise = runBriefInternal(briefId, options).catch(err => {
    console.error(`[run-brief] uncaught failure in orchestrator:`, err);
    const errMsg = err instanceof Error ? err.message : String(err);
    try {
      setBriefError(briefId, `Orchestrator crashed: ${errMsg}`);
      markFailed(brief.agent_run_id, { error_md: `Orchestrator crashed: ${errMsg}` });
      emit('brief_failed', briefShape(brief, { error: errMsg, reason: 'orchestrator_crash' }));
    } catch {
      // If even the failure-write path throws, give up gracefully.
    }
  });

  if (options.awaitCompletionForTesting) {
    await promise;
  }

  return {
    brief_id: briefId,
    agent_run_id: brief.agent_run_id,
    state: 'started',
  };
}
