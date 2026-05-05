/**
 * /api/topics/[id]/schedules route tests.
 *
 * Covers GET (200/404), POST (success/validation/archived-topic), and
 * the topic-archive→schedules-pause hook (lives in topics.ts but the
 * cleanest assertion lives here next to the create flow).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { GET, POST } from './route';
import { run } from '@/lib/db';
import { archiveTopic, createTopic } from '@/lib/db/topics';
import { getRecurringJob, listResearchSchedulesForTopic } from '@/lib/db/recurring-jobs';

function freshWorkspace(): string {
  const id = `ws-tsch-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/topics/x/schedules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET /api/topics/[id]/schedules: 404 for unknown topic', async () => {
  const res = await GET(new NextRequest('http://localhost/x'), ctx('does-not-exist'));
  assert.equal(res.status, 404);
});

test('POST /api/topics/[id]/schedules: creates a research schedule', async () => {
  const ws = freshWorkspace();
  const tp = createTopic({ workspace_id: ws, name: 'Topic A' });
  const res = await POST(postReq({ cadence_seconds: 60 }), ctx(tp.id));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.topic_id, tp.id);
  assert.equal(body.brief_template, 'general_brief');
  assert.equal(body.cadence_seconds, 60);
  assert.equal(body.role, 'researcher');

  // Listed via the topic GET.
  const listed = listResearchSchedulesForTopic(tp.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, body.id);
});

test('POST /api/topics/[id]/schedules: validation error for missing cadence', async () => {
  const ws = freshWorkspace();
  const tp = createTopic({ workspace_id: ws, name: 'Topic B' });
  const res = await POST(postReq({ }), ctx(tp.id));
  assert.equal(res.status, 400);
});

test('POST /api/topics/[id]/schedules: rejects on archived topic', async () => {
  const ws = freshWorkspace();
  const tp = createTopic({ workspace_id: ws, name: 'Topic C' });
  archiveTopic(tp.id);
  const res = await POST(postReq({ cadence_seconds: 60 }), ctx(tp.id));
  assert.equal(res.status, 400);
});

test('archiveTopic auto-pauses active schedules attached to the topic', async () => {
  const ws = freshWorkspace();
  const tp = createTopic({ workspace_id: ws, name: 'Topic D' });
  const created = await POST(postReq({ cadence_seconds: 60 }), ctx(tp.id));
  const sched = await created.json();

  archiveTopic(tp.id);
  const after = getRecurringJob(sched.id);
  assert.equal(after?.status, 'paused');
});
