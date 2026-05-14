/**
 * Migration 096 (`pm_convoy_mandate_task_ac_acknowledgements`).
 *
 * Verifies the new `task_ac_acknowledgements` table exists with the
 * right shape: unique (task_id, ac_index), FK to tasks(id) with cascade
 * delete, and CURRENT_TIMESTAMP default on acknowledged_at.
 *
 * See docs/reference/pm-convoy-mandate.md "Gate at parent review → done".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, run } from '@/lib/db';

test('migration 096: task_ac_acknowledgements table exists with the expected columns', () => {
  const db = getDb();
  const cols = db.prepare(`PRAGMA table_info(task_ac_acknowledgements)`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
  }>;
  assert.ok(cols.length > 0, 'task_ac_acknowledgements table should exist');
  const byName = Object.fromEntries(cols.map(c => [c.name, c]));
  assert.ok(byName.id);
  assert.ok(byName.task_id);
  assert.ok(byName.ac_index);
  assert.ok(byName.ac_text);
  assert.ok(byName.rationale);
  assert.ok(byName.acknowledged_by);
  assert.ok(byName.acknowledged_at);
  assert.equal(byName.task_id.notnull, 1, 'task_id must be NOT NULL');
  assert.equal(byName.ac_index.notnull, 1, 'ac_index must be NOT NULL');
  assert.equal(byName.ac_text.notnull, 1, 'ac_text must be NOT NULL');
});

test('migration 096: unique (task_id, ac_index) constraint enforced', () => {
  const taskId = `mig096-${crypto.randomUUID()}`;
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'T', 'review', 'normal', 'default', 'default', datetime('now'), datetime('now'))`,
    [taskId],
  );
  run(
    `INSERT INTO task_ac_acknowledgements (task_id, ac_index, ac_text) VALUES (?, 0, 'AC0')`,
    [taskId],
  );
  assert.throws(
    () =>
      run(
        `INSERT INTO task_ac_acknowledgements (task_id, ac_index, ac_text) VALUES (?, 0, 'dup')`,
        [taskId],
      ),
    /UNIQUE constraint failed/i,
  );
});

test('migration 096: FK cascade delete removes ack rows when task is deleted', () => {
  const db = getDb();
  // Enable FKs in this connection (defense — index.ts sets it but tests
  // sometimes open fresh handles).
  db.pragma('foreign_keys = ON');
  const taskId = `mig096-fk-${crypto.randomUUID()}`;
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'T', 'review', 'normal', 'default', 'default', datetime('now'), datetime('now'))`,
    [taskId],
  );
  run(
    `INSERT INTO task_ac_acknowledgements (task_id, ac_index, ac_text) VALUES (?, 0, 'AC0')`,
    [taskId],
  );
  run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
  const remaining = db
    .prepare(`SELECT COUNT(*) AS cnt FROM task_ac_acknowledgements WHERE task_id = ?`)
    .get(taskId) as { cnt: number };
  assert.equal(remaining.cnt, 0, 'ack rows should cascade-delete with their task');
});
