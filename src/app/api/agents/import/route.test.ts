/**
 * /api/agents/import — defensive validation tests.
 *
 * Covers:
 *   - empty agents array → 400
 *   - missing gateway_agent_id / name → 400
 *   - unknown workspace_id → 400 (workspace_not_found), NOT 500
 *     (the FK violation that Phase I-fix is preventing)
 *   - mixed valid + unknown workspace_id → 400, no partial inserts
 *   - happy path (existing default workspace) → 201
 *   - already-imported (catalog-sync row exists) → 201, skipped
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { queryAll, run } from '@/lib/db';

function postReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/agents/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function freshWorkspace(): string {
  const id = `ws-imp-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

test('POST /api/agents/import: empty agents array → 400', async () => {
  const res = await POST(postReq({ agents: [] }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /At least one agent is required/);
});

test('POST /api/agents/import: missing gateway_agent_id → 400', async () => {
  const res = await POST(postReq({
    agents: [{ name: 'Bob' }],
  }));
  assert.equal(res.status, 400);
});

test('POST /api/agents/import: unknown workspace_id → 400 with workspace_not_found, NOT 500', async () => {
  // The headline regression: a stale localStorage workspace id
  // (deleted workspace) used to trigger SQLITE_CONSTRAINT_FOREIGNKEY
  // and return an opaque 500. Now: clean 400 with the missing id
  // surfaced.
  const ghostId = `ws-ghost-${uuidv4().slice(0, 8)}`;
  const res = await POST(postReq({
    agents: [
      {
        gateway_agent_id: 'mc-pm-foo-dev',
        name: 'MC PM (foo / dev)',
        workspace_id: ghostId,
      },
    ],
  }));
  assert.equal(res.status, 400, 'must be 400, not 500');
  const body = await res.json();
  assert.equal(body.error, 'workspace_not_found');
  assert.deepEqual(body.missing_workspace_ids, [ghostId]);
  // No agent row should have been created.
  const agents = queryAll<{ id: string }>(
    `SELECT id FROM agents WHERE workspace_id = ?`,
    [ghostId],
  );
  assert.equal(agents.length, 0);
});

test('POST /api/agents/import: mixed valid + unknown workspace_id → 400, no partial inserts', async () => {
  const ws = freshWorkspace();
  const ghostId = `ws-ghost-${uuidv4().slice(0, 8)}`;
  const res = await POST(postReq({
    agents: [
      {
        gateway_agent_id: 'mc-pm-good-dev',
        name: 'MC PM (good / dev)',
        workspace_id: ws,
      },
      {
        gateway_agent_id: 'mc-pm-bad-dev',
        name: 'MC PM (bad / dev)',
        workspace_id: ghostId,
      },
    ],
  }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'workspace_not_found');
  // Atomic: the good workspace's agent should also NOT exist (we
  // bail before any insert when ANY workspace is unknown).
  const goodRows = queryAll<{ id: string }>(
    `SELECT id FROM agents WHERE workspace_id = ? AND gateway_agent_id = ?`,
    [ws, 'mc-pm-good-dev'],
  );
  assert.equal(goodRows.length, 0, 'must not partially insert when any workspace is invalid');
});

test('POST /api/agents/import: happy path → 201, agent row created', async () => {
  const ws = freshWorkspace();
  const gatewayId = `mc-pm-${uuidv4().slice(0, 6)}-dev`;
  const res = await POST(postReq({
    agents: [
      {
        gateway_agent_id: gatewayId,
        name: 'MC PM test',
        model: 'spark-lb/agent',
        workspace_id: ws,
      },
    ],
  }));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.imported.length, 1);
  assert.equal(body.skipped.length, 0);
  assert.equal(body.imported[0].gateway_agent_id, gatewayId);
});

test('POST /api/agents/import: already-imported in same workspace → 201 with skipped', async () => {
  const ws = freshWorkspace();
  const gatewayId = `mc-pm-${uuidv4().slice(0, 6)}-dev`;
  // Pre-seed the row (simulating catalog-sync having inserted it).
  run(
    `INSERT INTO agents (id, name, role, workspace_id, gateway_agent_id, source, created_at, updated_at)
     VALUES (?, 'pre-existing', 'pm', ?, ?, 'gateway', datetime('now'), datetime('now'))`,
    [uuidv4(), ws, gatewayId],
  );
  const res = await POST(postReq({
    agents: [
      {
        gateway_agent_id: gatewayId,
        name: 'MC PM test',
        workspace_id: ws,
      },
    ],
  }));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.imported.length, 0);
  assert.equal(body.skipped.length, 1);
  assert.equal(body.skipped[0].gateway_agent_id, gatewayId);
  assert.equal(body.skipped[0].reason, 'Already imported');
});

test('POST /api/agents/import: workspace_id defaults to "default" when omitted', async () => {
  // The default workspace always exists in the seeded DB.
  const gatewayId = `mc-pm-${uuidv4().slice(0, 6)}-dev`;
  const res = await POST(postReq({
    agents: [{ gateway_agent_id: gatewayId, name: 'MC PM' }],
  }));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.imported.length, 1);
  assert.equal(body.imported[0].workspace_id, 'default');
});
