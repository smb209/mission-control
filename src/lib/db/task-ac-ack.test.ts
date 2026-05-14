/**
 * Tests for `task-ac-ack` helpers + the `transitionTaskStatus` AC gate.
 *
 * The AC gate is the load-bearing piece of slice 5/7 of the PM convoy
 * mandate: a parent task with a done convoy that carries feature-level
 * acceptance criteria cannot leave `review` for `done` until each AC has
 * been explicitly acknowledged (with an optional free-text rationale).
 *
 * Convoy seeding here uses the minimum subset of columns needed to satisfy
 * the queries the helpers run. The full apply-pass shape is covered in
 * `src/lib/db/apply-convoy-diff.test.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { queryOne, run } from '@/lib/db';
import {
  acknowledgeAc,
  getParentConvoyAcs,
  missingAcAcknowledgements,
  unacknowledgeAc,
} from './task-ac-ack';
import { transitionTaskStatus } from '@/lib/services/task-status';

function seedParentTask(opts: { status?: string; agent?: string | null } = {}): string {
  const id = `t-${crypto.randomUUID()}`;
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at)
     VALUES (?, 'Parent', ?, 'normal', 'default', 'default', ?, datetime('now'), datetime('now'))`,
    [id, opts.status ?? 'review', opts.agent ?? null],
  );
  return id;
}

function seedConvoy(opts: {
  parentTaskId: string;
  acceptanceCriteria: string[] | null;
  status?: 'active' | 'done' | 'paused';
}): string {
  const id = `c-${crypto.randomUUID()}`;
  const ac = opts.acceptanceCriteria ? JSON.stringify(opts.acceptanceCriteria) : null;
  run(
    `INSERT INTO convoys (id, parent_task_id, name, status, total_subtasks, completed_subtasks, decomposition_strategy, created_at, updated_at, acceptance_criteria)
     VALUES (?, ?, 'C', ?, 0, 0, 'manual', datetime('now'), datetime('now'), ?)`,
    [id, opts.parentTaskId, opts.status ?? 'done', ac],
  );
  return id;
}

// ─── getParentConvoyAcs ────────────────────────────────────────────────

test('getParentConvoyAcs: returns null when task has no convoy', () => {
  const task = seedParentTask();
  assert.equal(getParentConvoyAcs(task), null);
});

test('getParentConvoyAcs: returns null when convoy has no ACs (coordinator-spawned)', () => {
  const task = seedParentTask();
  seedConvoy({ parentTaskId: task, acceptanceCriteria: null });
  assert.equal(getParentConvoyAcs(task), null);
});

test('getParentConvoyAcs: returns null when convoy is not yet done (still active)', () => {
  const task = seedParentTask();
  seedConvoy({
    parentTaskId: task,
    acceptanceCriteria: ['AC0', 'AC1'],
    status: 'active',
  });
  assert.equal(getParentConvoyAcs(task), null);
});

test('getParentConvoyAcs: returns unacked entries when ACs exist but no acks recorded', () => {
  const task = seedParentTask();
  seedConvoy({ parentTaskId: task, acceptanceCriteria: ['AC0', 'AC1'] });
  const acs = getParentConvoyAcs(task);
  assert.ok(acs);
  assert.equal(acs!.length, 2);
  assert.equal(acs![0].ac_index, 0);
  assert.equal(acs![0].ac_text, 'AC0');
  assert.equal(acs![0].acknowledged, false);
  assert.equal(acs![1].acknowledged, false);
});

test('getParentConvoyAcs: reflects partial acknowledgement', () => {
  const task = seedParentTask();
  seedConvoy({ parentTaskId: task, acceptanceCriteria: ['AC0', 'AC1'] });
  acknowledgeAc(task, 0, { rationale: 'looked at output' });
  const acs = getParentConvoyAcs(task);
  assert.ok(acs);
  assert.equal(acs![0].acknowledged, true);
  assert.equal(acs![0].rationale, 'looked at output');
  assert.equal(acs![1].acknowledged, false);
});

// ─── acknowledgeAc / unacknowledgeAc ──────────────────────────────────

test('acknowledgeAc + unacknowledgeAc round-trip', () => {
  const task = seedParentTask();
  seedConvoy({ parentTaskId: task, acceptanceCriteria: ['AC0'] });
  acknowledgeAc(task, 0, { rationale: 'r1' });
  let acs = getParentConvoyAcs(task);
  assert.equal(acs![0].acknowledged, true);
  unacknowledgeAc(task, 0);
  acs = getParentConvoyAcs(task);
  assert.equal(acs![0].acknowledged, false);
});

test('acknowledgeAc is idempotent (upsert) — second call replaces rationale', () => {
  const task = seedParentTask();
  seedConvoy({ parentTaskId: task, acceptanceCriteria: ['AC0'] });
  acknowledgeAc(task, 0, { rationale: 'first' });
  acknowledgeAc(task, 0, { rationale: 'second' });
  const acs = getParentConvoyAcs(task);
  assert.equal(acs![0].acknowledged, true);
  assert.equal(acs![0].rationale, 'second');
});

test('acknowledgeAc rejects out-of-range index', () => {
  const task = seedParentTask();
  seedConvoy({ parentTaskId: task, acceptanceCriteria: ['AC0'] });
  assert.throws(() => acknowledgeAc(task, 5));
});

test('acknowledgeAc rejects when convoy has no ACs', () => {
  const task = seedParentTask();
  seedConvoy({ parentTaskId: task, acceptanceCriteria: null });
  assert.throws(() => acknowledgeAc(task, 0));
});

// ─── missingAcAcknowledgements ────────────────────────────────────────

test('missingAcAcknowledgements: reports all indices when nothing acked', () => {
  const task = seedParentTask();
  seedConvoy({ parentTaskId: task, acceptanceCriteria: ['A', 'B', 'C'] });
  const r = missingAcAcknowledgements(task);
  assert.deepEqual(r!.missing_indices, [0, 1, 2]);
  assert.deepEqual(r!.acceptance_criteria, ['A', 'B', 'C']);
});

test('missingAcAcknowledgements: returns null when no ACs', () => {
  const task = seedParentTask();
  seedConvoy({ parentTaskId: task, acceptanceCriteria: null });
  assert.equal(missingAcAcknowledgements(task), null);
});

// ─── transitionTaskStatus AC gate ─────────────────────────────────────

function seedDoneEvidence(taskId: string): void {
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, role, created_at)
     VALUES (?, ?, 'file', 'x', 'output', datetime('now'))`,
    [crypto.randomUUID(), taskId],
  );
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (?, ?, 'completed', 'done', datetime('now'))`,
    [crypto.randomUUID(), taskId],
  );
}

test('transitionTaskStatus: review → done blocked when convoy ACs are unacknowledged', () => {
  const task = seedParentTask({ status: 'review' });
  seedConvoy({ parentTaskId: task, acceptanceCriteria: ['AC0', 'AC1'] });
  seedDoneEvidence(task);
  const result = transitionTaskStatus({
    taskId: task,
    actingAgentId: null,
    newStatus: 'done',
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'parent_ac_check_pending');
    assert.deepEqual(result.missingAcIndices, [0, 1]);
    assert.deepEqual(result.acceptanceCriteria, ['AC0', 'AC1']);
  }
  // Task did not transition.
  const after = queryOne<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [task]);
  assert.equal(after!.status, 'review');
});

test('transitionTaskStatus: review → done succeeds once all ACs acked', () => {
  const task = seedParentTask({ status: 'review' });
  seedConvoy({ parentTaskId: task, acceptanceCriteria: ['AC0', 'AC1'] });
  seedDoneEvidence(task);
  acknowledgeAc(task, 0, { rationale: 'verified manually' });
  acknowledgeAc(task, 1, { rationale: 'see deliverable doc' });
  const result = transitionTaskStatus({
    taskId: task,
    actingAgentId: null,
    newStatus: 'done',
  });
  assert.equal(result.ok, true);
  const after = queryOne<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [task]);
  assert.equal(after!.status, 'done');
});

test('transitionTaskStatus: review → done bypassed by board_override even with unacked ACs', () => {
  const task = seedParentTask({ status: 'review' });
  seedConvoy({ parentTaskId: task, acceptanceCriteria: ['AC0', 'AC1'] });
  seedDoneEvidence(task);
  const result = transitionTaskStatus({
    taskId: task,
    actingAgentId: null,
    newStatus: 'done',
    boardOverride: true,
    boardOverrideReason: 'shipped behind a flag, verify post-merge',
  });
  assert.equal(result.ok, true);
  const after = queryOne<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, [task]);
  assert.equal(after!.status, 'done');
});

test('transitionTaskStatus: review → done is NOT gated when convoy has no ACs (back-compat)', () => {
  const task = seedParentTask({ status: 'review' });
  seedConvoy({ parentTaskId: task, acceptanceCriteria: null });
  seedDoneEvidence(task);
  const result = transitionTaskStatus({
    taskId: task,
    actingAgentId: null,
    newStatus: 'done',
  });
  assert.equal(result.ok, true);
});

test('transitionTaskStatus: review → done is NOT gated when task has no convoy at all', () => {
  const task = seedParentTask({ status: 'review' });
  seedDoneEvidence(task);
  const result = transitionTaskStatus({
    taskId: task,
    actingAgentId: null,
    newStatus: 'done',
  });
  assert.equal(result.ok, true);
});
