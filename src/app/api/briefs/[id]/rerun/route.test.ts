/**
 * /api/briefs/[id]/rerun route tests.
 *
 * The rerun creates a NEW brief (same prompt/title/topic/template)
 * and dispatches it; the original is left untouched as audit
 * evidence. Preserves brief history regardless of how many times
 * the operator re-tries.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { run } from '@/lib/db';
import { createBriefWithRun, getBrief } from '@/lib/db/briefs';
import {
  __setSendChatClientForTests,
  type SendChatClient,
} from '@/lib/openclaw/send-chat';

function freshWorkspace(): string {
  const id = `ws-rerun-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function ensureResearcherAndRunner(workspaceId: string): void {
  run(
    `INSERT OR IGNORE INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, source, is_active, created_at, updated_at)
     VALUES (?, 'researcher-rerun', 'researcher', '🔍', 'standby', 0, ?, 'local', 1, datetime('now'), datetime('now'))`,
    [`r-${uuidv4().slice(0, 8)}`, workspaceId],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES ('default', 'default', 'default', datetime('now'))`,
  );
  run(
    `INSERT OR IGNORE INTO agents
       (id, name, role, avatar_emoji, status, is_master, workspace_id, source, gateway_agent_id, session_key_prefix, model, is_active, created_at, updated_at)
       VALUES ('runner-rerun', 'MC Runner Dev', 'runner', '⚙️', 'standby', 0, 'default', 'gateway', 'mc-runner-dev', 'agent:mc-runner-dev:main', 'spark-lb/agent', 1, datetime('now'), datetime('now'))`,
  );
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function postReq(): NextRequest {
  return new NextRequest('http://localhost/x', { method: 'POST' });
}

function inertStub(): SendChatClient {
  return {
    isConnected: () => true,
    on: () => undefined,
    off: () => undefined,
    call: async () => ({}),
  };
}

test.afterEach(() => {
  __setSendChatClientForTests(null);
});

test('POST /api/briefs/[id]/rerun: 404 for unknown', async () => {
  const res = await POST(postReq(), ctx('nope'));
  assert.equal(res.status, 404);
});

test('POST /api/briefs/[id]/rerun: clones the brief and dispatches the clone', async () => {
  const ws = freshWorkspace();
  ensureResearcherAndRunner(ws);
  __setSendChatClientForTests(inertStub());

  const original = createBriefWithRun({
    workspace_id: ws,
    template: 'general_brief',
    title: 'Original brief',
    prompt: 'survey something',
  });

  const res = await POST(postReq(), ctx(original.brief.id));
  assert.equal(res.status, 202);
  const body = await res.json();

  // New brief returned with new id, same prompt/title/template.
  assert.notEqual(body.brief.id, original.brief.id);
  assert.equal(body.brief.title, 'Original brief');
  assert.equal(body.brief.prompt, 'survey something');
  assert.equal(body.brief.template, 'general_brief');
  assert.equal(body.brief.requested_by, `rerun:${original.brief.id}`);
  assert.equal(body.cloned_from, original.brief.id);

  // Original is untouched.
  const originalReloaded = getBrief(original.brief.id);
  assert.ok(originalReloaded);
  assert.equal(originalReloaded?.id, original.brief.id);
});

test('POST /api/briefs/[id]/rerun: preserves topic linkage on clone', async () => {
  const { createTopic } = await import('@/lib/db/topics');
  const ws = freshWorkspace();
  ensureResearcherAndRunner(ws);
  __setSendChatClientForTests(inertStub());

  const topic = createTopic({ workspace_id: ws, name: 'T' });
  const original = createBriefWithRun({
    workspace_id: ws,
    template: 'general_brief',
    title: 'with topic',
    prompt: 'p',
    topic_id: topic.id,
  });

  const res = await POST(postReq(), ctx(original.brief.id));
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.brief.topic_id, topic.id);
});
