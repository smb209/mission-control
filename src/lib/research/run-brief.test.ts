/**
 * Brief orchestrator tests (phase 2 — runner-dispatched via dispatchScope).
 *
 * Stubs the openclaw send-chat client via __setSendChatClientForTests
 * so we can drive the dispatch path deterministically without a live
 * gateway. dispatchScope uses sendChatAndAwaitReply under the hood,
 * so the same stub continues to work — but two new failure modes
 * appear because resolution now spans both a researcher roster entry
 * AND a runner agent:
 *   - missing researcher → failed with "add a researcher" message
 *   - missing runner     → failed with "no runner registered" message
 *
 * Covers:
 *   - happy path: queued → running (event) → complete (event) +
 *     result_md + parsed citations + scope_key in completion event
 *   - missing researcher → failed with no_researcher_in_roster reason
 *   - missing runner → failed with no_runner reason
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

/**
 * Adds a role-only "researcher" roster entry (no gateway binding).
 * The actual chat session will be hosted by the runner; this row
 * just signals "this workspace has opted in to research."
 */
function ensureResearcherRosterEntry(workspaceId: string): string {
  const id = `agent-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, source, is_active, created_at, updated_at)
     VALUES (?, ?, 'researcher', '🔍', 'standby', 0, ?, 'local', 1, datetime('now'), datetime('now'))`,
    [id, `mc-researcher-${workspaceId.slice(-4)}`, workspaceId],
  );
  return id;
}

/**
 * Adds the runner agent. getRunnerAgent() resolves by gateway_agent_id
 * in ('mc-runner-dev', 'mc-runner'); we use the dev variant since
 * NODE_ENV=test selects dev candidates first. The session_key_prefix
 * is the same shape dispatchScope expects.
 */
