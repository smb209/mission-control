/**
 * /api/topics/[id] route tests.
 *
 * Covers: GET (200/404), PATCH (field updates, archive/unarchive
 * via the `archived` flag, validation errors), DELETE (soft-archive).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { DELETE, GET, PATCH } from './route';
import { run } from '@/lib/db';
import { createTopic, getTopic } from '@/lib/db/topics';

function freshWorkspace(): string {
  const id = `ws-trid-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function patchReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/topics/x', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET /api/topics/[id]: 404 for unknown', async () => {
  const res = await GET(new NextRequest('http://localhost/x'), ctx('does-not-exist'));
  assert.equal(res.status, 404);
});

test('GET /api/topics/[id]: 200 with topic', async () => {
  const ws = freshWorkspace();
  const t = createTopic({ workspace_id: ws, name: 'x' });
  const res = await GET(new NextRequest('http://localhost/x'), ctx(t.id));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, t.id);
  assert.equal(body.name, 'x');
});

test('PATCH /api/topics/[id]: updates fields', async () => {
  const ws = freshWorkspace();
  const t = createTopic({ workspace_id: ws, name: 'orig' });
  const res = await PATCH(patchReq({ name: 'renamed', tags: ['new'] }), ctx(t.id));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.name, 'renamed');
  assert.deepEqual(body.tags, ['new']);
});

test('PATCH /api/topics/[id]: archived: true archives', async () => {
  const ws = freshWorkspace();
  const t = createTopic({ workspace_id: ws, name: 'x' });
  const res = await PATCH(patchReq({ archived: true }), ctx(t.id));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.archived_at);
});

test('PATCH /api/topics/[id]: archived: false unarchives', async () => {
  const ws = freshWorkspace();
  const t = createTopic({ workspace_id: ws, name: 'x' });
  await PATCH(patchReq({ archived: true }), ctx(t.id));
  const res = await PATCH(patchReq({ archived: false }), ctx(t.id));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.archived_at, null);
});

test('PATCH /api/topics/[id]: blank name → 400', async () => {
  const ws = freshWorkspace();
  const t = createTopic({ workspace_id: ws, name: 'x' });
  const res = await PATCH(patchReq({ name: '   ' }), ctx(t.id));
  assert.equal(res.status, 400);
});

test('PATCH /api/topics/[id]: 404 for unknown id', async () => {
  const res = await PATCH(patchReq({ name: 'x' }), ctx('nope'));
  assert.equal(res.status, 404);
});

test('DELETE /api/topics/[id]: soft-archives, row still exists', async () => {
  const ws = freshWorkspace();
  const t = createTopic({ workspace_id: ws, name: 'doomed' });
  const res = await DELETE(new NextRequest('http://localhost/x', { method: 'DELETE' }), ctx(t.id));
  assert.equal(res.status, 200);
  const reloaded = getTopic(t.id);
  assert.ok(reloaded);
  assert.ok(reloaded?.archived_at);
});

test('DELETE /api/topics/[id]: 404 for unknown', async () => {
  const res = await DELETE(new NextRequest('http://localhost/x', { method: 'DELETE' }), ctx('nope'));
  assert.equal(res.status, 404);
});
