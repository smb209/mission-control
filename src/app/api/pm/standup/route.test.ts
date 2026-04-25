/**
 * POST /api/pm/standup route test (Phase 6).
 *
 * Calls the route handler directly with a constructed NextRequest. Avoids
 * spinning up Next.js — the route is a thin wrapper over generateStandup,
 * so unit-testing the wrapper itself is enough.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { run } from '@/lib/db';
import { ensurePmAgent } from '@/lib/bootstrap-agents';
import { createInitiative } from '@/lib/db/initiatives';

function freshWorkspace(): string {
  const id = `ws-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  ensurePmAgent(id);
  return id;
}

function postJson(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/pm/standup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST /api/pm/standup: missing workspace_id → 400', async () => {
  const res = await POST(postJson({}));
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(data.error);
});

test('POST /api/pm/standup: no drift → returns skipped: true', async () => {
  const ws = freshWorkspace();
  // Healthy workspace — pre-emptive milestone with no slip.
  createInitiative({
    workspace_id: ws,
    kind: 'milestone',
    title: 'Future milestone',
    committed_end: '2027-12-31',
  });

  const res = await POST(postJson({ workspace_id: ws, derive_first: false }));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.skipped, true);
  assert.equal(data.proposal, null);
  assert.equal(data.reason, 'no_drift');
});

test('POST /api/pm/standup: drift present → 201 with proposal', async () => {
  const ws = freshWorkspace();
  const owner = uuidv4();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_active, created_at, updated_at)
     VALUES (?, 'Owen', 'worker', ?, 1, datetime('now'), datetime('now'))`,
    [owner, ws],
  );
  const m = createInitiative({
    workspace_id: ws,
    kind: 'milestone',
    title: 'Past commit',
    committed_end: '2024-01-01',
    owner_agent_id: owner,
  });
  createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Heavy work',
    parent_initiative_id: m.id,
    owner_agent_id: owner,
    estimated_effort_hours: 100,
    target_start: '2024-01-01',
  });

  const res = await POST(postJson({ workspace_id: ws, derive_first: false }));
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.ok(data.proposal);
  assert.equal(data.proposal.status, 'draft');
  assert.equal(data.proposal.trigger_kind, 'scheduled_drift_scan');
  assert.ok(data.drift_count > 0);
});

test('POST /api/pm/standup: force=true bypasses idempotency', async () => {
  const ws = freshWorkspace();
  const owner = uuidv4();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_active, created_at, updated_at)
     VALUES (?, 'P', 'worker', ?, 1, datetime('now'), datetime('now'))`,
    [owner, ws],
  );
  const m = createInitiative({
    workspace_id: ws,
    kind: 'milestone',
    title: 'Past commit',
    committed_end: '2024-01-01',
    owner_agent_id: owner,
  });
  createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Heavy work',
    parent_initiative_id: m.id,
    owner_agent_id: owner,
    estimated_effort_hours: 100,
    target_start: '2024-01-01',
  });

  const r1 = await (await POST(postJson({ workspace_id: ws, derive_first: false }))).json();
  // Second WITHOUT force should return the same proposal (already_today).
  const r2 = await (await POST(postJson({ workspace_id: ws, derive_first: false }))).json();
  assert.equal(r2.skipped, true);
  assert.equal(r2.reason, 'already_today');
  // Third WITH force creates a new one.
  const r3 = await (await POST(postJson({ workspace_id: ws, derive_first: false, force: true }))).json();
  assert.ok(r3.proposal);
  assert.notEqual(r3.proposal.id, r1.proposal.id);
});
