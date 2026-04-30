import test from 'node:test';
import assert from 'node:assert/strict';
import { run, queryOne } from './db';
import {
  hasStageEvidence,
  taskCanBeDone,
  whyCannotBeDone,
  ensureFixerExists,
  getFailureCountInStage,
} from './task-governance';

function seedTask(id: string, workspace = 'default') {
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'T', 'review', 'normal', ?, 'default', datetime('now'), datetime('now'))`,
    [id, workspace]
  );
}

test('evidence gate requires deliverable + activity', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);

  assert.equal(hasStageEvidence(taskId), false);

  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'file', 'index.html', datetime('now'))`,
    [taskId]
  );
  assert.equal(hasStageEvidence(taskId), false);

  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'completed', 'did thing', datetime('now'))`,
    [taskId]
  );

  assert.equal(hasStageEvidence(taskId), true);
});

test('task cannot be done when is_failed flag is set', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);

  // Free-text status_reason that legitimately contains "fail" no longer
  // blocks — the structured flag is the source of truth. Set both to make
  // the intent explicit.
  run(`UPDATE tasks SET is_failed = 1, status_reason = 'Validation failed: CSS broken' WHERE id = ?`, [taskId]);
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, role, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'file', 'index.html', 'output', datetime('now'))`,
    [taskId]
  );
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'completed', 'did thing', datetime('now'))`,
    [taskId]
  );

  assert.equal(taskCanBeDone(taskId), false, 'is_failed=1 blocks');
});

test('descriptive status_reason containing "fail" no longer blocks (post is_failed flag)', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);
  // Common false-positive: descriptive text that mentions failure handling
  // without actually being a failure — e.g. a successful task summarising
  // its coverage. Pre-flag this would be rejected; now it's allowed because
  // is_failed = 0.
  run(`UPDATE tasks SET status_reason = 'all failure paths covered, fail-loud on missing config' WHERE id = ?`, [taskId]);
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, role, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'file', 'x.ts', 'output', datetime('now'))`,
    [taskId]
  );
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'completed', 'did thing', datetime('now'))`,
    [taskId]
  );

  assert.equal(taskCanBeDone(taskId), true);
});

test('ignoreFailureFlag bypasses is_failed for the same-UPDATE recovery path', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);
  run(`UPDATE tasks SET is_failed = 1 WHERE id = ?`, [taskId]);
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, role, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'file', 'x.ts', 'output', datetime('now'))`,
    [taskId]
  );
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'completed', 'did thing', datetime('now'))`,
    [taskId]
  );

  assert.equal(taskCanBeDone(taskId), false, 'flag still blocks by default');
  assert.equal(taskCanBeDone(taskId, { ignoreFailureFlag: true }), true, 'option lets the same-UPDATE recovery proceed');
});

test('whyCannotBeDone returns specific code-prefixed reasons', () => {
  // Missing evidence path
  const noEvidenceId = crypto.randomUUID();
  seedTask(noEvidenceId);
  const noEvidence = whyCannotBeDone(noEvidenceId);
  assert.ok(noEvidence?.startsWith('code:evidence_gate'), `expected code:evidence_gate, got: ${noEvidence}`);

  // is_failed flag path
  const failedId = crypto.randomUUID();
  seedTask(failedId);
  run(`UPDATE tasks SET is_failed = 1 WHERE id = ?`, [failedId]);
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, role, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'file', 'x.ts', 'output', datetime('now'))`,
    [failedId]
  );
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'completed', 'did thing', datetime('now'))`,
    [failedId]
  );
  const flagged = whyCannotBeDone(failedId);
  assert.ok(flagged?.startsWith('code:task_marked_failed'), `expected code:task_marked_failed, got: ${flagged}`);

  // Happy path returns null
  const okId = crypto.randomUUID();
  seedTask(okId);
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, role, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'file', 'x.ts', 'output', datetime('now'))`,
    [okId]
  );
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'completed', 'did thing', datetime('now'))`,
    [okId]
  );
  assert.equal(whyCannotBeDone(okId), null);
});

test('ensureFixerExists creates fixer when missing', () => {
  const fixer = ensureFixerExists('default');
  assert.equal(fixer.created, true);

  const stored = queryOne<{ id: string; role: string }>('SELECT id, role FROM agents WHERE id = ?', [fixer.id]);
  assert.ok(stored);
  assert.equal(stored?.role, 'fixer');
});

test('failure counter reads status_changed failure events', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);

  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'status_changed', 'Stage failed: verification → in_progress (reason: x)', datetime('now'))`,
    [taskId]
  );
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'status_changed', 'Stage failed: verification → in_progress (reason: y)', datetime('now'))`,
    [taskId]
  );

  assert.equal(getFailureCountInStage(taskId, 'verification'), 2);
});
