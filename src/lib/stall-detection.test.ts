/**
 * Tests for the review-stage SLA scanner (Slice 4 of review-stage-robustness).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run, queryOne } from '@/lib/db';
import { scanStalledTasks } from './stall-detection';

function setEnv(key: string, value: string | undefined): () => void {
  const prior = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return () => {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  };
}

function seedAgent(role = 'reviewer'): string {
  const id = crypto.randomUUID();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_active, status, created_at, updated_at)
     VALUES (?, 'A', ?, 'default', 1, 'standby', datetime('now'), datetime('now'))`,
    [id, role],
  );
  return id;
}

function seedReviewTask(opts: {
  reviewer?: string | null;
  idleMinutes?: number;
  assigned?: string | null;
} = {}): string {
  const id = crypto.randomUUID();
  // Backdate updated_at and an activity so the scanner sees the task as idle.
  const idleMs = (opts.idleMinutes ?? 0) * 60_000;
  const past = new Date(Date.now() - idleMs).toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at)
     VALUES (?, 'review-task', 'review', 'normal', 'default', 'default', ?, ?, ?)`,
    [id, opts.assigned ?? null, past, past],
  );
  // Output deliverable so the legacy scanner skips it (review-stage tasks
  // always have deliverables — that's how they got to review).
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, role, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'file', 'x', 'output', ?)`,
    [id, past],
  );
  // Status_changed activity so last_activity_at reflects the idle window.
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'status_changed', 'entered review', ?)`,
    [id, past],
  );
  if (opts.reviewer) {
    run(
      `INSERT INTO task_roles (id, task_id, role, agent_id, created_at)
       VALUES (?, ?, 'reviewer', ?, datetime('now'))`,
      [crypto.randomUUID(), id, opts.reviewer],
    );
  }
  return id;
}

test('review-SLA: idle past 1× threshold writes reviewer_stalled activity (no autobounce)', async () => {
  const restore = setEnv('STALL_DETECTION_MINUTES_REVIEW', '5');
  const restoreBounce = setEnv('MC_REVIEW_AUTOBOUNCE', undefined);
  try {
    const reviewer = seedAgent('reviewer');
    const task = seedReviewTask({ reviewer, idleMinutes: 7 });

    await scanStalledTasks();

    const stalledRow = queryOne<{ activity_type: string }>(
      `SELECT activity_type FROM task_activities
       WHERE task_id = ? AND activity_type = 'reviewer_stalled'`,
      [task],
    );
    assert.equal(stalledRow?.activity_type, 'reviewer_stalled');

    // Task NOT bounced (autobounce flag off, plus only 1× threshold).
    const taskRow = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [task]);
    assert.equal(taskRow?.status, 'review');
  } finally {
    restore(); restoreBounce();
  }
});

test('review-SLA: idle past 2× threshold + MC_REVIEW_AUTOBOUNCE bounces to assigned + is_failed=1', async () => {
  const restore = setEnv('STALL_DETECTION_MINUTES_REVIEW', '5');
  const restoreBounce = setEnv('MC_REVIEW_AUTOBOUNCE', '1');
  try {
    const reviewer = seedAgent('reviewer');
    const builder = seedAgent('builder');
    const task = seedReviewTask({ reviewer, assigned: builder, idleMinutes: 12 });

    await scanStalledTasks();

    const taskRow = queryOne<{ status: string; is_failed: number; status_reason: string }>(
      'SELECT status, is_failed, status_reason FROM tasks WHERE id = ?',
      [task],
    );
    assert.equal(taskRow?.status, 'assigned');
    assert.equal(taskRow?.is_failed, 1);
    assert.match(taskRow?.status_reason ?? '', /^Failed: reviewer unresponsive/);

    const bouncedRow = queryOne<{ activity_type: string }>(
      `SELECT activity_type FROM task_activities
       WHERE task_id = ? AND activity_type = 'review_autobounced'`,
      [task],
    );
    assert.equal(bouncedRow?.activity_type, 'review_autobounced');
  } finally {
    restore(); restoreBounce();
  }
});

test('review-SLA: 2× threshold without MC_REVIEW_AUTOBOUNCE only writes reviewer_stalled', async () => {
  const restore = setEnv('STALL_DETECTION_MINUTES_REVIEW', '5');
  const restoreBounce = setEnv('MC_REVIEW_AUTOBOUNCE', undefined);
  try {
    const reviewer = seedAgent('reviewer');
    const task = seedReviewTask({ reviewer, idleMinutes: 15 });

    await scanStalledTasks();

    const taskRow = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [task]);
    assert.equal(taskRow?.status, 'review', 'should not bounce when flag is off');

    const bounced = queryOne<{ activity_type: string }>(
      `SELECT activity_type FROM task_activities
       WHERE task_id = ? AND activity_type = 'review_autobounced'`,
      [task],
    );
    assert.equal(bounced, undefined, 'no autobounce activity expected');
  } finally {
    restore(); restoreBounce();
  }
});

test('review-SLA: idle below threshold is a no-op', async () => {
  const restore = setEnv('STALL_DETECTION_MINUTES_REVIEW', '30');
  const restoreBounce = setEnv('MC_REVIEW_AUTOBOUNCE', '1');
  try {
    const reviewer = seedAgent('reviewer');
    const task = seedReviewTask({ reviewer, idleMinutes: 5 });

    await scanStalledTasks();

    const stalledRow = queryOne<{ activity_type: string }>(
      `SELECT activity_type FROM task_activities
       WHERE task_id = ? AND activity_type = 'reviewer_stalled'`,
      [task],
    );
    assert.equal(stalledRow, undefined);
  } finally {
    restore(); restoreBounce();
  }
});

test('review-SLA: reviewer_stalled is throttled within NOTIFY_THROTTLE_MINUTES', async () => {
  const restore = setEnv('STALL_DETECTION_MINUTES_REVIEW', '5');
  const restoreBounce = setEnv('MC_REVIEW_AUTOBOUNCE', undefined);
  try {
    const reviewer = seedAgent('reviewer');
    const task = seedReviewTask({ reviewer, idleMinutes: 7 });

    await scanStalledTasks();
    await scanStalledTasks();

    const count = queryOne<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM task_activities
       WHERE task_id = ? AND activity_type = 'reviewer_stalled'`,
      [task],
    );
    assert.equal(count?.cnt, 1, 'second scan should be throttled');
  } finally {
    restore(); restoreBounce();
  }
});
