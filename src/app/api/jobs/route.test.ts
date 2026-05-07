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

test('GET /api/jobs?count_only=true: returns just { live: N } with collapse', async () => {
  const ws = freshWorkspace();
  const scope = `scope-${uuidv4()}`;
  for (let i = 0; i < 3; i++) {
    startAgentRun({
      workspace_id: ws,
      kind: 'pm_chat',
      scope_key: scope,
      scope_type: 'pm_chat',
      role: 'pm',
      agent_id: `a${i}`,
    });
  }
  startAgentRun({
    workspace_id: ws,
    kind: 'plan',
    scope_key: 'plan-x',
    scope_type: 'plan',
    role: 'pm',
    agent_id: 'plan-a',
  });
  const res = await GET(jobsReq({ workspace_id: ws, count_only: 'true' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ['live']);
  // 3 collapsed pm_chat → 1 group + 1 plan row = 2.
  assert.equal(body.live, 2);
});

test('GET /api/jobs?count_only=true: missing workspace_id → 400', async () => {
  const res = await GET(jobsReq({ count_only: 'true' }));
  assert.equal(res.status, 400);
});

test('GET /api/jobs?initiative_id=…: filters live + recent, suppresses scheduled', async () => {
  const ws = freshWorkspace();
  // Seed two initiatives directly.
  const iA = `init-A-${uuidv4().slice(0, 6)}`;
  const iB = `init-B-${uuidv4().slice(0, 6)}`;
  for (const id of [iA, iB]) {
    run(
      `INSERT OR IGNORE INTO initiatives (id, workspace_id, title, status, kind, created_at, updated_at)
       VALUES (?, ?, ?, 'planned', 'epic', datetime('now'), datetime('now'))`,
      [id, ws, `seed ${id}`],
    );
  }

  // 1 live audit on A, 1 live audit on B.
  startAgentRun({
    workspace_id: ws,
    kind: 'initiative_audit',
    scope_key: `audit-A-${uuidv4()}`,
    scope_type: 'initiative_audit',
    role: 'researcher',
    agent_id: 'r1',
    initiative_id: iA,
  });
  startAgentRun({
    workspace_id: ws,
    kind: 'initiative_audit',
    scope_key: `audit-B-${uuidv4()}`,
    scope_type: 'initiative_audit',
    role: 'researcher',
    agent_id: 'r2',
    initiative_id: iB,
  });

  // Filter to A — should see only that one in live, scheduled empty.
  const resA = await GET(jobsReq({ workspace_id: ws, initiative_id: iA }));
  const bodyA = await resA.json();
  assert.equal(bodyA.live.length, 1);
  assert.equal(bodyA.live[0].initiative_id, iA);
  assert.deepEqual(bodyA.scheduled, []);

  // No filter — should see both.
  const resAll = await GET(jobsReq({ workspace_id: ws }));
  const bodyAll = await resAll.json();
  assert.equal(bodyAll.live.length, 2);
});
