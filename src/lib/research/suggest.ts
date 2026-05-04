/**
 * PM-driven research suggestion dispatcher.
 *
 * Operator clicks Suggest on the Research hub → this module:
 *   1. Gathers a workspace context snapshot (initiatives, tasks,
 *      recent briefs, existing topics).
 *   2. Builds a prompt asking the workspace PM to propose 3–5
 *      candidate topics OR briefs (depending on `kind`).
 *   3. Dispatches via dispatchScope({ role: 'pm', agent: pm, ... }).
 *   4. Parses the PM's reply for a JSON block listing candidates.
 *   5. Inserts each candidate as a `research_suggestion` row,
 *      pending operator review.
 *
 * Synchronous from the API caller's perspective — returns the new
 * suggestion rows once the PM responds. Wait time tracks PM's
 * reply latency (typically 30–90 seconds).
 */

import { queryAll } from '@/lib/db';
import { dispatchScope } from '@/lib/agents/dispatch-scope';
import { getPmAgent } from '@/lib/agents/pm-resolver';
import { listTopics } from '@/lib/db/topics';
import { listBriefs } from '@/lib/db/briefs';
import { listInitiatives } from '@/lib/db/initiatives';
import {
  createSuggestion,
  dismissPendingForWorkspaceKind,
  type ResearchSuggestion,
  type SuggestionKind,
  type TopicSuggestionPayload,
  type BriefSuggestionPayload,
} from '@/lib/db/research-suggestions';
import { extractReplyText } from '@/lib/research/run-brief';
import type { ChatEvent } from '@/lib/openclaw/send-chat';

const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_SUGGESTIONS_PER_RUN = 6;

export interface SuggestOptions {
  workspace_id: string;
  /** Either 'topic' or 'brief'. recurring_brief is reserved (phase 2). */
  kind: 'topic' | 'brief';
  timeoutMs?: number;
}

export interface SuggestResult {
  state: 'ok' | 'rejected' | 'failed';
  reason?: string;
  suggestions: ResearchSuggestion[];
  /** Raw PM reply, useful for debugging when parsing fails. */
  raw?: string;
}

interface InitiativeSummary {
  id: string;
  kind: string;
  title: string;
  status: string;
  description?: string | null;
  target_end?: string | null;
}

interface TaskSummary {
  id: string;
  title: string;
  status: string;
  initiative_id: string | null;
  priority: string;
}

interface BriefSummary {
  id: string;
  title: string;
  topic_name: string | null;
  template: string;
  created_at: string;
}

interface TopicSummary {
  id: string;
  name: string;
  description: string;
}

interface WorkspaceContext {
  initiatives: InitiativeSummary[];
  blocked_or_at_risk_tasks: TaskSummary[];
  needs_input_tasks: TaskSummary[];
  recent_briefs: BriefSummary[];
  topics: TopicSummary[];
}

/** Cap how much we feed the PM. Beyond a few dozen rows the prompt
 *  bloats and the PM's signal-to-noise drops. Tune on real usage. */
const MAX_INITIATIVES = 30;
const MAX_TASKS_PER_BUCKET = 15;
const MAX_BRIEFS = 20;
const MAX_TOPICS = 30;

export function gatherWorkspaceContext(workspaceId: string): WorkspaceContext {
  const initiatives = listInitiatives({ workspace_id: workspaceId })
    .slice(0, MAX_INITIATIVES)
    .map(i => ({
      id: i.id,
      kind: i.kind,
      title: i.title,
      status: i.status,
      description: i.description ?? null,
      target_end: i.target_end ?? null,
    }));

  // Tasks: focus on the buckets a PM cares about for "what's stuck?"
  // and "what's blocked on a decision?".
  const blockedOrAtRisk = queryAll<TaskSummary>(
    `SELECT id, title, status, initiative_id, priority FROM tasks
       WHERE workspace_id = ? AND status IN ('assigned','in_progress','testing','review','verification')
         AND COALESCE(is_archived, 0) = 0
       ORDER BY updated_at DESC LIMIT ?`,
    [workspaceId, MAX_TASKS_PER_BUCKET],
  );
  const needsInput = queryAll<TaskSummary>(
    `SELECT id, title, status, initiative_id, priority FROM tasks
       WHERE workspace_id = ? AND status = 'needs_user_input'
         AND COALESCE(is_archived, 0) = 0
       ORDER BY updated_at DESC LIMIT ?`,
    [workspaceId, MAX_TASKS_PER_BUCKET],
  );

  const briefs = listBriefs(workspaceId, { limit: MAX_BRIEFS });
  const topics = listTopics(workspaceId).slice(0, MAX_TOPICS);
  const topicById = new Map(topics.map(t => [t.id, t]));

  const recent_briefs: BriefSummary[] = briefs.map(b => ({
    id: b.id,
    title: b.title,
    topic_name: b.topic_id ? topicById.get(b.topic_id)?.name ?? null : null,
    template: b.template,
    created_at: b.created_at,
  }));

  return {
    initiatives,
    blocked_or_at_risk_tasks: blockedOrAtRisk,
    needs_input_tasks: needsInput,
    recent_briefs,
    topics: topics.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
    })),
  };
}

