/**
 * Tests for the capability-denial soft-lock (Slice 3 of review-stage-robustness).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run, queryOne } from '@/lib/db';
import {
  assertAgentCanActOnTask,
  AuthzError,
  setTaskCompletionLock,
  clearTaskCompletionLock,
  isTaskCompletionLocked,
} from './agent-task';

function seedAgent(opts: { id?: string; role?: string } = {}): string {
  const id = opts.id ?? crypto.randomUUID();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_active, created_at, updated_at)
     VALUES (?, 'A', ?, 'default', 1, datetime('now'), datetime('now'))`,
    [id, opts.role ?? 'builder'],
  );
  return id;
}

function seedTask(opts: { assigned?: string; status?: string } = {}): string {
  const id = crypto.randomUUID();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at)
     VALUES (?, 'T', ?, 'normal', 'default', 'default', ?, datetime('now'), datetime('now'))`,
    [id, opts.status ?? 'in_progress', opts.assigned ?? null],
  );
  return id;
}

test('setTaskCompletionLock + isTaskCompletionLocked round-trip', () => {
  const task = seedTask();
  assert.equal(isTaskCompletionLocked(task), false);
  setTaskCompletionLock(task, 'agent_not_coordinator');
  assert.equal(isTaskCompletionLocked(task), true);
  clearTaskCompletionLock(task);
  assert.equal(isTaskCompletionLocked(task), false);
});

test('locked task: assigned agent rejected on `status` action with task_locked_pending_escalation', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  setTaskCompletionLock(task, 'agent_not_coordinator');
  assert.throws(
    () => assertAgentCanActOnTask(agent, task, 'status'),
    (err: unknown) => err instanceof AuthzError && err.code === 'task_locked_pending_escalation',
  );
});

test('locked task: assigned agent rejected on `deliverable` action', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  setTaskCompletionLock(task, 'r');
  assert.throws(
    () => assertAgentCanActOnTask(agent, task, 'deliverable'),
    (err: unknown) => err instanceof AuthzError && err.code === 'task_locked_pending_escalation',
  );
});

test('locked task: assigned agent rejected on `activity` and `checkpoint` and `fail` actions', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  setTaskCompletionLock(task, 'r');
  for (const action of ['activity', 'checkpoint', 'fail'] as const) {
    assert.throws(
      () => assertAgentCanActOnTask(agent, task, action),
      (err: unknown) => err instanceof AuthzError && err.code === 'task_locked_pending_escalation',
      `action ${action} should be blocked`,
    );
  }
});

test('locked task: read action still permitted (escape hatch must be reachable)', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  setTaskCompletionLock(task, 'r');
  // Read should NOT throw a lock error (might still throw other things,
  // but the lock check should pass).
  assertAgentCanActOnTask(agent, task, 'read');
});

test('locked task: coordinator can still act on locked task (acknowledgment path)', () => {
  const coordinator = seedAgent({ role: 'coordinator' });
  // Coordinator is recorded via task_roles row.
  const task = seedTask();
  run(
    `INSERT INTO task_roles (id, task_id, role, agent_id, created_at)
     VALUES (?, ?, 'coordinator', ?, datetime('now'))`,
    [crypto.randomUUID(), task, coordinator],
  );
  setTaskCompletionLock(task, 'r');
  // No throw — coordinator bypasses the soft-lock.
  assertAgentCanActOnTask(coordinator, task, 'status');
});

test('clearTaskCompletionLock allows the agent to act again', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  setTaskCompletionLock(task, 'r');
  assert.throws(() => assertAgentCanActOnTask(agent, task, 'status'));
  clearTaskCompletionLock(task);
  assertAgentCanActOnTask(agent, task, 'status'); // no throw
});

test('locked-flag column persists across queries', () => {
  const task = seedTask();
  setTaskCompletionLock(task, 'r');
  const row = queryOne<{ locked_for_completion: number }>(
    'SELECT locked_for_completion FROM tasks WHERE id = ?',
    [task],
  );
  assert.equal(row?.locked_for_completion, 1);
});
