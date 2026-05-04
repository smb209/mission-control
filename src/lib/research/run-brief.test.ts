/**
 * Brief orchestrator tests.
 *
 * Stubs the openclaw send-chat client via __setSendChatClientForTests
 * so we can drive the dispatch path deterministically without a live
 * gateway. Covers:
 *   - happy path: queued → running (event) → complete (event) +
 *     result_md + parsed citations
 *   - missing researcher → failed cleanly
 *   - send-chat returns no_session → failed with gateway-clear message
 *   - send-chat returns send_failed → failed
 *   - timeout → failed with timeout reason
 *   - empty reply → failed with explicit message
 *   - prompt assembly threads topic context when present
 *   - parseCitations + extractReplyText pure helpers
 *   - runBrief refuses to redispatch a non-queued brief
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import { createBriefWithRun, getBrief } from '@/lib/db/briefs';
import { createTopic } from '@/lib/db/topics';
import { getAgentRun, markRunning } from '@/lib/db/agent-runs';
import {
  __setSendChatClientForTests,
  type ChatEvent,
  type SendChatClient,
} from '@/lib/openclaw/send-chat';
import {
  buildBriefPrompt,
  extractReplyText,
  parseCitations,
  runBrief,
} from './run-brief';

function freshWorkspace(): string {
  const id = `ws-rb-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function ensureResearcher(workspaceId: string): string {
  const id = `agent-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, source, gateway_agent_id, session_key_prefix, model, created_at, updated_at)
     VALUES (?, ?, 'researcher', '🔍', 'standby', 0, ?, 'gateway', 'gw-researcher', 'agent:gw-researcher', 'spark-lb/agent', datetime('now'), datetime('now'))`,
    [id, `mc-researcher-${workspaceId.slice(-4)}`, workspaceId],
  );
  return id;
}

interface StubOpts {
  /** Whether the gateway is "connected." Default true. */
  connected?: boolean;
  /** What the underlying chat.send call resolves with. Default {}. */
  sendResult?: unknown;
  /** Throw inside chat.send. Default null. */
  sendError?: Error | null;
  /** Events to emit AFTER chat.send resolves, in order. The default
   *  emits a single final-state event with the supplied body. */
  events?: ChatEvent[];
  /** Body to wrap in the default final-state event. */
  body?: string;
  /** Skip emitting any events (forces sendChatAndAwaitReply to time
   *  out at its caller-supplied deadline). */
  silent?: boolean;
}

function makeStubClient(opts: StubOpts = {}): SendChatClient {
  const listeners = new Set<(p: ChatEvent) => void>();
  const emitAfterSend: ChatEvent[] = opts.events ?? [
    { state: 'final', message: opts.body ?? 'final body' },
  ];
  return {
    isConnected: () => opts.connected ?? true,
    on: (event, listener) => {
      if (event === 'chat_event') listeners.add(listener);
      return undefined;
    },
    off: (event, listener) => {
      if (event === 'chat_event') listeners.delete(listener);
      return undefined;
    },
    call: async (method, params) => {
      if (method !== 'chat.send') return undefined;
      if (opts.sendError) throw opts.sendError;
      if (!opts.silent) {
        // Emit events AFTER the send call resolves, attached to the
        // requested sessionKey so the listener accepts them.
        const sessionKey = (params as { sessionKey?: string } | undefined)?.sessionKey;
        // setImmediate so the await in the orchestrator picks them up
        // after we've returned from the call.
        setImmediate(() => {
          for (const e of emitAfterSend) {
            const withKey = { ...e, sessionKey };
            for (const listener of listeners) listener(withKey);
          }
        });
      }
      return opts.sendResult ?? {};
    },
  };
}

test.afterEach(() => {
  __setSendChatClientForTests(null);
});

// ─── pure helpers ───────────────────────────────────────────────────

test('parseCitations: extracts unique http/https links from markdown', () => {
  const md = `Some text [example](https://example.com) and more [other](https://other.com). And a dup [example](https://example.com).`;
  const cites = parseCitations(md);
  assert.equal(cites.length, 2);
  assert.equal(cites[0].url, 'https://example.com');
  assert.equal(cites[0].title, 'example');
  assert.equal(cites[1].url, 'https://other.com');
});

