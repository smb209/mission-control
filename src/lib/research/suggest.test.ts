/**
 * Suggestion dispatcher tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import {
  __setSendChatClientForTests,
  type ChatEvent,
  type SendChatClient,
} from '@/lib/openclaw/send-chat';
import { createTopic } from '@/lib/db/topics';
import { listSuggestions } from '@/lib/db/research-suggestions';
import {
  buildSuggestPrompt,
  gatherWorkspaceContext,
  generateSuggestions,
  parseSuggestionsResponse,
} from './suggest';

function freshWorkspace(): string {
  const id = `ws-sg-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function ensurePm(workspaceId: string): void {
  run(
    `INSERT OR IGNORE INTO agents (id, name, role, avatar_emoji, status, is_master, is_pm, workspace_id, source, gateway_agent_id, session_key_prefix, model, is_active, created_at, updated_at)
     VALUES (?, 'mc-pm-test', 'pm', '🧭', 'standby', 1, 1, ?, 'gateway', ?, ?, 'spark-lb/agent', 1, datetime('now'), datetime('now'))`,
    [`pm-${uuidv4().slice(0, 8)}`, workspaceId, `mc-pm-${workspaceId.slice(-4)}`, `agent:mc-pm-${workspaceId.slice(-4)}:main`],
  );
}

function makeStubClient(replyBody: string): SendChatClient {
  const listeners = new Set<(p: ChatEvent) => void>();
  return {
    isConnected: () => true,
    on: (event, listener) => { if (event === 'chat_event') listeners.add(listener); return undefined; },
    off: (event, listener) => { if (event === 'chat_event') listeners.delete(listener); return undefined; },
    call: async (method, params) => {
      if (method !== 'chat.send') return undefined;
      const sessionKey = (params as { sessionKey?: string } | undefined)?.sessionKey;
      setImmediate(() => {
        for (const l of listeners) l({ sessionKey, state: 'final', message: replyBody });
      });
      return {};
    },
  };
}

test.afterEach(() => {
  __setSendChatClientForTests(null);
});

// ─── parseSuggestionsResponse ───────────────────────────────────────

test('parseSuggestionsResponse: extracts fenced json topic block', () => {
  const raw = `Sure! Here are my picks.

\`\`\`json
{
  "suggestions": [
    { "name": "Topic A", "description": "About A", "tags": ["a","b"], "rationale": "Initiative X needs this" },
    { "name": "Topic B", "description": "About B", "tags": [], "rationale": "Recurring gap" }
  ]
}
\`\`\`

Hope that helps.`;
  const out = parseSuggestionsResponse(raw, 'topic', new Set());
  assert.equal(out.length, 2);
  assert.equal((out[0].payload as { name: string }).name, 'Topic A');
  assert.equal(out[0].rationale, 'Initiative X needs this');
});

test('parseSuggestionsResponse: extracts brief block + filters topic_id to known ids', () => {
  const raw = `\`\`\`json
{
  "suggestions": [
    { "title": "B1", "prompt": "p1", "topic_id": "known-id", "rationale": "r1" },
    { "title": "B2", "prompt": "p2", "topic_id": "made-up-id", "rationale": "r2" },
    { "title": "B3", "prompt": "p3", "topic_id": null, "rationale": "r3" }
  ]
}
\`\`\``;
  const out = parseSuggestionsResponse(raw, 'brief', new Set(['known-id']));
  assert.equal(out.length, 3);
  assert.equal((out[0].payload as { topic_id: string | null }).topic_id, 'known-id');
  assert.equal((out[1].payload as { topic_id: string | null }).topic_id, null);
  assert.equal((out[2].payload as { topic_id: string | null }).topic_id, null);
});

test('parseSuggestionsResponse: bare object fallback when fence is missing', () => {
  const raw = `noise before
{ "suggestions": [{ "name": "OK", "description": "", "tags": [], "rationale": "" }] }
trailing prose`;
  const out = parseSuggestionsResponse(raw, 'topic', new Set());
  assert.equal(out.length, 1);
  assert.equal((out[0].payload as { name: string }).name, 'OK');
});

test('parseSuggestionsResponse: drops malformed entries silently', () => {
  const raw = `\`\`\`json
{ "suggestions": [
  { "name": "Good" },
  { "name": "" },
  { "rationale": "missing name" },
  { "name": "Also good", "description": "x" }
] }
\`\`\``;
  const out = parseSuggestionsResponse(raw, 'topic', new Set());
  assert.equal(out.length, 2);
});

test('parseSuggestionsResponse: returns empty when reply has no JSON', () => {
  assert.deepEqual(parseSuggestionsResponse('no json here', 'topic', new Set()), []);
  assert.deepEqual(parseSuggestionsResponse('', 'topic', new Set()), []);
});

// ─── gatherWorkspaceContext ─────────────────────────────────────────

test('gatherWorkspaceContext: empty workspace returns empty buckets', () => {
  const ws = freshWorkspace();
  const ctx = gatherWorkspaceContext(ws);
  assert.equal(ctx.initiatives.length, 0);
  assert.equal(ctx.recent_briefs.length, 0);
  assert.equal(ctx.topics.length, 0);
});

test('gatherWorkspaceContext: includes existing topics', () => {
  const ws = freshWorkspace();
  createTopic({ workspace_id: ws, name: 'T1', description: 'd1' });
  const ctx = gatherWorkspaceContext(ws);
  assert.equal(ctx.topics.length, 1);
  assert.equal(ctx.topics[0].name, 'T1');
});

// ─── buildSuggestPrompt ─────────────────────────────────────────────

test('buildSuggestPrompt: includes reply-format instructions per kind', () => {
  const ws = freshWorkspace();
  const ctx = gatherWorkspaceContext(ws);
  const topicPrompt = buildSuggestPrompt('topic', ctx);
  // Use [\s\S] instead of the /s (dotAll) flag — older TS targets
  // don't allow the flag in the source regex.
  assert.match(topicPrompt, /name[\s\S]*description[\s\S]*tags[\s\S]*rationale/);
  assert.match(topicPrompt, /topic/);

  const briefPrompt = buildSuggestPrompt('brief', ctx);
  assert.match(briefPrompt, /title[\s\S]*prompt[\s\S]*topic_id[\s\S]*rationale/);
});

test('buildSuggestPrompt: includes the NOT-a-task override', () => {
  const ws = freshWorkspace();
  const ctx = gatherWorkspaceContext(ws);
  const prompt = buildSuggestPrompt('topic', ctx);
  assert.match(prompt, /NOT a Mission Control task/i);
  assert.match(prompt, /Do NOT call/);
});

// ─── generateSuggestions end-to-end ─────────────────────────────────

test('generateSuggestions: rejects when no PM agent', async () => {
  const ws = freshWorkspace();
  const result = await generateSuggestions({ workspace_id: ws, kind: 'topic' });
  assert.equal(result.state, 'rejected');
  assert.match(result.reason ?? '', /No PM agent/);
});

test('generateSuggestions: happy path inserts pending rows', async () => {
  const ws = freshWorkspace();
  ensurePm(ws);
  const reply = `\`\`\`json
{
  "suggestions": [
    { "name": "Pricing watch", "description": "Track competitor pricing", "tags": ["competitor"], "rationale": "No topic exists" },
    { "name": "Regulatory scan", "description": "Quarterly scan of industry rules", "tags": ["compliance"], "rationale": "Ship date relies on this" }
  ]
}
\`\`\``;
  __setSendChatClientForTests(makeStubClient(reply));

  const result = await generateSuggestions({ workspace_id: ws, kind: 'topic' });
  assert.equal(result.state, 'ok');
  assert.equal(result.suggestions.length, 2);

  const pending = listSuggestions(ws, { kind: 'topic', status: 'pending' });
  assert.equal(pending.length, 2);
});

test('generateSuggestions: dismisses prior pending of same kind on rerun', async () => {
  const ws = freshWorkspace();
  ensurePm(ws);

  __setSendChatClientForTests(makeStubClient(
    `\`\`\`json
{ "suggestions": [{ "name": "First", "description": "", "tags": [], "rationale": "" }] }
\`\`\``,
  ));
  await generateSuggestions({ workspace_id: ws, kind: 'topic' });

  __setSendChatClientForTests(makeStubClient(
    `\`\`\`json
{ "suggestions": [{ "name": "Second", "description": "", "tags": [], "rationale": "" }] }
\`\`\``,
  ));
  await generateSuggestions({ workspace_id: ws, kind: 'topic' });

  const pending = listSuggestions(ws, { kind: 'topic', status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal((pending[0].payload as { name: string }).name, 'Second');

  const dismissed = listSuggestions(ws, { kind: 'topic', status: 'dismissed' });
  assert.equal(dismissed.length, 1);
  assert.equal((dismissed[0].payload as { name: string }).name, 'First');
});

test('generateSuggestions: returns failed when PM reply has no JSON', async () => {
  const ws = freshWorkspace();
  ensurePm(ws);
  __setSendChatClientForTests(makeStubClient('I do not understand the request.'));
  const result = await generateSuggestions({ workspace_id: ws, kind: 'topic' });
  assert.equal(result.state, 'failed');
  assert.match(result.reason ?? '', /JSON/i);
});

// ─── Initiative-scoped context (slice 2 of initiative research loop) ──

import { gatherInitiativeContext, buildInitiativeSuggestPrompt } from './suggest';
import { createBriefWithRun, setBriefSummary } from '@/lib/db/briefs';
import { createNote } from '@/lib/db/agent-notes';
import { markComplete, markRunning } from "@/lib/db/agent-runs";

function seedInitiative(workspaceId: string, overrides: { parent?: string; description?: string } = {}): string {
  const id = `init-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT INTO initiatives (id, workspace_id, parent_initiative_id, kind, title, description, status, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, 'theme', 'Test theme', ?, 'planned', 0, datetime('now'), datetime('now'))`,
    [id, workspaceId, overrides.parent ?? null, overrides.description ?? 'A theme to research.'],
  );
  return id;
}

test('gatherInitiativeContext: returns null for foreign workspace', () => {
  const ws = freshWorkspace();
  const other = freshWorkspace();
  const initId = seedInitiative(ws);
  const ctx = gatherInitiativeContext(other, initId);
  assert.equal(ctx, null);
});

test('gatherInitiativeContext: parent chain + recent PM notes + prior briefs index', () => {
  const ws = freshWorkspace();
  const root = seedInitiative(ws, { description: 'root theme' });
  const child = seedInitiative(ws, { parent: root, description: 'child' });

  // Add a PM-audience note above the importance threshold.
  createNote({
    workspace_id: ws,
    agent_id: null,
    initiative_id: child,
    scope_key: 'agent:test:ws:none:builder:1',
    role: 'builder',
    run_group_id: 'rg-1',
    kind: 'discovery',
    audience: 'pm',
    body: 'A discovery worth surfacing',
    importance: 2,
  });
  // Importance-0 note is filtered out (gather uses min_importance: 1).
  createNote({
    workspace_id: ws,
    agent_id: null,
    initiative_id: child,
    scope_key: 'agent:test:ws:none:builder:1',
    role: 'builder',
    run_group_id: 'rg-1',
    kind: 'observation',
    audience: 'pm',
    body: 'low signal',
    importance: 0,
  });

  // A prior brief on this initiative, completed.
  const { brief, agent_run } = createBriefWithRun({
    workspace_id: ws,
    template: 'general_brief',
    title: 'Prior brief',
    prompt: 'What is X?',
    initiative_id: child,
  });
  markRunning(agent_run.id);
  markComplete(agent_run.id);
  setBriefSummary(brief.id, 'X is well-understood and mature.');

  const ctx = gatherInitiativeContext(ws, child);
  assert.ok(ctx, 'context should be present');
  assert.equal(ctx!.initiative.id, child);
  assert.equal(ctx!.parent_chain.length, 1);
  assert.equal(ctx!.parent_chain[0].id, root);

  assert.equal(ctx!.recent_notes.length, 1);
  assert.equal(ctx!.recent_notes[0].body, 'A discovery worth surfacing');

  assert.equal(ctx!.prior_briefs.length, 1);
  assert.equal(ctx!.prior_briefs[0].id, brief.id);
  assert.equal(ctx!.prior_briefs[0].summary, 'X is well-understood and mature.');
  assert.equal(ctx!.prior_briefs[0].status, 'complete');
});

test('buildInitiativeSuggestPrompt: prompt body is initiative-scoped, not workspace-scoped', () => {
  const ws = freshWorkspace();
  const initId = seedInitiative(ws, { description: 'unique-marker-string' });
  const ctx = gatherInitiativeContext(ws, initId);
  assert.ok(ctx);
  const prompt = buildInitiativeSuggestPrompt('brief', ctx!);
  assert.match(prompt, /initiative-scoped/);
  assert.match(prompt, /unique-marker-string/);
  // Workspace-scoped buckets should NOT appear in this prompt.
  assert.doesNotMatch(prompt, /Tasks needing attention/);
});

test('generateSuggestions: rejects unknown initiative_id', async () => {
  const ws = freshWorkspace();
  ensurePm(ws);
  const result = await generateSuggestions({ workspace_id: ws, kind: 'brief', initiative_id: 'does-not-exist' });
  assert.equal(result.state, 'rejected');
  assert.match(result.reason ?? '', /not found/);
});

test('generateSuggestions: stamps initiative_id onto brief suggestion payloads', async () => {
  const ws = freshWorkspace();
  ensurePm(ws);
  const initId = seedInitiative(ws);
  __setSendChatClientForTests(makeStubClient(
    `\`\`\`json
{ "suggestions": [{ "title": "T1", "prompt": "?", "topic_id": null, "rationale": "r" }] }
\`\`\``,
  ));
  const result = await generateSuggestions({ workspace_id: ws, kind: 'brief', initiative_id: initId });
  assert.equal(result.state, 'ok');
  assert.equal(result.suggestions.length, 1);
  const payload = result.suggestions[0].payload as { initiative_id?: string };
  assert.equal(payload.initiative_id, initId);
  // listSuggestions filter by initiative_id finds it.
  const filtered = listSuggestions(ws, { initiative_id: initId, status: 'pending' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, result.suggestions[0].id);
});
