/**
 * Brief execution orchestrator.
 *
 * Slice 3 of feat/research-phase-1
 * (specs/research-area-build-plan.md §2.3).
 *
 * Runs as a direct openclaw send-chat to the workspace's researcher
 * persona — NOT through the worker-task pipeline. Briefs don't need
 * a workspace clone, git ops, deliverable storage, or coordinator
 * gates; sendChatAndAwaitReply gives us streaming for free via the
 * onEvent tap.
 *
 * Responsibilities:
 *   1. Resolve the workspace researcher agent.
 *   2. Build the assembled prompt from template + topic context +
 *      user prompt.
 *   3. markRunning + emit brief_started.
 *   4. Drive sendChatAndAwaitReply, tapping onEvent → emit
 *      brief_progress (throttled).
 *   5. On reply: parse citations from the rendered markdown,
 *      setBriefResult, markComplete, emit brief_completed.
 *   6. On send-failure / timeout / no-session / thrown error:
 *      setBriefError, markFailed, emit brief_failed.
 *
 * The orchestrator is fire-and-forget at the API boundary
 * (POST /api/briefs/[id]/run returns immediately after kicking
 * runBrief; the brief progresses asynchronously and the UI
 * subscribes to SSE for updates).
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
import { broadcast } from '@/lib/events';
import {
  sendChatAndAwaitReply,
  type ChatEvent,
  type SendChatAgent,
} from '@/lib/openclaw/send-chat';

/** Default budget for a brief: 5 minutes. Configurable per-call. */
const DEFAULT_BRIEF_TIMEOUT_MS = 5 * 60 * 1000;

/** Throttle progress broadcasts to one per 750ms — enough for the UI
 *  to feel live without flooding SSE consumers with token chunks. */
const PROGRESS_BROADCAST_INTERVAL_MS = 750;

export interface RunBriefOptions {
  timeoutMs?: number;
  /** Test-only: when true, runBrief awaits the dispatch promise rather
   *  than returning immediately. Production callers leave it unset
   *  (fire-and-forget). */
  awaitCompletionForTesting?: boolean;
}

export interface RunBriefResult {
  brief_id: string;
  agent_run_id: string;
  /** "started" — orchestrator kicked dispatch. Consumers tail SSE for
   *  the actual outcome. */
  state: 'started' | 'rejected';
  /** Set when state === 'rejected'. */
  reason?: string;
}

interface ResearcherRow {
  id: string;
  name: string;
  session_key_prefix: string | null;
  gateway_agent_id: string | null;
  model: string | null;
}

function resolveResearcher(workspaceId: string): ResearcherRow | null {
  return (
    queryOne<ResearcherRow>(
      `SELECT id, name, session_key_prefix, gateway_agent_id, model
         FROM agents
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
  if (input.topicContext) {
    sections.push(
      `## Topic context\n` +
      `**${input.topicContext.name}**\n\n` +
      input.topicContext.description,
    );
  }
  sections.push(`## Question\n\n${input.prompt}`);
  sections.push(`## Output instructions\n\n${TEMPLATE_INSTRUCTIONS[input.template]}`);
  return sections.join('\n\n');
}

/**
 * Best-effort citation extraction from a markdown body. Looks for
 * inline markdown links `[label](url)` and produces one citation per
 * unique URL. Phase 1 is intentionally unsophisticated — promote to
 * structured-output prompting in phase 2 once we have a corpus to
 * test against.
 */
export function parseCitations(markdown: string): BriefCitation[] {
  if (!markdown) return [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  const seen = new Map<string, BriefCitation>();
  const accessedAt = new Date().toISOString();
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const [, label, url] = m;
    if (!url.startsWith('http://') && !url.startsWith('https://')) continue;
    if (seen.has(url)) continue;
    seen.set(url, { url, title: label, accessed_at: accessedAt });
  }
  return Array.from(seen.values());
}

/**
 * Extract a single concatenated text body from the gateway's
 * collected ChatEvents. The gateway emits events with `message`
 * either as a string or as an object with role/content; we walk
 * both shapes and concatenate the assistant-side text. The final
 * "done" event typically carries the full reply but we fall back
 * to the concatenated stream if it's missing.
 */
export function extractReplyText(reply: ChatEvent[], doneEvent?: ChatEvent): string {
  const fromDone = readMessageText(doneEvent?.message);
  if (fromDone) return fromDone;
  const parts = reply
    .map(e => readMessageText(e.message))
    .filter((s): s is string => !!s);
  return parts.join('').trim();
}

function readMessageText(message: unknown): string | null {
  if (!message) return null;
  if (typeof message === 'string') return message;
  if (typeof message === 'object' && 'content' in message) {
    const content = (message as { content: unknown }).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      // Best-effort: concatenate any string entries.
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
    // SSE failures must never sink the orchestrator. Log and continue.
    console.error(`[run-brief] failed to broadcast ${type}:`, err);
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

  const researcher = resolveResearcher(brief.workspace_id);
  if (!researcher) {
    const msg = `No active researcher agent found in workspace ${brief.workspace_id}`;
    setBriefError(briefId, msg);
    markFailed(brief.agent_run_id, { error_md: msg });
    emit('brief_failed', briefShape(brief, { error: msg }));
    return;
  }

  const topic = brief.topic_id ? getTopic(brief.topic_id) : null;
  const assembledPrompt = buildBriefPrompt({
    template: brief.template,
    title: brief.title,
    prompt: brief.prompt,
    topicContext: topic ? { name: topic.name, description: topic.description } : null,
  });

  // Move into running BEFORE we send so SSE consumers see the state
  // transition as the source of truth for "this brief is alive."
  markRunning(brief.agent_run_id, {
    model_used: researcher.model ?? null,
  });
  emit('brief_started', briefShape(brief, { workspace_id: brief.workspace_id }));

  const agent: SendChatAgent = {
    id: researcher.id,
    name: researcher.name,
    session_key_prefix: researcher.session_key_prefix ?? undefined,
    gateway_agent_id: researcher.gateway_agent_id ?? undefined,
  };

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

  let reply;
  try {
    reply = await sendChatAndAwaitReply({
      agent,
      message: assembledPrompt,
      timeoutMs: options.timeoutMs ?? DEFAULT_BRIEF_TIMEOUT_MS,
      onEvent,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setBriefError(briefId, msg);
    markFailed(brief.agent_run_id, { error_md: msg });
    emit('brief_failed', briefShape(brief, { error: msg }));
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
    emit('brief_failed', briefShape(brief, { error: msg, reason: reply.reason }));
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
  emit('brief_completed', briefShape(brief, { citation_count: citations.length }));
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

/**
 * Public entry point. Kicks runBriefInternal asynchronously and
 * returns immediately so the API route doesn't block the request
 * cycle. Tests can pass `awaitCompletionForTesting: true` to await
 * the full dispatch.
 */
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
    // Belt-and-braces: any uncaught path inside the orchestrator
    // should still mark the brief failed rather than leaving it
    // running forever.
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