test('parseCitations: skips relative + non-http schemes', () => {
  const md = `[rel](/about) [mail](mailto:a@b.c) [ftp](ftp://x.y) [ok](https://ok.example)`;
  const cites = parseCitations(md);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].url, 'https://ok.example');
});

test('parseCitations: handles empty / null input', () => {
  assert.deepEqual(parseCitations(''), []);
});

test('extractReplyText: prefers done event body when present', () => {
  const text = extractReplyText(
    [{ message: 'partial' }],
    { state: 'final', message: 'whole reply' },
  );
  assert.equal(text, 'whole reply');
});

test('extractReplyText: falls back to concatenated stream when done body is empty', () => {
  const text = extractReplyText(
    [{ message: 'a' }, { message: 'b' }, { message: 'c' }],
    { state: 'final' },
  );
  assert.equal(text, 'abc');
});

test('extractReplyText: handles object-shape messages with content arrays', () => {
  const text = extractReplyText(
    [],
    { state: 'final', message: { role: 'assistant', content: [{ text: 'hello ' }, { text: 'world' }] } },
  );
  assert.equal(text, 'hello world');
});

test('buildBriefPrompt: includes topic context when supplied', () => {
  const prompt = buildBriefPrompt({
    template: 'general_brief',
    title: 'Survey',
    prompt: 'What is X?',
    topicContext: { name: 'Topic-name', description: 'Why this topic matters' },
  });
  assert.match(prompt, /Topic-name/);
  assert.match(prompt, /Why this topic matters/);
  assert.match(prompt, /What is X\?/);
});

test('buildBriefPrompt: omits topic section when not supplied', () => {
  const prompt = buildBriefPrompt({
    template: 'general_brief',
    title: 'Survey',
    prompt: 'plain question',
    topicContext: null,
  });
  assert.doesNotMatch(prompt, /Topic context/);
});

// ─── orchestrator: happy path ───────────────────────────────────────

test('runBrief: happy path → running → complete with parsed citations', async () => {
  const ws = freshWorkspace();
  ensureResearcher(ws);
  const { brief, agent_run } = createBriefWithRun({
    workspace_id: ws, template: 'general_brief',
    title: 'WebGPU support', prompt: 'Survey WebGPU support.',
  });

  __setSendChatClientForTests(makeStubClient({
    body: '# Summary\n\nFindings cite [MDN](https://developer.mozilla.org/webgpu) and [Caniuse](https://caniuse.com/webgpu).',
  }));

  const result = await runBrief(brief.id, { awaitCompletionForTesting: true });
  assert.equal(result.state, 'started');

  const reloaded = getBrief(brief.id);
  assert.ok(reloaded);
  assert.match(reloaded!.result_md ?? '', /Findings cite/);
  assert.equal(reloaded!.error_md, null);
  assert.equal(reloaded!.citations.length, 2);
  assert.equal(reloaded!.citations[0].url, 'https://developer.mozilla.org/webgpu');

  const runRow = getAgentRun(agent_run.id);
  assert.equal(runRow?.status, 'complete');
  assert.equal(runRow?.model_used, 'spark-lb/agent');
  assert.ok(runRow?.completed_at);
});

// ─── orchestrator: failure modes ────────────────────────────────────

test('runBrief: missing researcher → failed cleanly', async () => {
  const ws = freshWorkspace();
  // No ensureResearcher() call — workspace has none.
  const { brief, agent_run } = createBriefWithRun({
    workspace_id: ws, template: 'general_brief',
    title: 'x', prompt: 'p',
  });

  await runBrief(brief.id, { awaitCompletionForTesting: true });

  const runRow = getAgentRun(agent_run.id);
  assert.equal(runRow?.status, 'failed');
  assert.match(runRow?.error_md ?? '', /No active researcher/);

  const reloaded = getBrief(brief.id);
  assert.match(reloaded?.error_md ?? '', /No active researcher/);
});

test('runBrief: gateway not connected → failed with gateway message', async () => {
  const ws = freshWorkspace();
  ensureResearcher(ws);
  const { brief, agent_run } = createBriefWithRun({
    workspace_id: ws, template: 'general_brief',
    title: 'x', prompt: 'p',
  });

  __setSendChatClientForTests(makeStubClient({ connected: false }));

  await runBrief(brief.id, { awaitCompletionForTesting: true });

  const runRow = getAgentRun(agent_run.id);
  assert.equal(runRow?.status, 'failed');
  assert.match(runRow?.error_md ?? '', /gateway is not connected/i);
});