function ensureRunner(): string {
  // Idempotent: only insert if no row already.
  const existing = run(
    `INSERT OR IGNORE INTO agents
       (id, name, role, avatar_emoji, status, is_master, workspace_id, source, gateway_agent_id, session_key_prefix, model, is_active, created_at, updated_at)
       VALUES ('runner-test', 'MC Runner Dev', 'runner', '⚙️', 'standby', 0, 'default', 'gateway', 'mc-runner-dev', 'agent:mc-runner-dev:main', 'spark-lb/agent', 1, datetime('now'), datetime('now'))`,
  );
  void existing;
  // Make sure the 'default' workspace exists for the runner FK.
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES ('default', 'default', 'default', datetime('now'))`,
  );
  return 'runner-test';
}

interface StubOpts {
  connected?: boolean;
  sendResult?: unknown;
  sendError?: Error | null;
  events?: ChatEvent[];
  body?: string;
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
        const sessionKey = (params as { sessionKey?: string } | undefined)?.sessionKey;
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

test('parseCitations: prefers explicit Sources section over inline links', () => {
  const md = `Some prose with [inline](https://inline.example).

## Sources

- [Title A](https://a.example) — Background on the topic.
- [Title B](https://b.example) — Confirmed the v3 release date.
`;
  const cites = parseCitations(md);
  assert.equal(cites.length, 3);
  // Sources-section entries land first (the section is parsed before
  // the inline sweep runs).
  assert.equal(cites[0].url, 'https://a.example');
  assert.equal(cites[0].title, 'Title A');
  assert.equal(cites[0].snippet, 'Background on the topic.');
  assert.equal(cites[1].url, 'https://b.example');
  assert.equal(cites[1].snippet, 'Confirmed the v3 release date.');
  // Inline-only URLs still get captured.
  assert.equal(cites[2].url, 'https://inline.example');
  assert.equal(cites[2].snippet, undefined);
});

test('parseCitations: section entry overrides inline title for same URL', () => {
  const md = `Cited [Vague label](https://a.example) inline.

## Sources
- [Better title](https://a.example) — Authoritative reference.`;
  const cites = parseCitations(md);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].title, 'Better title');
  assert.equal(cites[0].snippet, 'Authoritative reference.');
});

test('parseCitations: accepts ## References as the section heading too', () => {
  const md = `# Brief\nbody\n\n## References\n- [X](https://x.example) — note`;
  const cites = parseCitations(md);
  assert.equal(cites.length, 1);
  assert.equal(cites[0].url, 'https://x.example');
});

test('parseCitations: section without notes still parses', () => {
  const md = `## Sources\n- [X](https://x.example)\n- [Y](https://y.example)`;
  const cites = parseCitations(md);
  assert.equal(cites.length, 2);
  assert.equal(cites[0].snippet, undefined);
  assert.equal(cites[1].snippet, undefined);
});

test('parseCitations: backward-compatible — inline-only briefs still work', () => {
  const md = `Findings cite [MDN](https://developer.mozilla.org/x) and [Caniuse](https://caniuse.com/x).`;
  const cites = parseCitations(md);
  assert.equal(cites.length, 2);
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

test('buildBriefPrompt: includes the brief-mode override (no register_deliverable / update_task_status)', () => {
  // Pinning the contract: the researcher persona's AGENTS.md tells the
  // agent to call register_deliverable + update_task_status as its
  // closing sequence. Briefs aren't tasks, so those calls fail. The
  // assembled prompt MUST include an explicit override telling the
  // agent to deliver via reply text instead. Drift in this string
  // re-introduces the old "couldn't find that task" failure mode.
  const prompt = buildBriefPrompt({
    template: 'general_brief',
    title: 't',
    prompt: 'p',
    topicContext: null,
  });
  assert.match(prompt, /NOT a Mission Control task/i);
  assert.match(prompt, /register_deliverable/);
  assert.match(prompt, /update_task_status/);
  assert.match(prompt, /replying with the brief body/i);
});

// ─── orchestrator: happy path ───────────────────────────────────────

test('runBrief: happy path → running → complete with parsed citations', async () => {
  const ws = freshWorkspace();
  ensureResearcherRosterEntry(ws);
  ensureRunner();
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

test('runBrief: missing researcher roster entry → failed with no_researcher_in_roster', async () => {
  const ws = freshWorkspace();
  ensureRunner();
  // No ensureResearcherRosterEntry() call — workspace has no researcher.
  const { brief, agent_run } = createBriefWithRun({
    workspace_id: ws, template: 'general_brief',
    title: 'x', prompt: 'p',
  });

  await runBrief(brief.id, { awaitCompletionForTesting: true });

  const runRow = getAgentRun(agent_run.id);
  assert.equal(runRow?.status, 'failed');
  assert.match(runRow?.error_md ?? '', /no researcher in its roster/i);
  assert.match(runRow?.error_md ?? '', /Add agents/);

  const reloaded = getBrief(brief.id);
  assert.match(reloaded?.error_md ?? '', /no researcher in its roster/i);
});

test('runBrief: missing runner → failed with no_runner', async () => {
  // Wipe any runner that earlier tests inserted.
  run(`DELETE FROM agents WHERE gateway_agent_id IN ('mc-runner-dev', 'mc-runner')`);
  const ws = freshWorkspace();
  ensureResearcherRosterEntry(ws);
  // No ensureRunner() — workspace has researcher but no runner.
  const { brief, agent_run } = createBriefWithRun({
    workspace_id: ws, template: 'general_brief',
    title: 'x', prompt: 'p',
  });

  await runBrief(brief.id, { awaitCompletionForTesting: true });

  const runRow = getAgentRun(agent_run.id);
  assert.equal(runRow?.status, 'failed');
  assert.match(runRow?.error_md ?? '', /No runner agent registered/);
});

test('runBrief: gateway not connected → failed with gateway message', async () => {
  const ws = freshWorkspace();
  ensureResearcherRosterEntry(ws);
  ensureRunner();
  const { brief, agent_run } = createBriefWithRun({
    workspace_id: ws, template: 'general_brief',
    title: 'x', prompt: 'p',
  });

  __setSendChatClientForTests(makeStubClient({ connected: false }));

  // Use small retry delay so the test doesn't wait the production
  // 5 × 1500ms backoff window.
  await runBrief(brief.id, {
    awaitCompletionForTesting: true,
    noSessionRetryDelayMs: 1,
    noSessionMaxRetries: 2,
  });

  const runRow = getAgentRun(agent_run.id);
  assert.equal(runRow?.status, 'failed');
  assert.match(runRow?.error_md ?? '', /gateway is not connected/i);
});

test('runBrief: retries on no_session and succeeds when gateway recovers', async () => {
  const ws = freshWorkspace();
  ensureResearcherRosterEntry(ws);
  ensureRunner();
  const { brief, agent_run } = createBriefWithRun({
    workspace_id: ws, template: 'general_brief',
    title: 'recovers', prompt: 'p',
  });

  // Stub that returns isConnected=false for the first 2 attempts then
  // flips to true for the 3rd. The orchestrator should retry, then
  // succeed.
  let connectChecks = 0;
  const listeners = new Set<(p: ChatEvent) => void>();
  __setSendChatClientForTests({
    isConnected: () => {
      connectChecks++;
      return connectChecks > 2;
    },
    on: (event, listener) => { if (event === 'chat_event') listeners.add(listener); return undefined; },
    off: (event, listener) => { if (event === 'chat_event') listeners.delete(listener); return undefined; },
    call: async (method, params) => {
      if (method !== 'chat.send') return undefined;
      const sessionKey = (params as { sessionKey?: string } | undefined)?.sessionKey;
      setImmediate(() => {
        for (const listener of listeners) listener({ sessionKey, state: 'final', message: 'reply after retry' });
      });
      return {};
    },
  });

  await runBrief(brief.id, {
    awaitCompletionForTesting: true,
    noSessionRetryDelayMs: 1,
    noSessionMaxRetries: 5,
  });

  const runRow = getAgentRun(agent_run.id);
  assert.equal(runRow?.status, 'complete', `expected complete, got ${runRow?.status} (error: ${runRow?.error_md})`);
});

test('runBrief: chat.send throws → failed', async () => {
  const ws = freshWorkspace();
  ensureResearcherRosterEntry(ws);
  ensureRunner();
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
  ensureResearcherRosterEntry(ws);
  ensureRunner();
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
  ensureResearcherRosterEntry(ws);
  ensureRunner();
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
  ensureResearcherRosterEntry(ws);
  ensureRunner();
  const { brief, agent_run } = createBriefWithRun({
    workspace_id: ws, template: 'general_brief',
    title: 'x', prompt: 'p',
  });
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
  ensureResearcherRosterEntry(ws);
  ensureRunner();
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

  // dispatchScope packages the trigger_body into the briefing along
  // with the role persona; the chat.send message is the full briefing
  // (which includes our trigger_body — the assembled brief prompt).
  await runBrief(brief.id, { timeoutMs: 30, awaitCompletionForTesting: true });

  assert.match(capturedMessage, /Acme competitor/);
  assert.match(capturedMessage, /Track their product changes monthly\./);
  assert.match(capturedMessage, /What changed\?/);

  // The brief should be marked failed (no reply was returned) but the
  // prompt assembly assertion is the one that matters here.
  const runRow = getAgentRun(agent_run.id);
  assert.equal(runRow?.status, 'failed');
});
