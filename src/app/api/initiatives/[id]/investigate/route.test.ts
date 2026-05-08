/**
 * Investigate route tests — PR 4 of specs/initiative-investigate.md.
 *
 * Focuses on the slices that are exercisable without a live gateway:
 *
 *   - GET ?dryrun=1: plan response shape for narrow + subtree modes
 *   - POST subtree: terminal-status root → 400
 *   - POST subtree: missing runner → 503 (no orchestration kicked off)
 *   - POST subtree: zero non-terminal descendants → planned_nodes=1
 *
 * The full happy-path (real LLM dispatch + per-node take_note rows)
 * is covered by the dogfood loop documented in
 * specs/initiative-investigate.md §"Verification pipeline".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { GET, POST } from './route';
import { run, queryOne } from '@/lib/db';
import { createInitiative, updateInitiative } from '@/lib/db/initiatives';

function freshWorkspace(): string {
  const id = `ws-inv-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

/** Remove any existing runner agent so getRunnerAgent() returns null. */
function clearRunner(): void {
  run(`DELETE FROM agents WHERE gateway_agent_id IN ('mc-runner','mc-runner-dev')`);
}

async function callPost(id: string, body: unknown): Promise<Response> {
  const req = new NextRequest(
    `http://localhost/api/initiatives/${id}/investigate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return await POST(req, { params: Promise.resolve({ id }) });
}

async function callGet(id: string, qs: string): Promise<Response> {
  const req = new NextRequest(
    `http://localhost/api/initiatives/${id}/investigate${qs}`,
  );
  return await GET(req, { params: Promise.resolve({ id }) });
}

test('GET ?dryrun=1&mode=narrow → 200 with planned_nodes=1', async () => {
  const ws = freshWorkspace();
  const i = createInitiative({ workspace_id: ws, kind: 'epic', title: 'root' });
  const res = await callGet(i.id, '?dryrun=1&mode=narrow');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'narrow');
  assert.equal(body.planned_nodes, 1);
  assert.equal(body.planned_layers, 1);
  assert.equal(body.concurrency, 1);
  assert.ok(Number.isInteger(body.per_node_timeout_ms));
});

test('GET ?dryrun=1&mode=subtree → returns layer plan from helper', async () => {
  const ws = freshWorkspace();
  const root = createInitiative({ workspace_id: ws, kind: 'epic', title: 'root' });
  const a = createInitiative({
    workspace_id: ws,
    kind: 'story',
    title: 'a',
    parent_initiative_id: root.id,
  });
  createInitiative({
    workspace_id: ws,
    kind: 'story',
    title: 'a-leaf',
    parent_initiative_id: a.id,
  });

  const res = await callGet(root.id, '?dryrun=1&mode=subtree');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.mode, 'subtree-proposal');
  assert.equal(body.planned_nodes, 3);
  assert.equal(body.planned_layers, 3);
  assert.ok(body.concurrency >= 1);
});

test('GET ?dryrun=1&mode=subtree on terminal root → 400', async () => {
  const ws = freshWorkspace();
  const i = createInitiative({ workspace_id: ws, kind: 'epic', title: 'closed' });
  updateInitiative(i.id, { status: 'done' });
  const res = await callGet(i.id, '?dryrun=1&mode=subtree');
  assert.equal(res.status, 400);
});

test('GET without ?dryrun=1 → 400', async () => {
  const ws = freshWorkspace();
  const i = createInitiative({ workspace_id: ws, kind: 'epic', title: 'x' });
  const res = await callGet(i.id, '');
  assert.equal(res.status, 400);
});

test('POST mode=subtree (legacy) → 400 with removed-mode error', async () => {
  const ws = freshWorkspace();
  const i = createInitiative({ workspace_id: ws, kind: 'epic', title: 'open' });
  const res = await callPost(i.id, { mode: 'subtree' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /mode subtree was removed/i);
  assert.match(body.error, /subtree-proposal/);
  // Reference the spec section so callers can find the rationale.
  assert.match(body.error, /§6\.3/);
});

test('POST subtree with terminal-status root → 400', async () => {
  const ws = freshWorkspace();
  const i = createInitiative({ workspace_id: ws, kind: 'epic', title: 'closed' });
  updateInitiative(i.id, { status: 'cancelled' });
  // Need a runner present so the route falls through to the
  // terminal-state check rather than 503-ing on missing runner.
  run(
    `INSERT OR REPLACE INTO agents
       (id, name, role, workspace_id, gateway_agent_id, source, created_at, updated_at)
     VALUES (?, ?, ?, 'default', 'mc-runner-dev', 'test', datetime('now'), datetime('now'))`,
    [`agent-${uuidv4().slice(0, 8)}`, 'runner', 'researcher'],
  );
  try {
    const res = await callPost(i.id, { mode: 'subtree-proposal' });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /terminal-state initiative/i);
  } finally {
    clearRunner();
  }
});

