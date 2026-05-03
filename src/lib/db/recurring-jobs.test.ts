/**
 * recurring_jobs DAO tests.
 *
 * Covers create/get/list/listDue/markRunSuccess/markRunFailure/
 * setStatus/renderScopeKey, validation, pause-after-3-failures,
 * cadence advancement.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import {
  createRecurringJob,
  getRecurringJob,
  listDueJobs,
  listForTask,
  listForWorkspace,
  markRunFailure,
  markRunSuccess,
  RecurringJobValidationError,
  renderScopeKey,
  setJobStatus,
} from './recurring-jobs';

function freshWorkspace(): string {
  const id = `ws-rj-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

const baseInput = (workspaceId: string, overrides: Partial<Parameters<typeof createRecurringJob>[0]> = {}) => ({
  workspace_id: workspaceId,
  name: 'Watch DGX Spark forum',
  role: 'researcher',
  scope_key_template: 'agent:mc-runner-dev:main:ws-{wsid}:recurring-{job_id}',
  briefing_template: 'Check the forum for new posts since last run.',
  cadence_seconds: 60,
  ...overrides,
});

test('createRecurringJob: round-trip', () => {
  const ws = freshWorkspace();
  const job = createRecurringJob(baseInput(ws));
  assert.equal(job.workspace_id, ws);
  assert.equal(job.role, 'researcher');
  assert.equal(job.cadence_seconds, 60);
  assert.equal(job.status, 'active');
  assert.equal(job.attempt_strategy, 'reuse');
  assert.equal(job.run_count, 0);
  assert.equal(job.consecutive_failures, 0);
  assert.ok(job.next_run_at);
});

test('createRecurringJob: rejects bad inputs', () => {
  const ws = freshWorkspace();
  assert.throws(
    () => createRecurringJob(baseInput(ws, { cadence_seconds: 0 })),
    RecurringJobValidationError,
  );
  assert.throws(
    () => createRecurringJob(baseInput(ws, { name: '   ' })),
    RecurringJobValidationError,
  );
  assert.throws(
    () => createRecurringJob(baseInput(ws, { briefing_template: '' })),
    RecurringJobValidationError,
  );
  assert.throws(
    () => createRecurringJob(baseInput(ws, { scope_key_template: 'no-substitutions-here' })),
    RecurringJobValidationError,
  );
});

test('listDueJobs: returns only active jobs whose next_run_at has elapsed', async () => {
  const ws = freshWorkspace();
  const past = createRecurringJob(
    baseInput(ws, {
      first_run_at: new Date(Date.now() - 5_000).toISOString(),
    }),
  );
  const future = createRecurringJob(
    baseInput(ws, {
      first_run_at: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  const paused = createRecurringJob(
    baseInput(ws, {
      first_run_at: new Date(Date.now() - 5_000).toISOString(),
    }),
  );
  setJobStatus(paused.id, 'paused');

  const due = listDueJobs();
  const dueIds = new Set(due.map((j) => j.id));
  assert.ok(dueIds.has(past.id));
  assert.equal(dueIds.has(future.id), false);
  assert.equal(dueIds.has(paused.id), false);
});

test('markRunSuccess: bumps run_count, advances next_run_at, clears failures', () => {
  const ws = freshWorkspace();
  const job = createRecurringJob(baseInput(ws, { cadence_seconds: 60 }));
  // Simulate two prior failures.
  markRunFailure(job.id);
  markRunFailure(job.id);
  const before = getRecurringJob(job.id)!;
  assert.equal(before.consecutive_failures, 2);

  const after = markRunSuccess(job.id, 'agent:mc-runner-dev:main:abc');
  assert.equal(after?.run_count, 1);
  assert.equal(after?.consecutive_failures, 0);
  assert.equal(after?.last_run_scope_key, 'agent:mc-runner-dev:main:abc');
  // next_run_at advanced by approximately cadence_seconds from now.
  const nextMs = new Date(after!.next_run_at).getTime();
  const nowMs = Date.now();
  assert.ok(nextMs >= nowMs + 50_000 && nextMs <= nowMs + 70_000,
    `next_run_at not advanced by cadence: delta=${nextMs - nowMs}`);
});

test('markRunFailure: pauses after threshold', () => {
  const ws = freshWorkspace();
  const job = createRecurringJob(baseInput(ws));
  for (let i = 0; i < 2; i++) markRunFailure(job.id);
  assert.equal(getRecurringJob(job.id)?.status, 'active');
  assert.equal(getRecurringJob(job.id)?.consecutive_failures, 2);

  const after = markRunFailure(job.id);
  assert.equal(after?.status, 'paused');
  assert.equal(after?.consecutive_failures, 3);
});

test('renderScopeKey: substitutes wsid and job_id', () => {
  const ws = freshWorkspace();
  const job = createRecurringJob(baseInput(ws));
  const rendered = renderScopeKey(job);
  assert.match(rendered, new RegExp(`ws-${ws}`));
  assert.match(rendered, new RegExp(`recurring-${job.id}`));
});

test('listForWorkspace: filters by status', () => {
  const ws = freshWorkspace();
  const a = createRecurringJob(baseInput(ws, { name: 'a' }));
  const b = createRecurringJob(baseInput(ws, { name: 'b' }));
  setJobStatus(b.id, 'paused');

  const active = listForWorkspace(ws, { status: 'active' });
  const paused = listForWorkspace(ws, { status: 'paused' });
  assert.equal(active.length, 1);
  assert.equal(active[0].id, a.id);
  assert.equal(paused.length, 1);
  assert.equal(paused[0].id, b.id);
});

test('workspace cascade deletes recurring_jobs', () => {
  const ws = freshWorkspace();
  createRecurringJob(baseInput(ws));
  createRecurringJob(baseInput(ws, { name: 'b' }));
  assert.equal(listForWorkspace(ws).length, 2);

  run(`DELETE FROM workspaces WHERE id = ?`, [ws]);
  assert.equal(listForWorkspace(ws).length, 0);
});

test('listForTask: returns jobs scoped to a task', () => {
  const ws = freshWorkspace();
  const taskId = uuidv4();
  run(
    `INSERT OR IGNORE INTO tasks (id, workspace_id, title, status, created_at, updated_at)
     VALUES (?, ?, 'seed', 'inbox', datetime('now'), datetime('now'))`,
    [taskId, ws],
  );
  const a = createRecurringJob(baseInput(ws, { task_id: taskId, name: 'task-a' }));
  createRecurringJob(baseInput(ws, { name: 'workspace-only' }));

  const taskJobs = listForTask(taskId);
  assert.equal(taskJobs.length, 1);
  assert.equal(taskJobs[0].id, a.id);
});