export function buildSuggestPrompt(
  kind: 'topic' | 'brief',
  ctx: WorkspaceContext,
): string {
  const sections: string[] = [];
  sections.push(
    `# Research suggestion request`,
    `\nYou are being asked to survey the workspace's current state and propose ` +
    `up to ${MAX_SUGGESTIONS_PER_RUN} candidate **research ${kind === 'topic' ? 'topics' : 'briefs'}** ` +
    `that would meaningfully reduce uncertainty or unlock a decision the team is sitting on.\n` +
    `\n**This is NOT a Mission Control task.** Do NOT call \`register_deliverable\` / ` +
    `\`update_task_status\` / \`log_activity\` / \`propose_changes\`. Reply with the ` +
    `JSON block specified at the bottom of this prompt and nothing else after it.`,
  );

  sections.push(
    `## What's a good ${kind}?`,
    kind === 'topic'
      ? `A topic is a **long-lived area of interest** — something worth tracking ` +
        `over weeks or months because the workspace will care about its evolution. ` +
        `Examples: "FDA enforcement on GLP-1", "Acme competitor watch", ` +
        `"DE/CA filing obligations". Avoid: one-off questions (those are briefs).`
      : `A brief is a **single research output** — a specific question whose ` +
        `answer would change a decision or reduce risk. Examples: "Survey VLMs ` +
        `that fit on 8GB Jetson", "Compare Postgres vector ext vs pinecone for ` +
        `our RAG load". Avoid: vague areas (those are topics).`,
  );

  sections.push(
    `## Workspace context\n`,
    `### Initiatives (${ctx.initiatives.length})`,
    ctx.initiatives.length === 0
      ? '_(none)_'
      : ctx.initiatives
          .map(i => `- **${i.kind}** \`${i.status}\` — ${i.title}` +
                    (i.description ? `\n  ${i.description.slice(0, 200)}` : ''))
          .join('\n'),
  );

  if (ctx.blocked_or_at_risk_tasks.length || ctx.needs_input_tasks.length) {
    sections.push(`### Tasks needing attention`);
    if (ctx.needs_input_tasks.length) {
      sections.push(
        `**Awaiting operator input:**\n` +
        ctx.needs_input_tasks.map(t => `- ${t.title}`).join('\n'),
      );
    }
    if (ctx.blocked_or_at_risk_tasks.length) {
      sections.push(
        `**In flight:**\n` +
        ctx.blocked_or_at_risk_tasks.map(t => `- \`${t.status}\` — ${t.title}`).join('\n'),
      );
    }
  }

  sections.push(
    `### Existing topics (${ctx.topics.length})`,
    ctx.topics.length === 0
      ? '_(none — you may suggest foundational ones)_'
      : ctx.topics.map(t => `- **${t.name}** — ${t.description.slice(0, 200) || '(no description)'}`).join('\n'),
  );

  sections.push(
    `### Recent briefs (${ctx.recent_briefs.length})`,
    ctx.recent_briefs.length === 0
      ? '_(none)_'
      : ctx.recent_briefs
          .map(b => `- "${b.title}"${b.topic_name ? ` (topic: ${b.topic_name})` : ''}`)
          .join('\n'),
  );

  sections.push(
    `## Reply format`,
    `\nReply with a single fenced JSON code block (\`\`\`json … \`\`\`) and nothing else after it. ` +
    `Shape:\n` +
    (kind === 'topic'
      ? `\n\`\`\`json
{
  "suggestions": [
    {
      "name": "Short topic name (≤ 80 chars)",
      "description": "Why this topic matters; what we'd track over time (1–3 sentences).",
      "tags": ["short", "tags"],
      "rationale": "1 sentence: WHY you suggested this, referencing specific initiatives/tasks/gaps you saw."
    }
  ]
}
\`\`\`\n`
      : `\n\`\`\`json
{
  "suggestions": [
    {
      "title": "Short brief title (≤ 100 chars)",
      "prompt": "Specific research question. Be precise about scope, depth, and what would make the answer useful.",
      "topic_id": null,
      "rationale": "1 sentence: WHY you suggested this, referencing specific initiatives/tasks/gaps you saw."
    }
  ]
}
\`\`\`\n` +
        `If a brief naturally belongs to one of the existing topics above, set \`topic_id\` to that topic's id; otherwise leave null.\n`),
    `\nReturn between 1 and ${MAX_SUGGESTIONS_PER_RUN} candidates. Quality over quantity — fewer good ` +
    `suggestions beat many shallow ones. Skip anything that duplicates an existing topic or recent brief.`,
  );

  return sections.join('\n\n');
}

interface RawTopicSuggestion {
  name?: unknown;
  description?: unknown;
  tags?: unknown;
  rationale?: unknown;
}
interface RawBriefSuggestion {
  title?: unknown;
  prompt?: unknown;
  topic_id?: unknown;
  rationale?: unknown;
}
interface RawResponse {
  suggestions?: Array<RawTopicSuggestion | RawBriefSuggestion>;
}

