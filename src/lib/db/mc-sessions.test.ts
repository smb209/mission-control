/**
 * mc_sessions bookkeeping helper tests.
 *
 * Covers upsert (insert vs touch), is_new flag semantics,
 * setSessionStatus with closed/failed setting closed_at, status
 * recovery on touch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import {
  getSession,
  setSessionStatus,
  touchSession,
  upsertSession,
} from './mc-sessions';

function freshWorkspace(): string {
  const id = `ws-mc-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

test('upsertSession: first call inserts and reports is_new=true', () => {
  const ws = freshWorkspace();
  const result = upsertSession({
    scope_key: 'agent:mc-runner-dev:ws:test-1',
    workspace_id: ws,
    role: 'builder',
    scope_type: 'task_role',
  });
  assert.equal(result.is_new, true);
  assert.equal(result.session.scope_key, 'agent:mc-runner-dev:ws:test-1');
  assert.equal(result.session.workspace_id, ws);
  assert.equal(result.session.role, 'builder');
  assert.equal(result.session.scope_type, 'task_role');
  assert.equal(result.session.status, 'active');
  assert.equal(result.session.closed_at, null);
});

test('upsertSession: second call on same key reports is_new=false (resume)', () => {
  const ws = freshWorkspace();
  const key = `agent:mc-runner-dev:ws:resume-${uuidv4().slice(0, 6)}`;
  upsertSession({
    scope_key: key,
    workspace_id: ws,
    role: 'pm',
    scope_type: 'pm_chat',
  });
  const second = upsertSession({
    scope_key: key,
    workspace_id: ws,
    role: 'pm',
    scope_type: 'pm_chat',
  });
  assert.equal(second.is_new, false);
});

test('upsertSession: re-touch flips closed back to active and clears closed_at', () => {
  const ws = freshWorkspace();
  const key = `agent:mc-runner-dev:ws:revive-${uuidv4().slice(0, 6)}`;
  upsertSession({
    scope_key: key,
    workspace_id: ws,
    role: 'researcher',
    scope_type: 'recurring',
  });
  setSessionStatus(key, 'closed');
  const closed = getSession(key);
  assert.equal(closed?.status, 'closed');
  assert.ok(closed?.closed_at);

  upsertSession({
    scope_key: key,
    workspace_id: ws,
    role: 'researcher',
    scope_type: 'recurring',
  });
  const revived = getSession(key);
  assert.equal(revived?.status, 'active');
  assert.equal(revived?.closed_at, null);
});

test('setSessionStatus: failed sets closed_at; idle does not', () => {
  const ws = freshWorkspace();
  const key = `agent:mc-runner-dev:ws:status-${uuidv4().slice(0, 6)}`;
  upsertSession({
    scope_key: key,
    workspace_id: ws,
    role: 'tester',
    scope_type: 'task_role',
  });
  const failed = setSessionStatus(key, 'failed');
  assert.equal(failed?.status, 'failed');
  assert.ok(failed?.closed_at);

  // Set back to idle — closed_at clears.
  const idle = setSessionStatus(key, 'idle');
  assert.equal(idle?.status, 'idle');
  assert.equal(idle?.closed_at, null);
});

test('touchSession: bumps last_used_at without status change', async () => {
  const ws = freshWorkspace();
  const key = `agent:mc-runner-dev:ws:touch-${uuidv4().slice(0, 6)}`;
  upsertSession({
    scope_key: key,
    workspace_id: ws,
    role: 'pm',
    scope_type: 'pm_chat',
  });
  const before = getSession(key);
  // SQLite datetime('now') is second-resolution; sleep enough to see a delta.
  await new Promise((res) => setTimeout(res, 1100));
  touchSession(key);
  const after = getSession(key);
  assert.equal(after?.status, 'active');
  assert.notEqual(before?.last_used_at, after?.last_used_at);
});

test('upsertSession: workspace cascade deletes the session row', () => {
  const ws = freshWorkspace();
  const key = `agent:mc-runner-dev:ws:cascade-${uuidv4().slice(0, 6)}`;
  upsertSession({
    scope_key: key,
    workspace_id: ws,
    role: 'pm',
    scope_type: 'pm_chat',
  });
  assert.ok(getSession(key));

  run(`DELETE FROM workspaces WHERE id = ?`, [ws]);
  assert.equal(getSession(key), null);
});
