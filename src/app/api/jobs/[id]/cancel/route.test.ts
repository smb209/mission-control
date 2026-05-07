/**
 * /api/jobs/:id/cancel route tests.
 *
 * Verifies the 404 / 409 / 200 paths and that the response body
 * surfaces children_cancelled. The DAO-level cascade + transaction
 * behavior is covered in src/lib/db/agent-runs.test.ts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { run } from '@/lib/db';
import {
  createAgentRun,
  startAgentRun,
  markComplete,
  markRunning,
  getAgentRun,
} from '@/lib/db/agent-runs';

function freshWorkspace(): string {
  const id = `ws-cancel-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function cancelReq(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/jobs/${id}/cancel`, { method: 'POST' });
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

test('POST /api/jobs/:id/cancel: 404 when row does not exist', async () => {
  const res = await POST(cancelReq('nope'), ctx('nope'));
  assert.equal(res.status, 404);
});

test('POST /api/jobs/:id/cancel: 409 when row is already terminal', async () => {
  const ws = freshWorkspace();
  const r = createAgentRun({ workspace_id: ws, kind: 'pm_chat' });
  markRunning(r.id);
  markComplete(r.id);
  const res = await POST(cancelReq(r.id), ctx(r.id));
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.status, 'complete');
});

test('POST /api/jobs/:id/cancel: 200 marks queued row cancelled', async () => {
  const ws = freshWorkspace();
  const r = createAgentRun({ workspace_id: ws, kind: 'pm_chat' });
  const res = await POST(cancelReq(r.id), ctx(r.id));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, r.id);
  assert.equal(body.status, 'cancelled');
  assert.equal(body.children_cancelled, 0);
  assert.equal(getAgentRun(r.id)!.status, 'cancelled');
});

test('POST /api/jobs/:id/cancel: cascades to running children', async () => {
  const ws = freshWorkspace();
  const parentId = startAgentRun({
    workspace_id: ws,
    kind: 'initiative_audit',
    scope_key: 'audit:r',
    scope_type: 'initiative_audit',
    role: 'researcher',
    agent_id: 'a',
  });
  const c1 = startAgentRun({
    workspace_id: ws,
    kind: 'initiative_audit',
    scope_key: 'audit:r:1',
    scope_type: 'initiative_audit',
    role: 'researcher',
    agent_id: 'a1',
    parent_run_id: parentId,
  });
  const c2 = startAgentRun({
    workspace_id: ws,
    kind: 'initiative_audit',
    scope_key: 'audit:r:2',
    scope_type: 'initiative_audit',
    role: 'researcher',
    agent_id: 'a2',
    parent_run_id: parentId,
  });

  const res = await POST(cancelReq(parentId), ctx(parentId));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.children_cancelled, 2);
  assert.equal(getAgentRun(c1)!.status, 'cancelled');
  assert.equal(getAgentRun(c2)!.status, 'cancelled');
});
