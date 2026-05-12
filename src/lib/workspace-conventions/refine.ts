/**
 * Workspace conventions — agent-driven refine flow.
 *
 * Hands the operator's current conventions text to a writer/coder
 * agent in a fresh session. The agent reviews and replies with either
 * a structured `replacement` (full markdown swap) or a list of
 * clarifying `questions`. The operator reviews + accepts in the UI.
 *
 * Spec: docs/reference/workspace-conventions-structured.md §6.
 *
 * v1 keeps the dispatch synchronous (operator sees a spinner, then
 * a result). The refine doesn't write to mc_sessions / agent_runs —
 * it's a transient one-shot, not a tracked job. If we add a tracked
 * variant later (e.g. so refines show in /jobs) we'll route through
 * `dispatchScope` with a new scope_type and a matching CHECK migration.
 */

import { sendChatAndAwaitReply } from '@/lib/openclaw/send-chat';
import { getRunnerAgent } from '@/lib/agents/runner';
import { KNOWN_VARIABLES } from './resolve-variables';

export interface RefineInput {
  workspace: {
    id: string;
    name: string;
    workspace_path: string | null;
    repo_url: string | null;
    default_base_branch: string | null;
  };
  current_conventions: string;
  operator_note: string | null;
}

export interface RefineProposal {
  /** 'replacement' = full markdown swap; 'questions' = clarifying turn. */
  kind: 'replacement' | 'questions';
  /** Replacement markdown (when kind='replacement'). */
  body?: string;
  /** Clarifying questions (when kind='questions'); ≤ 5 entries. */
  questions?: string[];
  /** Brief explanation the agent surfaces alongside its proposal. */
  rationale?: string;
}

export class RefineDispatchError extends Error {
  constructor(public reason: 'no_runner' | 'no_session' | 'timeout' | 'parse_failed' | 'send_failed', message: string) {
    super(message);
    this.name = 'RefineDispatchError';
  }
}

const SYSTEM_PROMPT = `You are reviewing a workspace's conventions document for a software / project-management platform.

The conventions are markdown that gets prepended to every dispatched agent's prompt. Your job is to either:
  - Propose a fully-rewritten replacement that's clearer, more complete, or better-structured;
  - OR ask up to 5 clarifying questions if the existing text is ambiguous or missing essential facts.

Use \`{{token}}\` placeholders where appropriate so the variable resolver expands them at dispatch time. Available tokens: ${KNOWN_VARIABLES.map((v) => `{{${v}}}`).join(', ')}.

Reply with a SINGLE JSON object, no preamble or trailing prose:
  { "kind": "replacement", "body": "<full markdown>", "rationale": "<one paragraph why>" }
or
  { "kind": "questions", "questions": ["q1", "q2", ...], "rationale": "<one paragraph why>" }

Do NOT wrap the JSON in code fences. Do NOT add commentary outside the JSON.`;

export function buildRefineTrigger(input: RefineInput): string {
  const lines: string[] = [];
  lines.push(SYSTEM_PROMPT);
  lines.push('');
  lines.push('## Workspace facts');
  lines.push(`- Name: ${input.workspace.name}`);
  lines.push(`- Working tree: ${input.workspace.workspace_path ?? '(not set)'}`);
  lines.push(`- Repo URL: ${input.workspace.repo_url ?? '(not set)'}`);
  lines.push(`- Default base branch: ${input.workspace.default_base_branch ?? '(not set)'}`);
  lines.push('');
  if (input.operator_note && input.operator_note.trim()) {
    lines.push('## Operator note');
    lines.push(input.operator_note.trim());
    lines.push('');
  }
  lines.push('## Current conventions (markdown)');
  lines.push('```md');
  lines.push(input.current_conventions || '(empty)');
  lines.push('```');
  return lines.join('\n');
}

/**
 * Extract the chat content from the agent's final reply.
 * Mirrors `extractAgentReplyText` in pm-dispatch.ts — agents send their
 * payload as either a plain string, `{content: string}`, or
 * `{content: [{text}]}` depending on provider. The doneEvent's message
 * carries the final answer; intermediate events may carry chunks.
 */
