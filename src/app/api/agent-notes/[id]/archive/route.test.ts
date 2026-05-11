/**
 * POST /api/agent-notes/:id/archive route tests.
 *
 * See docs/archive/audit-actions-and-tracking.md PR 1.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { run } from '@/lib/db';
import { createNote, getNote } from '@/lib/db/agent-notes';

function freshWorkspace(): string {
  const id = `ws-note-arc-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function makeNote(workspaceId: string) {
  return createNote({
    workspace_id: workspaceId,
    agent_id: null,
    scope_key: `scope-${uuidv4()}`,
    role: 'researcher',
    run_group_id: `rg-${uuidv4()}`,
    kind: 'observation',
    body: 'something audit-worthy',
  });
}

function archiveReq(
  id: string,
  body?: unknown,
): { req: NextRequest; ctx: { params: Promise<{ id: string }> } } {
  const url = new URL(`http://localhost/api/agent-notes/${id}/archive`);
  const bodyText =
    body === undefined
      ? undefined
      : typeof body === 'string'
        ? body
        : JSON.stringify(body);
  const init: { method: string; body?: string; headers?: Record<string, string> } = {
    method: 'POST',
  };
  if (bodyText !== undefined) {
    init.body = bodyText;
    init.headers = { 'content-type': 'application/json' };
  }
  return {
    req: new NextRequest(url, init),
    ctx: { params: Promise.resolve({ id }) },
  };
}

test('POST archive: missing note → 404', async () => {
  const { req, ctx } = archiveReq('nope-' + uuidv4());
  const res = await POST(req, ctx);
  assert.equal(res.status, 404);
});

test('POST archive: sets archived_at + archived_reason', async () => {
  const ws = freshWorkspace();
  const note = makeNote(ws);
  const { req, ctx } = archiveReq(note.id, { reason: 'no longer relevant' });
  const res = await POST(req, ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.note.archived_at);
  assert.equal(body.note.archived_reason, 'no longer relevant');
});

test('POST archive: empty body is tolerated', async () => {
  const ws = freshWorkspace();
  const note = makeNote(ws);
  const { req, ctx } = archiveReq(note.id);
  const res = await POST(req, ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.note.archived_at);
  assert.equal(body.note.archived_reason, null);
});

test('POST archive: idempotent on already-archived note', async () => {
  const ws = freshWorkspace();
  const note = makeNote(ws);
  // First archive.
  const r1 = archiveReq(note.id, { reason: 'first' });
  await POST(r1.req, r1.ctx);
  const firstReason = getNote(note.id)?.archived_reason;
  // Second archive — DAO is idempotent (first reason wins).
  const r2 = archiveReq(note.id, { reason: 'second' });
  const res2 = await POST(r2.req, r2.ctx);
  assert.equal(res2.status, 200);
  assert.equal(getNote(note.id)?.archived_reason, firstReason);
});

test('POST archive: invalid JSON body → 400', async () => {
  const ws = freshWorkspace();
  const note = makeNote(ws);
  const { req, ctx } = archiveReq(note.id, '{not json');
  const res = await POST(req, ctx);
  assert.equal(res.status, 400);
});