test('POST subtree with no runner registered → 503', async () => {
  const ws = freshWorkspace();
  const i = createInitiative({ workspace_id: ws, kind: 'epic', title: 'open' });
  clearRunner();
  const res = await callPost(i.id, { mode: 'subtree-proposal' });
  assert.equal(res.status, 503);
});

test('POST narrow with an in-flight initiative_audit → 409 audit_in_flight', async () => {
  const ws = freshWorkspace();
  const i = createInitiative({ workspace_id: ws, kind: 'epic', title: 'open' });

  // Insert a runner so the route doesn't 503 on us before the guard runs.
  const runnerId = `agent-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR REPLACE INTO agents
       (id, name, role, workspace_id, gateway_agent_id, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'mc-runner-dev', 'test', datetime('now'), datetime('now'))`,
    [runnerId, 'runner', 'researcher', ws],
  );

  // Simulate an existing in-flight audit row.
  const { startAgentRun } = await import('@/lib/db/agent-runs');
  const liveRunId = startAgentRun({
    workspace_id: ws,
    kind: 'initiative_audit',
    scope_key: 'agent:researcher:in-flight',
    scope_type: 'initiative_audit',
    role: 'researcher',
    agent_id: runnerId,
    initiative_id: i.id,
    run_group_id: uuidv4(),
  });

  try {
    const res = await callPost(i.id, { mode: 'narrow' });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'audit_in_flight');
    assert.ok(Array.isArray(body.in_flight));
    assert.equal(body.in_flight[0].run_id, liveRunId);
    assert.equal(body.in_flight[0].status, 'running');
  } finally {
    clearRunner();
    run(`DELETE FROM agent_runs WHERE id = ?`, [liveRunId]);
  }
});

test('POST narrow with supersede=true cancels in-flight and dispatches', async () => {
  const ws = freshWorkspace();
  const i = createInitiative({ workspace_id: ws, kind: 'epic', title: 'open' });

  const runnerId = `agent-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR REPLACE INTO agents
       (id, name, role, workspace_id, gateway_agent_id, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'mc-runner-dev', 'test', datetime('now'), datetime('now'))`,
    [runnerId, 'runner', 'researcher', ws],
  );

  const { startAgentRun, getAgentRun } = await import('@/lib/db/agent-runs');
  const liveRunId = startAgentRun({
    workspace_id: ws,
    kind: 'initiative_audit',
    scope_key: 'agent:researcher:in-flight2',
    scope_type: 'initiative_audit',
    role: 'researcher',
    agent_id: runnerId,
    initiative_id: i.id,
    run_group_id: uuidv4(),
  });

  try {
    const res = await callPost(i.id, { mode: 'narrow', supersede: true });
    // 200 because dispatch fired (background promise will fail to
    // reach the gateway but that's not on the response path).
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, 'narrow');
    // The previously in-flight run should now be cancelled.
    const after = getAgentRun(liveRunId);
    assert.equal(after!.status, 'cancelled');
  } finally {
    clearRunner();
    run(`DELETE FROM agent_runs WHERE initiative_id = ?`, [i.id]);
    run(`DELETE FROM mc_sessions WHERE initiative_id = ?`, [i.id]);
  }
});

test('POST subtree with zero non-terminal descendants → planned_nodes=1', async () => {
  const ws = freshWorkspace();
  const root = createInitiative({ workspace_id: ws, kind: 'epic', title: 'root' });
  const a = createInitiative({
    workspace_id: ws,
    kind: 'story',
    title: 'a',
    parent_initiative_id: root.id,
  });
  updateInitiative(a.id, { status: 'done' });

  // Need a runner so the route doesn't 503; the orchestration is
  // fire-and-forget so the eventual dispatchScope failure doesn't
  // affect this assertion. We DO mark the inserted agent inactive-ish
  // by giving it no real gateway prefix; the response shape still
  // resolves before the background promise touches the gateway.
  const runnerId = `agent-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR REPLACE INTO agents
       (id, name, role, workspace_id, gateway_agent_id, source, created_at, updated_at)
     VALUES (?, ?, ?, 'default', 'mc-runner-dev', 'test', datetime('now'), datetime('now'))`,
    [runnerId, 'runner', 'researcher'],
  );
  try {
    const res = await callPost(root.id, { mode: 'subtree-proposal' });
    // Drain any unhandled background rejection into a black-hole; the
    // route's `.catch` handler already swallows + logs.
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, 'subtree-proposal');
    assert.equal(body.planned_nodes, 1);
    assert.equal(body.planned_layers, 1);
    assert.ok(typeof body.root_scope_key === 'string');
    assert.ok(body.concurrency >= 1);
  } finally {
    clearRunner();
    // Best-effort: clear the row written by upsertSession for the
    // background dispatch attempt.
    run(`DELETE FROM mc_sessions WHERE initiative_id = ?`, [root.id]);
    queryOne(`SELECT 1`); // flush
  }
});