interface ParsedCandidate {
  payload: TopicSuggestionPayload | BriefSuggestionPayload;
  rationale: string | null;
}

/**
 * Best-effort JSON extraction from a reply that may include prose
 * around the fenced code block. Tries fenced ```json blocks first,
 * then a bare top-level object.
 */
export function parseSuggestionsResponse(
  raw: string,
  kind: 'topic' | 'brief',
  validTopicIds: Set<string>,
): ParsedCandidate[] {
  if (!raw) return [];

  const fenced = /```json\s*([\s\S]*?)\s*```/i.exec(raw);
  const candidate = fenced ? fenced[1] : raw;

  let obj: RawResponse;
  try {
    obj = JSON.parse(candidate) as RawResponse;
  } catch {
    // Try a bare-object pass: find the first '{' to last '}' span.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return [];
    try {
      obj = JSON.parse(candidate.slice(start, end + 1)) as RawResponse;
    } catch {
      return [];
    }
  }

  if (!obj || !Array.isArray(obj.suggestions)) return [];

  const out: ParsedCandidate[] = [];
  for (const s of obj.suggestions.slice(0, MAX_SUGGESTIONS_PER_RUN)) {
    if (kind === 'topic') {
      const t = s as RawTopicSuggestion;
      if (typeof t.name !== 'string' || !t.name.trim()) continue;
      out.push({
        payload: {
          name: t.name.trim().slice(0, 500),
          description: typeof t.description === 'string' ? t.description.trim() : '',
          tags: Array.isArray(t.tags)
            ? t.tags.filter((x): x is string => typeof x === 'string').slice(0, 16)
            : [],
        },
        rationale: typeof t.rationale === 'string' ? t.rationale.trim() : null,
      });
    } else {
      const b = s as RawBriefSuggestion;
      if (typeof b.title !== 'string' || !b.title.trim()) continue;
      if (typeof b.prompt !== 'string' || !b.prompt.trim()) continue;
      const topicId =
        typeof b.topic_id === 'string' && validTopicIds.has(b.topic_id) ? b.topic_id : null;
      out.push({
        payload: {
          title: b.title.trim().slice(0, 500),
          prompt: b.prompt.trim(),
          topic_id: topicId,
          template: 'general_brief',
        },
        rationale: typeof b.rationale === 'string' ? b.rationale.trim() : null,
      });
    }
  }
  return out;
}

/** Public entry point used by the API route. */
export async function generateSuggestions(opts: SuggestOptions): Promise<SuggestResult> {
  const pm = getPmAgent(opts.workspace_id);
  if (!pm) {
    return {
      state: 'rejected',
      reason: 'No PM agent in this workspace. The PM is the gateway-bound master agent — provision it via the openclaw catalog.',
      suggestions: [],
    };
  }

  const ctx = gatherWorkspaceContext(opts.workspace_id);
  const triggerBody = buildSuggestPrompt(opts.kind, ctx);
  const validTopicIds = new Set(ctx.topics.map(t => t.id));

  let result;
  try {
    result = await dispatchScope({
      workspace_id: opts.workspace_id,
      role: 'pm',
      agent: pm,
      session_suffix: `research-suggest-${opts.kind}-${Date.now()}`,
      trigger_body: triggerBody,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      attempt_strategy: 'fresh',
    });
  } catch (err) {
    return {
      state: 'failed',
      reason: err instanceof Error ? err.message : String(err),
      suggestions: [],
    };
  }

  const reply = result.reply;
  if (!reply || !reply.sent) {
    return {
      state: 'failed',
      reason: reply?.reason === 'no_session'
        ? 'Openclaw gateway not connected; cannot reach PM.'
        : reply?.reason === 'send_failed'
          ? `chat.send failed: ${reply.error?.message ?? 'unknown error'}`
          : `dispatch failed: ${reply?.reason ?? 'unknown'}`,
      suggestions: [],
    };
  }
  if (reply.timedOut) {
    return {
      state: 'failed',
      reason: `PM did not respond within ${(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`,
      suggestions: [],
    };
  }

  const body = extractReplyText(reply.reply ?? [], reply.doneEvent);
  const candidates = parseSuggestionsResponse(body, opts.kind, validTopicIds);

  if (candidates.length === 0) {
    return {
      state: 'failed',
      reason: 'PM reply did not contain a parseable JSON block of suggestions.',
      raw: body,
      suggestions: [],
    };
  }

  // Dismiss any prior pending suggestions of this kind so the picker
  // shows only the latest batch.
  dismissPendingForWorkspaceKind(opts.workspace_id, opts.kind);

  const inserted = candidates.map(c =>
    createSuggestion({
      workspace_id: opts.workspace_id,
      kind: opts.kind as SuggestionKind,
      payload: c.payload,
      rationale: c.rationale,
    }),
  );

  return { state: 'ok', suggestions: inserted, raw: body };
}
