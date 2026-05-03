/**
 * Heartbeat coordinator opt-in tests.
 *
 * Covers ensureHeartbeatJob with various coordinator_mode resolutions,
 * idempotency, and closeHeartbeatJobsForTask on terminal status.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import {
  closeHeartbeatJobsForTask,
  countActiveHeartbeats,
  effectiveCoordinatorMode,
  ensureHeartbeatJob,
  getHeartbeatJobForTask,
} from './heartbeat-coordinator';

function freshWorkspace(opts: {
  coordinator_mode?: 'off' | 'reactive' | 'heartbeat';
  coordinator_heartbeat_seconds?: number;
} = {}): string {
  const id = `ws-hb-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, coordinator_mode, coordinator_heartbeat_seconds, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [id, id, id, opts.coordinator_mode ?? 'reactive', opts.coordinator_heartbeat_seconds ?? 1800],
  );
  return id;
}

function freshTask(workspaceId: string, opts: { coordinator_mode?: 'off' | 'reactive' | 'heartbeat' | null } = {}): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, workspace_id, title, status, coordinator_mode, created_at, updated_at)
     VALUES (?, ?, 'test task', 'inbox', ?, datetime('now'), datetime('now'))`,
    [id, workspaceId, opts.coordinator_mode === undefined ? null : opts.coordinator_mode],
  );
  return id;
}

test('effectiveCoordinatorMode: per-task override wins', () => {
  const ws = freshWorkspace({ coordinator_mode: 'reactive' });
  const taskId = freshTask(ws, { coordinator_mode: 'heartbeat' });
  const cm = effectiveCoordinatorMode(taskId);
  assert.equal(cm?.mode, 'heartbeat');
});

test('effectiveCoordinatorMode: NULL task inherits workspace', () => {
  const ws = freshWorkspace({ coordinator_mode: 'heartbeat', coordinator_heartbeat_seconds: 90 });
  const taskId = freshTask(ws);
  const cm = effectiveCoordinatorMode(taskId);
  assert.equal(cm?.mode, 'heartbeat');
  assert.equal(cm?.heartbeat_seconds, 90);
});

test('ensureHeartbeatJob: creates exactly one job for heartbeat-mode task', () => {
  const ws = freshWorkspace({ coordinator_mode: 'heartbeat' });
  const taskId = freshTask(ws);
  const first = ensureHeartbeatJob(taskId);
  assert.ok(first);
  assert.equal(first?.created, true);

  const second = ensureHeartbeatJob(taskId);
  assert.ok(second);
  assert.equal(second?.created, false);
  assert.equal(second?.id, first?.id);

  const job = getHeartbeatJobForTask(taskId);
  assert.equal(job?.role, 'coordinator');
  assert.equal(job?.attempt_strategy, 'reuse');
  assert.match(job?.scope_key_template ?? '', /:heartbeat$/);
});

test('ensureHeartbeatJob: returns null when mode is off or reactive', () => {
  const wsReactive = freshWorkspace({ coordinator_mode: 'reactive' });
  const taskReactive = freshTask(wsReactive);
  assert.equal(ensureHeartbeatJob(taskReactive), null);

  const wsOff = freshWorkspace({ coordinator_mode: 'off' });
  const taskOff = freshTask(wsOff);
  assert.equal(ensureHeartbeatJob(taskOff), null);
});

test('closeHeartbeatJobsForTask: marks done', () => {
  const ws = freshWorkspace({ coordinator_mode: 'heartbeat' });
  const taskId = freshTask(ws);
  ensureHeartbeatJob(taskId);
  const before = countActiveHeartbeats();
  assert.ok(before >= 1);

  const closed = closeHeartbeatJobsForTask(taskId);
  assert.equal(closed, 1);
  const job = getHeartbeatJobForTask(taskId);
  assert.equal(job?.status, 'done');

  // Idempotent — second close is a no-op.
  const closedAgain = closeHeartbeatJobsForTask(taskId);
  assert.equal(closedAgain, 0);
});

test('ensureHeartbeatJob: re-activates a paused job rather than creating a duplicate', () => {
  const ws = freshWorkspace({ coordinator_mode: 'heartbeat' });
  const taskId = freshTask(ws);
  const first = ensureHeartbeatJob(taskId);
  assert.ok(first);

  // Manually pause via DB.
  run(`UPDATE recurring_jobs SET status = 'paused' WHERE id = ?`, [first!.id]);

  const second = ensureHeartbeatJob(taskId);
  assert.equal(second?.id, first?.id);
  const job = getHeartbeatJobForTask(taskId);
  assert.equal(job?.status, 'active');
});