function flattenReply(
  result: Awaited<ReturnType<typeof sendChatAndAwaitReply>>,
): string {
  const readMessage = (m: unknown): string => {
    if (!m) return '';
    if (typeof m === 'string') return m;
    if (typeof m === 'object' && 'content' in m) {
      const c = (m as { content: unknown }).content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        return c
          .map((part) =>
            typeof part === 'string'
              ? part
              : typeof part === 'object' && part && 'text' in part && typeof (part as { text: unknown }).text === 'string'
                ? (part as { text: string }).text
                : '',
          )
          .filter(Boolean)
          .join('');
      }
    }
    return '';
  };
  const fromDone = readMessage(result.doneEvent?.message).trim();
  if (fromDone) return fromDone;
  return (result.reply ?? []).map((e) => readMessage(e.message)).join('').trim();
}

/**
 * Pull the first JSON object out of a string, tolerating leading /
 * trailing prose or accidental code fences. We keep parse strict: the
 * agent's reply is rejected if it doesn't yield a JSON object with a
 * recognized `kind`.
 */
export function parseRefineReply(raw: string): RefineProposal {
  const trimmed = raw.trim();
  // Strip ```json / ``` fences if the agent ignored the "no fences" rule.
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  // Find the first { ... } block — agents sometimes prepend a sentence.
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new RefineDispatchError('parse_failed', `agent reply lacked a JSON object: ${candidate.slice(0, 200)}`);
  }
  const jsonSlice = candidate.slice(firstBrace, lastBrace + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (err) {
    throw new RefineDispatchError(
      'parse_failed',
      `agent reply JSON didn't parse: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new RefineDispatchError('parse_failed', 'agent reply was not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.kind === 'replacement') {
    if (typeof obj.body !== 'string' || !obj.body.trim()) {
      throw new RefineDispatchError('parse_failed', 'replacement reply missing body');
    }
    return {
      kind: 'replacement',
      body: obj.body,
      rationale: typeof obj.rationale === 'string' ? obj.rationale : undefined,
    };
  }
  if (obj.kind === 'questions') {
    if (!Array.isArray(obj.questions) || obj.questions.length === 0) {
      throw new RefineDispatchError('parse_failed', 'questions reply missing questions[]');
    }
    const questions = obj.questions
      .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
      .slice(0, 5);
    if (questions.length === 0) {
      throw new RefineDispatchError('parse_failed', 'questions reply had no usable strings');
    }
    return {
      kind: 'questions',
      questions,
      rationale: typeof obj.rationale === 'string' ? obj.rationale : undefined,
    };
  }
  throw new RefineDispatchError(
    'parse_failed',
    `unrecognized kind: ${JSON.stringify(obj.kind)}`,
  );
}

/**
 * Run the refine round-trip. Throws RefineDispatchError on dispatch /
 * timeout / parse failures so the route can map to the right HTTP code.
 */
export async function refineConventions(input: RefineInput): Promise<RefineProposal> {
  const runner = getRunnerAgent();
  if (!runner) {
    throw new RefineDispatchError(
      'no_runner',
      'No runner agent registered (mc-runner / mc-runner-dev).',
    );
  }
  const triggerBody = buildRefineTrigger(input);
  const sessionSuffix = `conventions-refine-${input.workspace.id}-${Date.now()}`;
  const result = await sendChatAndAwaitReply({
    agent: runner,
    sessionSuffix,
    message: triggerBody,
    timeoutMs: 90_000,
  });

  if (!result.sent) {
    if (result.reason === 'no_session') {
      throw new RefineDispatchError(
        'no_session',
        'OpenClaw gateway is not connected; try again when it comes back.',
      );
    }
    throw new RefineDispatchError(
      'send_failed',
      `gateway dispatch failed (${result.reason ?? 'unknown'}): ${result.error?.message ?? ''}`,
    );
  }
  if (result.timedOut) {
    throw new RefineDispatchError(
      'timeout',
      'Agent did not respond within 90s. Try again or simplify your operator note.',
    );
  }
  const replyText = flattenReply(result);
  if (!replyText) {
    throw new RefineDispatchError('parse_failed', 'agent reply was empty');
  }
  return parseRefineReply(replyText);
}