test('runBrief: chat.send throws → failed', async () => {
  const ws = freshWorkspace();
  ensureResearcher(ws);
  const { brief, agent_run } = createBriefWithRun({
    workspace_id: ws, template: 'general_brief',
    title: 'x', prompt: 'p',
  });

  __setSendChatClientForTests(makeStubClient({
    sendError: new Error('connection refused'),
  }));

  await runBrief(brief.id, { awaitCompletionForTesting: true });

  const runRow = getAgentRun(agent_run.id);
  assert.equal(runRow?.status, 'failed');
  assert.match(runRow?.error_md ?? '', /chat\.send failed/);
});

test('runBrief: gateway returns no events → fails with timeout message', async () => {
  const ws = freshWorkspace();
  ensureResearcher(ws);
  const { brief, agent_run } = createBriefWithRun({
    workspace_id: ws, template: 'general_brief',
    title: 'x', prompt: 'p',
  });

  __setSendChatClientForTests(makeStubClient({ silent: true }));

  await runBrief(brief.id, {
    timeoutMs: 30,
    awaitCompletionForTesting: true,
  });

  const runRow = getAgentRun(agent_run.id);
  assert.equal(runRow?.status, 'failed');
  assert.match(runRow?.error_md ?? '', /did not return a final reply/i);
});

test('runBrief: empty body → fails with explicit message', async () => {
  const ws = freshWorkspace();
  ensureResearcher(ws);
  const { brief, agent_run } = createBriefWithRun({
    workspace_id: ws, template: 'general_brief',
    title: 'x', prompt: 'p',
  });

  __setSendChatClientForTests(makeStubClient({ body: '   ' }));

  await runBrief(brief.id, { awaitCompletionForTesting: true });

  const runRow = getAgentRun(agent_run.id);
  assert.equal(runRow?.status, 'failed');
  assert.match(runRow?.error_md ?? '', /empty body/);
});

test('runBrief: refuses to redispatch a brief that is already running', async () => {
  const ws = freshWorkspace();
  ensureResearcher(ws);
  const { brief, agent_run } = createBriefWithRun({
    workspace_id: ws, template: 'general_brief',
    title: 'x', prompt: 'p',
  });
  // Force the run into "running" state so a second dispatch must be rejected.
  markRunning(agent_run.id);

  const result = await runBrief(brief.id);
  assert.equal(result.state, 'rejected');
  assert.match(result.reason ?? '', /running/);
});

test('runBrief: returns rejected for unknown brief id', async () => {
  const result = await runBrief('does-not-exist');
  assert.equal(result.state, 'rejected');
  assert.equal(result.reason, 'brief_not_found');
});

test('runBrief: topic context flows into the assembled prompt', async () => {
  const ws = freshWorkspace();
  ensureResearcher(ws);
  const topic = createTopic({
    workspace_id: ws,
    name: 'Acme competitor',
    description: 'Track their product changes monthly.',
  });
  const { brief, agent_run } = createBriefWithRun({
    workspace_id: ws, template: 'general_brief',
    title: 'Q4 update',
    prompt: 'What changed?',
    topic_id: topic.id,
  });

  let capturedMessage = '';
  __setSendChatClientForTests({
    isConnected: () => true,
    on: () => undefined,
    off: () => undefined,
    call: async (method, params) => {
      if (method === 'chat.send') {
        capturedMessage = (params as { message: string }).message;
      }
      return {};
    },
  });

  // We don't care about the orchestrator's failure-on-empty path here;
  // we just want the message that hit chat.send.
  await runBrief(brief.id, { timeoutMs: 30, awaitCompletionForTesting: true });

  assert.match(capturedMessage, /Acme competitor/);
  assert.match(capturedMessage, /Track their product changes monthly\./);
  assert.match(capturedMessage, /What changed\?/);

  // The brief should be marked failed (no reply was returned) but the
  // prompt assembly assertion is the one that matters here.
  const runRow = getAgentRun(agent_run.id);
  assert.equal(runRow?.status, 'failed');
});
