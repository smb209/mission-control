/**
 * POST /api/agent-notes/:id/restore route tests.
 *
 * See specs/audit-actions-and-tracking.md PR 1.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { run } from '@/lib/db';
import { archiveNote, createNote } from '@/lib/db/agent-notes';

function freshWorkspace(): string {
  const id = `ws-note-res-${uuidv4().slice(0, 8)}`;
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
    body: 'audit recap',
  });
}

function restoreReq(id: string): { req: NextRequest; ctx: { params: Promise<{ id: string }> } } {
  const url = new URL(`http://localhost/api/agent-notes/${id}/restore`);
  return {
    req: new NextRequest(url, { method: 'POST' }),
    ctx: { params: Promise.resolve({ id }) },
  };
}

test('POST restore: missing note → 404', async () => {
  const { req, ctx } = restoreReq('nope-' + uuidv4());
  const res = await POST(req, ctx);
  assert.equal(res.status, 404);
});

test('POST restore: clears archived_at and archived_reason', async () => {
  const ws = freshWorkspace();
  const note = makeNote(ws);
  archiveNote(note.id, 'temporarily');

  const { req, ctx } = restoreReq(note.id);
  const res = await POST(req, ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.note.archived_at, null);
  assert.equal(body.note.archived_reason, null);
});

test('POST restore: no-op on already-active note', async () => {
  const ws = freshWorkspace();
  const note = makeNote(ws);
  const { req, ctx } = restoreReq(note.id);
  const res = await POST(req, ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.note.archived_at, null);
});
