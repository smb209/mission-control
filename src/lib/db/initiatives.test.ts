/**
 * Initiative DB-helper tests (Phase 1 of the roadmap planning layer).
 *
 * Covers the invariants from spec §4 and §6:
 *   - parent validation + cycle rejection on move
 *   - container retention through decomposition (deps stay on parent)
 *   - delete blocked when descendants exist
 *   - multi-prereq deps allowed; self-dep + duplicate rejected
 *   - task re-parenting always writes an audit row
 *   - tasks.status='draft' is now accepted by the CHECK constraint
 *   - ideas.initiative_id is settable
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import {
  addInitiativeDependency,
  attachTaskToInitiative,
  createInitiative,
  deleteInitiative,
  getInitiativeDependencies,
  moveInitiative,
  moveTaskToInitiative,
  removeInitiativeDependency,
} from './initiatives';

function seedTask(opts: { initiativeId?: string | null; status?: string } = {}): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, initiative_id, created_at, updated_at)
     VALUES (?, 'T', ?, 'normal', 'default', 'default', ?, datetime('now'), datetime('now'))`,
    [id, opts.status ?? 'inbox', opts.initiativeId ?? null],
  );
  return id;
}

function seedProduct(): string {
  const id = uuidv4();
  run(
    `INSERT INTO products (id, workspace_id, name, created_at, updated_at)
     VALUES (?, 'default', 'P', datetime('now'), datetime('now'))`,
    [id],
  );
  return id;
}

// ─── createInitiative ──────────────────────────────────────────────

test('createInitiative returns a fully populated row with defaults', () => {
  const init = createInitiative({
    workspace_id: 'default',
    kind: 'epic',
    title: 'Build big feature',
  });
  assert.equal(init.kind, 'epic');
  assert.equal(init.title, 'Build big feature');
  assert.equal(init.status, 'planned');
  assert.equal(init.parent_initiative_id, null);
  assert.ok(init.created_at);
});

test('createInitiative rejects unknown parent', () => {
  assert.throws(
    () =>
      createInitiative({
        workspace_id: 'default',
        kind: 'story',
        title: 'orphan',
        parent_initiative_id: 'does-not-exist',
      }),
    /Parent initiative not found/,
  );
});

test('createInitiative attaches to existing parent', () => {
  const parent = createInitiative({ workspace_id: 'default', kind: 'epic', title: 'parent' });
  const child = createInitiative({
    workspace_id: 'default',
    kind: 'story',
    title: 'child',
    parent_initiative_id: parent.id,
  });
  assert.equal(child.parent_initiative_id, parent.id);
});

// ─── moveInitiative ─────────────────────────────────────────────────

test('moveInitiative writes audit row in the same transaction', () => {
  const a = createInitiative({ workspace_id: 'default', kind: 'epic', title: 'A' });
  const b = createInitiative({ workspace_id: 'default', kind: 'epic', title: 'B' });
  moveInitiative(a.id, b.id, null, 'reorganize');

  const updated = queryOne<{ parent_initiative_id: string | null }>(
    'SELECT parent_initiative_id FROM initiatives WHERE id = ?',
    [a.id],
  );
  assert.equal(updated?.parent_initiative_id, b.id);

  const history = queryAll<{ to_parent_id: string | null; reason: string | null }>(
    'SELECT to_parent_id, reason FROM initiative_parent_history WHERE initiative_id = ?',
    [a.id],
  );
  assert.equal(history.length, 1);
  assert.equal(history[0].to_parent_id, b.id);
  assert.equal(history[0].reason, 'reorganize');
});

test('moveInitiative rejects cycles (move A under one of its descendants)', () => {
  const a = createInitiative({ workspace_id: 'default', kind: 'epic', title: 'A' });
  const b = createInitiative({
    workspace_id: 'default',
    kind: 'story',
    title: 'B',
    parent_initiative_id: a.id,
  });
  // Move A under B → cycle, B is a descendant of A.
  assert.throws(() => moveInitiative(a.id, b.id), /cycle/i);
});

test('moveInitiative rejects move under self', () => {
  const a = createInitiative({ workspace_id: 'default', kind: 'story', title: 'self' });
  assert.throws(() => moveInitiative(a.id, a.id), /under itself|cycle/i);
});

// ─── deleteInitiative ──────────────────────────────────────────────

test('deleteInitiative blocked when descendant initiative exists', () => {
  const parent = createInitiative({ workspace_id: 'default', kind: 'epic', title: 'parent' });
  createInitiative({
    workspace_id: 'default',
    kind: 'story',
    title: 'child',
    parent_initiative_id: parent.id,
  });
  assert.throws(() => deleteInitiative(parent.id), /child initiative/);
});

test('deleteInitiative blocked when a task references it', () => {
  const init = createInitiative({ workspace_id: 'default', kind: 'story', title: 's' });
  const taskId = seedTask();
  attachTaskToInitiative(taskId, init.id);
  assert.throws(() => deleteInitiative(init.id), /task/);
});

test('deleteInitiative succeeds for a leaf with no references', () => {
  const init = createInitiative({ workspace_id: 'default', kind: 'story', title: 'leaf' });
  deleteInitiative(init.id);
  assert.equal(
    queryOne('SELECT id FROM initiatives WHERE id = ?', [init.id]),
    undefined,
  );
});

// ─── dependencies ──────────────────────────────────────────────────

test('addInitiativeDependency allows multiple prerequisites for one initiative', () => {
  const a = createInitiative({ workspace_id: 'default', kind: 'story', title: 'A' });
  const b = createInitiative({ workspace_id: 'default', kind: 'story', title: 'B' });
  const c = createInitiative({ workspace_id: 'default', kind: 'story', title: 'C' });
  addInitiativeDependency({ initiative_id: c.id, depends_on_initiative_id: a.id });
  addInitiativeDependency({ initiative_id: c.id, depends_on_initiative_id: b.id });
  const deps = getInitiativeDependencies(c.id);
  assert.equal(deps.outgoing.length, 2);
  const targets = deps.outgoing.map(d => d.depends_on_initiative_id).sort();
  assert.deepEqual(targets, [a.id, b.id].sort());
});

test('addInitiativeDependency rejects self-dependency', () => {
  const a = createInitiative({ workspace_id: 'default', kind: 'story', title: 'A' });
  assert.throws(
    () => addInitiativeDependency({ initiative_id: a.id, depends_on_initiative_id: a.id }),
    /itself/,
  );
});

test('addInitiativeDependency rejects duplicate edges', () => {
  const a = createInitiative({ workspace_id: 'default', kind: 'story', title: 'A' });
  const b = createInitiative({ workspace_id: 'default', kind: 'story', title: 'B' });
  addInitiativeDependency({ initiative_id: a.id, depends_on_initiative_id: b.id });
  assert.throws(
    () => addInitiativeDependency({ initiative_id: a.id, depends_on_initiative_id: b.id }),
    /already exists/,
  );
});

test('removeInitiativeDependency drops the edge', () => {
  const a = createInitiative({ workspace_id: 'default', kind: 'story', title: 'A' });
  const b = createInitiative({ workspace_id: 'default', kind: 'story', title: 'B' });
  const dep = addInitiativeDependency({ initiative_id: a.id, depends_on_initiative_id: b.id });
  removeInitiativeDependency(dep.id);
  assert.equal(getInitiativeDependencies(a.id).outgoing.length, 0);
});

// ─── container retention through decomposition ─────────────────────

test('container retention: dep on parent unaffected when children added (spec §4.2)', () => {
  // Story A; story C depends on A.
  const a = createInitiative({ workspace_id: 'default', kind: 'story', title: 'A' });
  const c = createInitiative({ workspace_id: 'default', kind: 'story', title: 'C' });
  const dep = addInitiativeDependency({
    initiative_id: c.id,
    depends_on_initiative_id: a.id,
  });

  // Decompose A by adding child B — A becomes a container.
  const b = createInitiative({
    workspace_id: 'default',
    kind: 'story',
    title: 'B',
    parent_initiative_id: a.id,
  });

  // (C, A) edge stays put; no edge auto-rewritten to (C, B).
  let depsC = getInitiativeDependencies(c.id);
  assert.equal(depsC.outgoing.length, 1);
  assert.equal(depsC.outgoing[0].id, dep.id);
  assert.equal(depsC.outgoing[0].depends_on_initiative_id, a.id);

  // Further decompose B; (C, A) still unaffected.
  createInitiative({
    workspace_id: 'default',
    kind: 'story',
    title: 'B.1',
    parent_initiative_id: b.id,
  });
  depsC = getInitiativeDependencies(c.id);
  assert.equal(depsC.outgoing.length, 1);
  assert.equal(depsC.outgoing[0].depends_on_initiative_id, a.id);
});

// ─── task re-parenting & audit ─────────────────────────────────────

test('moving a task between initiatives writes two task_initiative_history rows', () => {
  const a = createInitiative({ workspace_id: 'default', kind: 'story', title: 'A' });
  const b = createInitiative({ workspace_id: 'default', kind: 'story', title: 'B' });
  const taskId = seedTask();
  attachTaskToInitiative(taskId, a.id, null, 'initial');

  moveTaskToInitiative(taskId, b.id, null, 'deferred to phase 2');

  const history = queryAll<{
    from_initiative_id: string | null;
    to_initiative_id: string | null;
    reason: string | null;
  }>(
    'SELECT from_initiative_id, to_initiative_id, reason FROM task_initiative_history WHERE task_id = ? ORDER BY created_at',
    [taskId],
  );
  assert.equal(history.length, 2);
  assert.equal(history[0].from_initiative_id, null);
  assert.equal(history[0].to_initiative_id, a.id);
  assert.equal(history[1].from_initiative_id, a.id);
  assert.equal(history[1].to_initiative_id, b.id);
  assert.equal(history[1].reason, 'deferred to phase 2');

  const task = queryOne<{ initiative_id: string }>(
    'SELECT initiative_id FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(task?.initiative_id, b.id);
});

// ─── schema-level checks ──────────────────────────────────────────

test("tasks.status='draft' is accepted by the CHECK constraint", () => {
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'D', 'draft', 'normal', 'default', 'default', datetime('now'), datetime('now'))`,
    [id],
  );
  const row = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id]);
  assert.equal(row?.status, 'draft');
});

test('ideas.initiative_id is settable', () => {
  const productId = seedProduct();
  const init = createInitiative({ workspace_id: 'default', kind: 'story', title: 'idea-target' });
  const ideaId = uuidv4();
  run(
    `INSERT INTO ideas (id, product_id, title, description, category, initiative_id, created_at, updated_at)
     VALUES (?, ?, 'i', 'd', 'feature', ?, datetime('now'), datetime('now'))`,
    [ideaId, productId, init.id],
  );
  const row = queryOne<{ initiative_id: string }>('SELECT initiative_id FROM ideas WHERE id = ?', [ideaId]);
  assert.equal(row?.initiative_id, init.id);
});
