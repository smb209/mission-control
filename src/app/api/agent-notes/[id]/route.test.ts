/**
 * /api/agent-notes/[id] route tests — hard-delete (DELETE) only.
 *
 * Archive + restore live in sibling route.test.ts files because Next's
 * route handler files are co-located one-per-verb-cluster.
 *
 * See docs/archive/audit-actions-and-tracking.md PR 1.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { DELETE } from './route';
import { run, queryOne } from '@/lib/db';
import { archiveNote, createNote, getNote } from '@/lib/db/agent-notes';

function freshWorkspace(): string {
  const id = `ws-note-del-${uuidv4().slice(0, 8)}`;
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
    body: 'audit said something',
  });
}

function delReq(id: string): { req: NextRequest; ctx: { params: Promise<{ id: string }> } } {
  const url = new URL(`http://localhost/api/agent-notes/${id}`);
  return {
    req: new NextRequest(url, { method: 'DELETE' }),
    ctx: { params: Promise.resolve({ id }) },
  };
}

test('DELETE: missing note → 404', async () => {
  const { req, ctx } = delReq('nope-' + uuidv4());
  const res = await DELETE(req, ctx);
  assert.equal(res.status, 404);
});

test('DELETE: active note → 409 (archive-first gate)', async () => {
  const ws = freshWorkspace();
  const note = makeNote(ws);
  const { req, ctx } = delReq(note.id);
  const res = await DELETE(req, ctx);
  assert.equal(res.status, 409);
  // Row must still exist.
  assert.ok(getNote(note.id), 'row should not be deleted');
});

test('DELETE: archived note → 200, row gone', async () => {
  const ws = freshWorkspace();
  const note = makeNote(ws);
  archiveNote(note.id, 'cleanup');

  const { req, ctx } = delReq(note.id);
  const res = await DELETE(req, ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  const after = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM agent_notes WHERE id = ?`,
    [note.id],
  );
  assert.equal(after?.n, 0);
});
