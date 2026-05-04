/**
 * /api/briefs route tests.
 *
 * Covers: list (workspace scoping, topic_id filter), create (happy
 * path, validation, topic-cross-workspace rejection, archived-topic
 * rejection).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { GET, POST } from './route';
import { run } from '@/lib/db';
import { archiveTopic, createTopic } from '@/lib/db/topics';
import { createBriefWithRun } from '@/lib/db/briefs';

function freshWorkspace(): string {
  const id = `ws-bro-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function listReq(workspaceId: string | null, topicId?: string): NextRequest {
  const url = new URL('http://localhost/api/briefs');
  if (workspaceId) url.searchParams.set('workspace_id', workspaceId);
  if (topicId) url.searchParams.set('topic_id', topicId);
  return new NextRequest(url);
}

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/briefs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET /api/briefs: missing workspace_id → 400', async () => {
  const res = await GET(listReq(null));
  assert.equal(res.status, 400);
});

test('GET /api/briefs: workspace-scoped', async () => {
  const wsA = freshWorkspace();
  const wsB = freshWorkspace();
  createBriefWithRun({
    workspace_id: wsA, template: 'general_brief',
    title: 'A', prompt: 'p',
  });
  createBriefWithRun({
    workspace_id: wsB, template: 'general_brief',
    title: 'B', prompt: 'p',
  });
  const a = await (await GET(listReq(wsA))).json();
  const b = await (await GET(listReq(wsB))).json();
  assert.equal(a.length, 1);
  assert.equal(a[0].title, 'A');
  assert.equal(b.length, 1);
  assert.equal(b[0].title, 'B');
});

test('GET /api/briefs: topic_id filter', async () => {
  const ws = freshWorkspace();
  const topic = createTopic({ workspace_id: ws, name: 't' });
  createBriefWithRun({
    workspace_id: ws, template: 'general_brief',
    title: 'no-topic', prompt: 'p',
  });
  createBriefWithRun({
    workspace_id: ws, template: 'general_brief',
    title: 'with-topic', prompt: 'p', topic_id: topic.id,
  });
  const filtered = await (await GET(listReq(ws, topic.id))).json();
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].title, 'with-topic');
});

test('POST /api/briefs: happy path → 201 with brief + agent_run', async () => {
  const ws = freshWorkspace();
  const res = await POST(postReq({
    workspace_id: ws,
    template: 'general_brief',
    title: 'WebGPU survey',
    prompt: 'Summarize WebGPU support.',
  }));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.brief);
  assert.ok(body.agent_run);
  assert.equal(body.brief.title, 'WebGPU survey');
  assert.equal(body.agent_run.kind, 'brief');
  assert.equal(body.agent_run.status, 'queued');
  assert.equal(body.brief.agent_run_id, body.agent_run.id);
});

test('POST /api/briefs: invalid template → 400', async () => {
  const ws = freshWorkspace();
  const res = await POST(postReq({
    workspace_id: ws,
    template: 'not_a_template',
    title: 'x',
    prompt: 'p',
  }));
  assert.equal(res.status, 400);
});

test('POST /api/briefs: missing prompt → 400', async () => {
  const ws = freshWorkspace();
  const res = await POST(postReq({
    workspace_id: ws,
    template: 'general_brief',
    title: 'x',
  }));
  assert.equal(res.status, 400);
});

test('POST /api/briefs: cross-workspace topic → 400', async () => {
  const wsA = freshWorkspace();
  const wsB = freshWorkspace();
  const topicB = createTopic({ workspace_id: wsB, name: 'B' });
  const res = await POST(postReq({
    workspace_id: wsA,
    template: 'general_brief',
    title: 'x',
    prompt: 'p',
    topic_id: topicB.id,
  }));
  assert.equal(res.status, 400);
});

test('POST /api/briefs: archived topic → 400', async () => {
  const ws = freshWorkspace();
  const topic = createTopic({ workspace_id: ws, name: 't' });
  archiveTopic(topic.id);
  const res = await POST(postReq({
    workspace_id: ws,
    template: 'general_brief',
    title: 'x',
    prompt: 'p',
    topic_id: topic.id,
  }));
  assert.equal(res.status, 400);
});
