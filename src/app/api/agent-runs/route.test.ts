/**
 * /api/agent-runs route tests.
 *
 * Covers: workspace scoping, kind/status filtering, validation of
 * filter values, limit bounds.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { run } from '@/lib/db';
import { createBriefWithRun } from '@/lib/db/briefs';
import { markRunning } from '@/lib/db/agent-runs';

function freshWorkspace(): string {
  const id = `ws-arr-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function listReq(params: Record<string, string | undefined>): NextRequest {
  const url = new URL('http://localhost/api/agent-runs');
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  return new NextRequest(url);
}

test('GET /api/agent-runs: missing workspace_id → 400', async () => {
  const res = await GET(listReq({}));
  assert.equal(res.status, 400);
});

test('GET /api/agent-runs: empty workspace returns []', async () => {
  const ws = freshWorkspace();
  const res = await GET(listReq({ workspace_id: ws }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

test('GET /api/agent-runs: workspace-scoped, filter by status', async () => {
  const ws = freshWorkspace();
  const { agent_run: a } = createBriefWithRun({
    workspace_id: ws, template: 'general_brief',
    title: 'one', prompt: 'p',
  });
  createBriefWithRun({
    workspace_id: ws, template: 'general_brief',
    title: 'two', prompt: 'p',
  });
  markRunning(a.id);

  const all = await (await GET(listReq({ workspace_id: ws }))).json();
  assert.equal(all.length, 2);

  const running = await (await GET(listReq({ workspace_id: ws, status: 'running' }))).json();
  assert.equal(running.length, 1);
  assert.equal(running[0].id, a.id);

  const queued = await (await GET(listReq({ workspace_id: ws, status: 'queued' }))).json();
  assert.equal(queued.length, 1);
});

test('GET /api/agent-runs: invalid status → 400', async () => {
  const ws = freshWorkspace();
  const res = await GET(listReq({ workspace_id: ws, status: 'made-up' }));
  assert.equal(res.status, 400);
});

test('GET /api/agent-runs: invalid kind → 400', async () => {
  const ws = freshWorkspace();
  const res = await GET(listReq({ workspace_id: ws, kind: 'made-up' }));
  assert.equal(res.status, 400);
});

test('GET /api/agent-runs: limit param honored', async () => {
  const ws = freshWorkspace();
  for (let i = 0; i < 5; i++) {
    createBriefWithRun({
      workspace_id: ws, template: 'general_brief',
      title: `t${i}`, prompt: 'p',
    });
  }
  const limited = await (await GET(listReq({ workspace_id: ws, limit: '2' }))).json();
  assert.equal(limited.length, 2);
});
