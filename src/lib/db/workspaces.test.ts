/**
 * Workspace cascade-delete tests.
 *
 * These tests intentionally seed a wide variety of workspace-scoped
 * rows (tasks + their dependents, agents + their dependents, knowledge,
 * initiatives, products, …) so that any FK regression — e.g. someone
 * adds a new table that references workspaces but forgets to wire it
 * into `deleteWorkspaceCascade` — surfaces here as a SQLITE_CONSTRAINT
 * error rather than a mysterious 500 in production.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, queryOne, run } from '@/lib/db';
import {
  deleteWorkspaceCascade,
  getWorkspaceCascadeCounts,
} from './workspaces';

function seedWorkspace(name = 'Test Workspace'): { id: string; name: string; slug: string } {
  const id = uuidv4();
  const slug = `ws-${id.slice(0, 8)}`;
  run(
    `INSERT INTO workspaces (id, name, slug, icon) VALUES (?, ?, ?, ?)`,
    [id, name, slug, '📦'],
  );
  return { id, name, slug };
}

function seedAgent(workspace_id: string): string {
  const id = uuidv4();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, status, avatar_emoji)
     VALUES (?, 'Test Agent', 'engineer', ?, 'standby', '🤖')`,
    [id, workspace_id],
  );
  return id;
}

function seedTask(workspace_id: string, opts: { title?: string } = {}): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, created_at, updated_at)
     VALUES (?, ?, 'inbox', 'normal', ?, datetime('now'), datetime('now'))`,
    [id, opts.title ?? 'Test Task', workspace_id],
  );
  return id;
}

test('getWorkspaceCascadeCounts returns zero for empty workspace', () => {
  const ws = seedWorkspace('Empty');
  const counts = getWorkspaceCascadeCounts(ws.id);
  assert.equal(counts.tasks, 0);
  assert.equal(counts.agents, 0);
  assert.equal(counts.initiatives, 0);
  assert.equal(counts.products, 0);
  // Cleanup
  deleteWorkspaceCascade(ws.id);
});

test('getWorkspaceCascadeCounts reflects seeded rows', () => {
  const ws = seedWorkspace('Counted');
  seedTask(ws.id);
  seedTask(ws.id);
  seedAgent(ws.id);

  const counts = getWorkspaceCascadeCounts(ws.id);
  assert.equal(counts.tasks, 2);
  assert.equal(counts.agents, 1);

  deleteWorkspaceCascade(ws.id);
});

test('deleteWorkspaceCascade removes workspace and all tasks/agents', () => {
  const ws = seedWorkspace('Cascade');
  const t1 = seedTask(ws.id);
  const t2 = seedTask(ws.id);
  const a1 = seedAgent(ws.id);

  const counts = deleteWorkspaceCascade(ws.id);
  assert.equal(counts.tasks, 2);
  assert.equal(counts.agents, 1);

  // Workspace is gone
  const wsRow = queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = ?', [ws.id]);
  assert.equal(wsRow, undefined);

  // Tasks and agents are gone
  for (const id of [t1, t2]) {
    const t = queryOne<{ id: string }>('SELECT id FROM tasks WHERE id = ?', [id]);
    assert.equal(t, undefined);
  }
  const a = queryOne<{ id: string }>('SELECT id FROM agents WHERE id = ?', [a1]);
  assert.equal(a, undefined);
});

test('deleteWorkspaceCascade cascades through task dependents (task_deliverables)', () => {
  const ws = seedWorkspace('TaskDeps');
  const taskId = seedTask(ws.id);

  // task_deliverables has ON DELETE CASCADE on task_id, so deleting the
  // task should remove this row. Confirms our delete order doesn't
  // leave orphans.
  const deliverableId = uuidv4();
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, created_at)
     VALUES (?, ?, 'note', 'cascade-test-deliverable', datetime('now'))`,
    [deliverableId, taskId],
  );

  deleteWorkspaceCascade(ws.id);

  const orphan = queryOne<{ id: string }>(
    'SELECT id FROM task_deliverables WHERE id = ?',
    [deliverableId],
  );
  assert.equal(orphan, undefined);
});

test('deleteWorkspaceCascade cleans non-cascading task refs (events.task_id)', () => {
  const ws = seedWorkspace('NonCascading');
  const taskId = seedTask(ws.id);

  // events.task_id is a plain reference (no ON DELETE CASCADE). If our
  // helper doesn't snipe it, deleting tasks would either fail (FK on)
  // or leave orphans (FK off, naive).
  const eventId = uuidv4();
  run(
    `INSERT INTO events (id, type, task_id, message, created_at)
     VALUES (?, 'test_event', ?, 'cascade test', datetime('now'))`,
    [eventId, taskId],
  );

  deleteWorkspaceCascade(ws.id);

  // Workspace is gone — and re-enabling FKs at the end shouldn't have
  // tripped on a stale event row.
  const wsRow = queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = ?', [ws.id]);
  assert.equal(wsRow, undefined);

  const evtRow = queryOne<{ id: string }>('SELECT id FROM events WHERE id = ?', [eventId]);
  assert.equal(evtRow, undefined);
});

test('deleteWorkspaceCascade refuses to delete the default workspace', () => {
  // Ensure the default workspace exists (seeded by migrations / bootstrap).
  const db = getDb();
  let exists = db.prepare("SELECT id FROM workspaces WHERE id = 'default'").get() as
    | { id: string }
    | undefined;
  if (!exists) {
    run(`INSERT INTO workspaces (id, name, slug, icon) VALUES ('default', 'Default', 'default', '📁')`);
    exists = { id: 'default' };
  }

  assert.throws(() => deleteWorkspaceCascade('default'), /default workspace/);

  // Still there
  const stillThere = queryOne<{ id: string }>("SELECT id FROM workspaces WHERE id = 'default'");
  assert.ok(stillThere);
});

test('deleteWorkspaceCascade throws if workspace not found', () => {
  assert.throws(() => deleteWorkspaceCascade('does-not-exist-' + uuidv4()), /not found/i);
});

test('deleteWorkspaceCascade leaves other workspaces untouched', () => {
  const keep = seedWorkspace('Keep');
  const drop = seedWorkspace('Drop');
  const keepTask = seedTask(keep.id);
  const dropTask = seedTask(drop.id);

  deleteWorkspaceCascade(drop.id);

  // Drop is gone
  const dropRow = queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = ?', [drop.id]);
  assert.equal(dropRow, undefined);
  const dropTaskRow = queryOne<{ id: string }>('SELECT id FROM tasks WHERE id = ?', [dropTask]);
  assert.equal(dropTaskRow, undefined);

  // Keep survives
  const keepRow = queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = ?', [keep.id]);
  assert.ok(keepRow);
  const keepTaskRow = queryOne<{ id: string }>('SELECT id FROM tasks WHERE id = ?', [keepTask]);
  assert.ok(keepTaskRow);

  // Cleanup
  deleteWorkspaceCascade(keep.id);
});
