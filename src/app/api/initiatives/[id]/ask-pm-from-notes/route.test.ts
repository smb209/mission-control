/**
 * POST /api/initiatives/:id/ask-pm-from-notes route tests.
 *
 * Validation behavior only — the dispatch path itself is exercised in
 * pm-dispatch.test.ts. Here we verify that the route enforces note
 * ownership, archived gating, and validation shape.
 *
 * See docs/archive/audit-actions-and-tracking.md PR 5.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { run } from '@/lib/db';
import { archiveNote, createNote } from '@/lib/db/agent-notes';

function freshWorkspace(): string {
  const id = `ws-ask-pm-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function freshInitiative(workspaceId: string): string {
  const id = `init-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO initiatives (id, workspace_id, title, status, kind, created_at, updated_at)
     VALUES (?, ?, ?, 'planned', 'epic', datetime('now'), datetime('now'))`,
    [id, workspaceId, `seed ${id}`],
  );
  return id;
}

function makeNote(workspaceId: string, initiativeId: string | null) {
  return createNote({
    workspace_id: workspaceId,
    agent_id: null,
    initiative_id: initiativeId ?? null,
    scope_key: `scope-${uuidv4()}`,
    role: 'researcher',
    run_group_id: `rg-${uuidv4()}`,
    kind: 'observation',
    body: 'audit noted X',
  });
}

function postReq(
  initId: string,
  body: unknown,
): { req: NextRequest; ctx: { params: Promise<{ id: string }> } } {
  const url = new URL(`http://localhost/api/initiatives/${initId}/ask-pm-from-notes`);
  return {
    req: new NextRequest(url, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    ctx: { params: Promise.resolve({ id: initId }) },
  };
}

test('POST: missing initiative → 404', async () => {
  const { req, ctx } = postReq('does-not-exist', { note_ids: ['x'] });
  const res = await POST(req, ctx);
  assert.equal(res.status, 404);
});

test('POST: empty note_ids → 400', async () => {
  const ws = freshWorkspace();
  const init = freshInitiative(ws);
  const { req, ctx } = postReq(init, { note_ids: [] });
  const res = await POST(req, ctx);
  assert.equal(res.status, 400);
});

test('POST: missing note → 404', async () => {
  const ws = freshWorkspace();
  const init = freshInitiative(ws);
  const { req, ctx } = postReq(init, { note_ids: ['nope'] });
  const res = await POST(req, ctx);
  assert.equal(res.status, 404);
});

test('POST: note belongs to a different initiative → 400', async () => {
  const ws = freshWorkspace();
  const initA = freshInitiative(ws);
  const initB = freshInitiative(ws);
  const note = makeNote(ws, initB);
  const { req, ctx } = postReq(initA, { note_ids: [note.id] });
  const res = await POST(req, ctx);
  assert.equal(res.status, 400);
});

test('POST: archived note → 409', async () => {
  const ws = freshWorkspace();
  const init = freshInitiative(ws);
  const note = makeNote(ws, init);
  archiveNote(note.id, 'cleanup');
  const { req, ctx } = postReq(init, { note_ids: [note.id] });
  const res = await POST(req, ctx);
  assert.equal(res.status, 409);
});

test('POST: invalid JSON body → 400', async () => {
  const ws = freshWorkspace();
  const init = freshInitiative(ws);
  const { req, ctx } = postReq(init, '{not json');
  const res = await POST(req, ctx);
  assert.equal(res.status, 400);
});
