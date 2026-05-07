/**
 * /api/jobs route tests.
 *
 * Verifies the three-bucket response shape and workspace_id required
 * validation. Deeper grouping/window logic is exercised by listJobs
 * unit tests in src/lib/db/agent-runs.test.ts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { run } from '@/lib/db';
import { startAgentRun } from '@/lib/db/agent-runs';

function freshWorkspace(): string {
  const id = `ws-jobs-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function jobsReq(params: Record<string, string | undefined>): NextRequest {
  const url = new URL('http://localhost/api/jobs');
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  return new NextRequest(url);
}

test('GET /api/jobs: missing workspace_id → 400', async () => {
  const res = await GET(jobsReq({}));
  assert.equal(res.status, 400);
});

test('GET /api/jobs: empty workspace returns three empty buckets', async () => {
  const ws = freshWorkspace();
  const res = await GET(jobsReq({ workspace_id: ws }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['live', 'recent', 'scheduled']);
  assert.deepEqual(body.live, []);
  assert.deepEqual(body.scheduled, []);
  assert.deepEqual(body.recent, []);
});

test('GET /api/jobs: live bucket reflects running pm_chat collapse', async () => {
  const ws = freshWorkspace();
  const scope = `scope-${uuidv4()}`;
  for (let i = 0; i < 2; i++) {
    startAgentRun({
      workspace_id: ws,
      kind: 'pm_chat',
      scope_key: scope,
      scope_type: 'pm_chat',
      role: 'pm',
      agent_id: `a${i}`,
    });
  }
  const res = await GET(jobsReq({ workspace_id: ws }));
  const body = await res.json();
  assert.equal(body.live.length, 1);
  assert.equal(body.live[0].group_count, 2);
  assert.equal(body.live[0].kind, 'pm_chat');
  assert.equal(typeof body.live[0].derived_label, 'string');
});
