/**
 * Tests for the roadmap snapshot helper (Phase 3).
 *
 * Fixture: 1 milestone, 2 epics, 3 stories (one under each epic, plus one
 * orphan), 1 dependency, 4 tasks of mixed status. Verifies depth, task
 * counts, dependency wiring, and filter semantics (kind, status,
 * product_id, from/to).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import {
  addInitiativeDependency,
  attachTaskToInitiative,
  createInitiative,
} from './initiatives';
import { getRoadmapSnapshot } from './roadmap';

interface Fixture {
  workspace: string;
  productA: string;
  productB: string;
  milestoneId: string;
  epicAId: string;
  epicBId: string;
  storyAId: string;
  storyBId: string;
  storyOrphanId: string;
  depId: string;
  taskDraftId: string;
  taskInboxId: string;
  taskInProgId: string;
  taskDoneId: string;
}

function seedTask(opts: { initiativeId?: string | null; status?: string; workspace_id?: string } = {}): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, initiative_id, created_at, updated_at)
     VALUES (?, 'T', ?, 'normal', ?, 'default', ?, datetime('now'), datetime('now'))`,
    [id, opts.status ?? 'inbox', opts.workspace_id ?? 'default', opts.initiativeId ?? null],
  );
  return id;
}

function seedProduct(workspace_id: string): string {
  const id = uuidv4();
  run(
    `INSERT INTO products (id, workspace_id, name, created_at, updated_at)
     VALUES (?, ?, 'P', datetime('now'), datetime('now'))`,
    [id, workspace_id],
  );
  return id;
}

function buildFixture(): Fixture {
  // Use a dedicated workspace per test run to avoid cross-test pollution.
  const ws = `ws-roadmap-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT INTO workspaces (id, name, slug, created_at, updated_at)
     VALUES (?, 'roadmap-test-ws', ?, datetime('now'), datetime('now'))`,
    [ws, ws],
  );
  const productA = seedProduct(ws);
  const productB = seedProduct(ws);

  // Tree:
  //   milestone (target_end 2026-05-15)
  //     epicA (productA, target 2026-04-20..2026-05-10)
  //       storyA (productA, target 2026-04-22..2026-04-30)
  //     epicB (productB, target 2026-06-01..2026-06-30)
  //       storyB (productB, target 2026-06-05..2026-06-20)
  //   storyOrphan (no parent, no dates)
  //
  // Dependency: epicB depends on epicA.

  const milestone = createInitiative({
    workspace_id: ws,
    kind: 'milestone',
    title: 'Launch milestone',
    target_end: '2026-05-15',
    committed_end: '2026-05-15',
  });
  const epicA = createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Epic A',
    parent_initiative_id: milestone.id,
    product_id: productA,
    target_start: '2026-04-20',
    target_end: '2026-05-10',
  });
  const epicB = createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Epic B',
    parent_initiative_id: milestone.id,
    product_id: productB,
    target_start: '2026-06-01',
    target_end: '2026-06-30',
    status: 'at_risk',
  });
  const storyA = createInitiative({
    workspace_id: ws,
    kind: 'story',
    title: 'Story A',
    parent_initiative_id: epicA.id,
    product_id: productA,
    target_start: '2026-04-22',
    target_end: '2026-04-30',
  });
  const storyB = createInitiative({
    workspace_id: ws,
    kind: 'story',
    title: 'Story B',
    parent_initiative_id: epicB.id,
    product_id: productB,
    target_start: '2026-06-05',
    target_end: '2026-06-20',
  });
  const storyOrphan = createInitiative({
    workspace_id: ws,
    kind: 'story',
    title: 'Backlog story (no dates)',
  });

  const dep = addInitiativeDependency({
    initiative_id: epicB.id,
    depends_on_initiative_id: epicA.id,
  });

  // Four tasks of mixed status, all under storyA.
  const taskDraft = seedTask({ workspace_id: ws, status: 'draft' });
  attachTaskToInitiative(taskDraft, storyA.id);
  const taskInbox = seedTask({ workspace_id: ws, status: 'inbox' });
  attachTaskToInitiative(taskInbox, storyA.id);
  const taskInProg = seedTask({ workspace_id: ws, status: 'in_progress' });
  attachTaskToInitiative(taskInProg, storyA.id);
  const taskDone = seedTask({ workspace_id: ws, status: 'done' });
  attachTaskToInitiative(taskDone, storyA.id);

  return {
    workspace: ws,
    productA,
    productB,
    milestoneId: milestone.id,
    epicAId: epicA.id,
    epicBId: epicB.id,
    storyAId: storyA.id,
    storyBId: storyB.id,
    storyOrphanId: storyOrphan.id,
    depId: dep.id,
    taskDraftId: taskDraft,
    taskInboxId: taskInbox,
    taskInProgId: taskInProg,
    taskDoneId: taskDone,
  };
}

test('snapshot orders rows by tree-walk (parent then its children) — not by kind', () => {
  // Regression: before the tree-walk fix, the snapshot returned rows
  // ordered by sort_order + created_at flat, so accepting a
  // decompose proposal that creates N stories under one epic
  // interleaved every story below all epics, severing the visual
  // hierarchy on /roadmap. The fix: emit parent → children DFS so
  // each child appears immediately after its parent.
  const f = buildFixture();
  const snap = getRoadmapSnapshot({ workspace_id: f.workspace });
  const order = snap.initiatives.map(i => i.id);

  function indexOf(id: string): number {
    const idx = order.indexOf(id);
    assert.ok(idx >= 0, `expected ${id} in order`);
    return idx;
  }
  // milestone → epicA → storyA → epicB → storyB. storyOrphan is a root
  // (its parent is unknown / missing) so it appears at the top level.
  // Each child must come immediately after its parent; siblings (epicA,
  // epicB) preserve sort_order/created_at among themselves.
  assert.equal(indexOf(f.epicAId), indexOf(f.milestoneId) + 1);
  assert.equal(indexOf(f.storyAId), indexOf(f.epicAId) + 1);
  assert.equal(indexOf(f.epicBId), indexOf(f.storyAId) + 1);
  assert.equal(indexOf(f.storyBId), indexOf(f.epicBId) + 1);
  // storyA sits between its parent (epicA) and its uncle (epicB) —
  // i.e. children flow before sibling subtrees.
  assert.ok(indexOf(f.storyAId) < indexOf(f.epicBId));
});

test('snapshot returns all initiatives in workspace with correct depth', () => {
  const f = buildFixture();
  const snap = getRoadmapSnapshot({ workspace_id: f.workspace });
  assert.equal(snap.workspace_id, f.workspace);
  assert.equal(snap.truncated, false);
  assert.equal(snap.initiatives.length, 6);

  const byId = new Map(snap.initiatives.map(i => [i.id, i]));
  assert.equal(byId.get(f.milestoneId)?.depth, 0);
  assert.equal(byId.get(f.epicAId)?.depth, 1);
  assert.equal(byId.get(f.epicBId)?.depth, 1);
  assert.equal(byId.get(f.storyAId)?.depth, 2);
  assert.equal(byId.get(f.storyBId)?.depth, 2);
  assert.equal(byId.get(f.storyOrphanId)?.depth, 0);
});

test('task_counts reflect status families', () => {
  const f = buildFixture();
  const snap = getRoadmapSnapshot({ workspace_id: f.workspace });
  const storyA = snap.initiatives.find(i => i.id === f.storyAId);
  assert.ok(storyA);
  assert.deepEqual(storyA.task_counts, { draft: 1, active: 2, done: 1, total: 4 });

  // No tasks on milestone.
  const milestone = snap.initiatives.find(i => i.id === f.milestoneId);
  assert.deepEqual(milestone?.task_counts, { draft: 0, active: 0, done: 0, total: 0 });
});

test('dependencies array contains the seeded edge and only that', () => {
  const f = buildFixture();
  const snap = getRoadmapSnapshot({ workspace_id: f.workspace });
  assert.equal(snap.dependencies.length, 1);
  assert.equal(snap.dependencies[0].id, f.depId);
  assert.equal(snap.dependencies[0].initiative_id, f.epicBId);
  assert.equal(snap.dependencies[0].depends_on_initiative_id, f.epicAId);
});

test('tasks array exposes only initiative-linked tasks', () => {
  const f = buildFixture();
  const snap = getRoadmapSnapshot({ workspace_id: f.workspace });
  assert.equal(snap.tasks.length, 4);
  for (const t of snap.tasks) {
    assert.ok(t.initiative_id, 'tasks without initiative_id should not appear');
  }
});

test('filter by kind', () => {
  const f = buildFixture();
  const snap = getRoadmapSnapshot({ workspace_id: f.workspace, kind: 'epic' });
  assert.equal(snap.initiatives.length, 2);
  for (const i of snap.initiatives) {
    assert.equal(i.kind, 'epic');
  }
  // Depth recomputes against the visible set — epics are now roots.
  for (const i of snap.initiatives) assert.equal(i.depth, 0);
});

test('filter by status', () => {
  const f = buildFixture();
  const snap = getRoadmapSnapshot({ workspace_id: f.workspace, status: 'at_risk' });
  assert.equal(snap.initiatives.length, 1);
  assert.equal(snap.initiatives[0].id, f.epicBId);
});

test('filter by product_id keeps only matching initiatives', () => {
  const f = buildFixture();
  const snapA = getRoadmapSnapshot({ workspace_id: f.workspace, product_id: f.productA });
  const ids = snapA.initiatives.map(i => i.id).sort();
  assert.deepEqual(ids, [f.epicAId, f.storyAId].sort());
});

test('from/to date window clips by target overlap; null-date rows kept', () => {
  const f = buildFixture();
  // Window covers April only — should keep epicA (Apr 20–May 10), storyA
  // (Apr 22–30), and storyOrphan (no dates).  Should drop epicB and storyB
  // (entirely in June) and the milestone (only end = May 15).
  const snap = getRoadmapSnapshot({
    workspace_id: f.workspace,
    from: '2026-04-01',
    to: '2026-04-30',
  });
  const ids = new Set(snap.initiatives.map(i => i.id));
  assert.ok(ids.has(f.epicAId));
  assert.ok(ids.has(f.storyAId));
  assert.ok(ids.has(f.storyOrphanId));
  assert.ok(!ids.has(f.epicBId));
  assert.ok(!ids.has(f.storyBId));
});

test('owner_agent_name joined when owner is set', () => {
  const f = buildFixture();
  const agentId = uuidv4();
  run(
    `INSERT INTO agents (id, name, role, workspace_id) VALUES (?, 'Sarah', 'worker', ?)`,
    [agentId, f.workspace],
  );
  // Update epicA to have an owner.
  run('UPDATE initiatives SET owner_agent_id = ? WHERE id = ?', [agentId, f.epicAId]);

  const snap = getRoadmapSnapshot({ workspace_id: f.workspace });
  const epicA = snap.initiatives.find(i => i.id === f.epicAId);
  assert.equal(epicA?.owner_agent_id, agentId);
  assert.equal(epicA?.owner_agent_name, 'Sarah');

  const storyA = snap.initiatives.find(i => i.id === f.storyAId);
  assert.equal(storyA?.owner_agent_id, null);
  assert.equal(storyA?.owner_agent_name, null);
});

test('snapshot in another workspace returns empty', () => {
  const f = buildFixture();
  void f;
  const snap = getRoadmapSnapshot({ workspace_id: 'no-such-ws' });
  assert.equal(snap.initiatives.length, 0);
  assert.equal(snap.dependencies.length, 0);
  assert.equal(snap.tasks.length, 0);
  assert.equal(snap.truncated, false);
});
