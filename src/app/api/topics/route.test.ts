/**
 * /api/topics route tests.
 *
 * Calls the route handlers directly with constructed NextRequests.
 * Covers: list (workspace scoping, includeArchived flag), create
 * (validation errors → 400, happy path → 201), input validation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { GET, POST } from './route';
import { run } from '@/lib/db';
import { archiveTopic, createTopic } from '@/lib/db/topics';

function freshWorkspace(): string {
  const id = `ws-tr-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function listReq(workspaceId: string | null, includeArchived = false): NextRequest {
  const url = new URL('http://localhost/api/topics');
  if (workspaceId) url.searchParams.set('workspace_id', workspaceId);
  if (includeArchived) url.searchParams.set('include', 'archived');
  return new NextRequest(url);
}

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/topics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET /api/topics: missing workspace_id → 400', async () => {
  const res = await GET(listReq(null));
  assert.equal(res.status, 400);
});

test('GET /api/topics: empty workspace returns []', async () => {
  const ws = freshWorkspace();
  const res = await GET(listReq(ws));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

test('GET /api/topics: workspace-scoped, archived excluded by default', async () => {
  const wsA = freshWorkspace();
  const wsB = freshWorkspace();
  const t1 = createTopic({ workspace_id: wsA, name: 'A1' });
  createTopic({ workspace_id: wsA, name: 'A2' });
  createTopic({ workspace_id: wsB, name: 'B1' });
  archiveTopic(t1.id);

  const liveA = await (await GET(listReq(wsA))).json();
  assert.equal(liveA.length, 1);
  assert.equal(liveA[0].name, 'A2');

  const allA = await (await GET(listReq(wsA, true))).json();
  assert.equal(allA.length, 2);

  const liveB = await (await GET(listReq(wsB))).json();
  assert.equal(liveB.length, 1);
  assert.equal(liveB[0].name, 'B1');
});

test('POST /api/topics: happy path → 201 with full topic', async () => {
  const ws = freshWorkspace();
  const res = await POST(postReq({
    workspace_id: ws,
    name: 'GLP-1 regulation',
    description: 'Watch for FDA actions',
    tags: ['pharma', 'regulation'],
  }));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.workspace_id, ws);
  assert.equal(body.name, 'GLP-1 regulation');
  assert.deepEqual(body.tags, ['pharma', 'regulation']);
  assert.equal(body.archived_at, null);
  assert.ok(body.id);
});

test('POST /api/topics: missing name → 400', async () => {
  const ws = freshWorkspace();
  const res = await POST(postReq({ workspace_id: ws }));
  assert.equal(res.status, 400);
});

test('POST /api/topics: blank name → 400', async () => {
  const ws = freshWorkspace();
  const res = await POST(postReq({ workspace_id: ws, name: '   ' }));
  assert.equal(res.status, 400);
});

test('POST /api/topics: name longer than 500 chars → 400', async () => {
  const ws = freshWorkspace();
  const res = await POST(postReq({ workspace_id: ws, name: 'x'.repeat(501) }));
  assert.equal(res.status, 400);
});

test('POST /api/topics: too many tags → 400', async () => {
  const ws = freshWorkspace();
  const res = await POST(postReq({
    workspace_id: ws,
    name: 'x',
    tags: Array.from({ length: 65 }, (_, i) => `t${i}`),
  }));
  assert.equal(res.status, 400);
});

test('POST /api/topics: SQL-injection-like name is stored verbatim, not executed', async () => {
  const ws = freshWorkspace();
  const evil = "Robert'); DROP TABLE topics; --";
  const res = await POST(postReq({ workspace_id: ws, name: evil }));
  assert.equal(res.status, 201);
  // List succeeds — table not dropped.
  const list = await (await GET(listReq(ws))).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, evil);
});
