/**
 * Promotion DB-helper tests (Phase 2 of the roadmap planning layer).
 *
 * Covers spec §3.3, §6, and §13:
 *   - story → task(draft) promotion is rejected for non-story kinds
 *   - draft → inbox flips status, emits event, rejects already-inbox tasks
 *   - idea → initiative is idempotent (re-promotion returns the existing one)
 *   - mid-execution re-parenting works and writes audit rows
 *   - history join returns rows in order with both titles
 *   - convert emits initiative_kind_changed event
 *   - end-to-end provenance trace: idea → initiative → draft → move → inbox
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import {
  createInitiative,
  moveTaskToInitiative,
  convertInitiative,
} from './initiatives';
import {
  promoteInitiativeToTask,
  promoteTaskToInbox,
  promoteIdeaToInitiative,
  getTaskInitiativeHistory,
  emitConvertEvent,
} from './promotion';

function seedProduct(workspaceId = 'default'): string {
  const id = uuidv4();
  run(
    `INSERT INTO products (id, workspace_id, name, created_at, updated_at)
     VALUES (?, ?, 'P', datetime('now'), datetime('now'))`,
    [id, workspaceId],
  );
  return id;
}

function seedIdea(opts: { productId?: string; title?: string; description?: string } = {}): string {
  const productId = opts.productId ?? seedProduct();
  const id = uuidv4();
  run(
    `INSERT INTO ideas (id, product_id, title, description, category, source, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'feature', 'manual', 'pending', datetime('now'), datetime('now'))`,
    [id, productId, opts.title ?? 'Idea', opts.description ?? 'Idea desc'],
  );
  return id;
}

function seedTask(opts: { initiativeId?: string | null; status?: string } = {}): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, initiative_id, created_at, updated_at)
     VALUES (?, 'T', ?, 'normal', 'default', 'default', ?, datetime('now'), datetime('now'))`,
    [id, opts.status ?? 'inbox', opts.initiativeId ?? null],
  );
  return id;
}

// ─── promoteInitiativeToTask ───────────────────────────────────────────

test('promoteInitiativeToTask creates a draft task with correct workspace + audit row', () => {
  const init = createInitiative({
    workspace_id: 'default',
    kind: 'story',
    title: 'Build feature X',
    description: 'Big plans',
  });
  const { id: taskId } = promoteInitiativeToTask(init.id);

  const task = queryOne<{
    title: string;
    status: string;
    workspace_id: string;
    initiative_id: string;
    description: string | null;
  }>(
    'SELECT title, status, workspace_id, initiative_id, description FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(task?.status, 'draft');
  assert.equal(task?.workspace_id, 'default');
  assert.equal(task?.initiative_id, init.id);
  assert.equal(task?.title, 'Build feature X');
  assert.equal(task?.description, 'Big plans');

  const history = queryAll<{ from_initiative_id: string | null; to_initiative_id: string | null; reason: string | null }>(
    'SELECT from_initiative_id, to_initiative_id, reason FROM task_initiative_history WHERE task_id = ?',
    [taskId],
  );
  assert.equal(history.length, 1);
  assert.equal(history[0].from_initiative_id, null);
  assert.equal(history[0].to_initiative_id, init.id);
  assert.equal(history[0].reason, 'initial promotion');
});

test('promoteInitiativeToTask rejects non-story initiatives with the spec-required error', () => {
  for (const kind of ['theme', 'milestone', 'epic'] as const) {
    const init = createInitiative({ workspace_id: 'default', kind, title: kind });
    assert.throws(
      () => promoteInitiativeToTask(init.id),
      /Only story-kind initiatives can be promoted/,
    );
  }
});

test('promoteInitiativeToTask honours overridden title and description', () => {
  const init = createInitiative({ workspace_id: 'default', kind: 'story', title: 'Original' });
  const { id: taskId } = promoteInitiativeToTask(init.id, {
    task_title: 'Custom title',
    task_description: 'Custom description',
    status_check_md: 'PR pending',
  });
  const task = queryOne<{ title: string; description: string | null; status_check_md: string | null }>(
    'SELECT title, description, status_check_md FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(task?.title, 'Custom title');
  assert.equal(task?.description, 'Custom description');
  assert.equal(task?.status_check_md, 'PR pending');
});

// ─── promoteTaskToInbox ────────────────────────────────────────────────

test('promoteTaskToInbox flips draft → inbox and emits an event', () => {
  const init = createInitiative({ workspace_id: 'default', kind: 'story', title: 's' });
  const { id: taskId } = promoteInitiativeToTask(init.id);

  promoteTaskToInbox(taskId);

  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  assert.equal(task?.status, 'inbox');

  const events = queryAll<{ type: string; task_id: string }>(
    "SELECT type, task_id FROM events WHERE task_id = ? AND type = 'task_promoted_to_inbox'",
    [taskId],
  );
  assert.equal(events.length, 1);
});

test('promoteTaskToInbox throws when task is not in draft', () => {
  const taskId = seedTask({ status: 'inbox' });
  assert.throws(
    () => promoteTaskToInbox(taskId),
    /not in draft/,
  );
});

test('promoteTaskToInbox throws on missing task', () => {
  assert.throws(() => promoteTaskToInbox('does-not-exist'), /Task not found/);
});

// ─── promoteIdeaToInitiative ───────────────────────────────────────────

test('promoteIdeaToInitiative creates initiative with source_idea_id and updates idea pointer', () => {
  const productId = seedProduct();
  const ideaId = seedIdea({ productId, title: 'Idea X', description: 'Description' });

  const result = promoteIdeaToInitiative(ideaId);
  assert.equal(result.alreadyPromoted, false);
  assert.equal(result.initiative.source_idea_id, ideaId);
  assert.equal(result.initiative.title, 'Idea X');
  assert.equal(result.initiative.description, 'Description');
  assert.equal(result.initiative.kind, 'story');
  assert.equal(result.initiative.product_id, productId);

  const idea = queryOne<{ initiative_id: string }>(
    'SELECT initiative_id FROM ideas WHERE id = ?',
    [ideaId],
  );
  assert.equal(idea?.initiative_id, result.initiative.id);
});

test('promoteIdeaToInitiative is idempotent — re-promotion returns alreadyPromoted=true', () => {
  const ideaId = seedIdea();
  const first = promoteIdeaToInitiative(ideaId);
  const second = promoteIdeaToInitiative(ideaId);
  assert.equal(second.alreadyPromoted, true);
  assert.equal(second.initiative.id, first.initiative.id);
});

test('promoteIdeaToInitiative honours kind override and copy_description=false', () => {
  const ideaId = seedIdea({ description: 'should not copy' });
  const result = promoteIdeaToInitiative(ideaId, {
    kind: 'epic',
    copy_description: false,
  });
  assert.equal(result.initiative.kind, 'epic');
  assert.equal(result.initiative.description, null);
});

test('idea→task autopilot path is unaffected by the new idea→initiative path', () => {
  // Smoke test: an idea may have task_id (autopilot) AND initiative_id
  // (planning) simultaneously. Promotion should not collide.
  const productId = seedProduct();
  const ideaId = seedIdea({ productId });
  const taskId = seedTask();
  run('UPDATE ideas SET task_id = ? WHERE id = ?', [taskId, ideaId]);

  const result = promoteIdeaToInitiative(ideaId);
  const idea = queryOne<{ task_id: string | null; initiative_id: string | null }>(
    'SELECT task_id, initiative_id FROM ideas WHERE id = ?',
    [ideaId],
  );
  assert.equal(idea?.task_id, taskId);
  assert.equal(idea?.initiative_id, result.initiative.id);
});

// ─── moveTaskToInitiative mid-execution + detach ───────────────────────

test('moveTaskToInitiative on an in_progress task preserves status and writes audit row', async () => {
  const a = createInitiative({ workspace_id: 'default', kind: 'story', title: 'A' });
  const b = createInitiative({ workspace_id: 'default', kind: 'story', title: 'B' });
  // Promote A→draft, manually flip status to in_progress to mimic mid-execution.
  const { id: taskId } = promoteInitiativeToTask(a.id);
  run("UPDATE tasks SET status = 'in_progress' WHERE id = ?", [taskId]);
  await new Promise(r => setTimeout(r, 5));

  moveTaskToInitiative(taskId, b.id, null, 'rescoped to B');

  const task = queryOne<{ status: string; initiative_id: string }>(
    'SELECT status, initiative_id FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(task?.status, 'in_progress');
  assert.equal(task?.initiative_id, b.id);

  const history = queryAll<{ from_initiative_id: string | null; to_initiative_id: string | null }>(
    'SELECT from_initiative_id, to_initiative_id FROM task_initiative_history WHERE task_id = ? ORDER BY created_at',
    [taskId],
  );
  assert.equal(history.length, 2);
  assert.equal(history[1].from_initiative_id, a.id);
  assert.equal(history[1].to_initiative_id, b.id);
});

test('detaching a task (to_initiative_id=null) writes a null audit row', () => {
  const a = createInitiative({ workspace_id: 'default', kind: 'story', title: 'A' });
  const { id: taskId } = promoteInitiativeToTask(a.id);

  moveTaskToInitiative(taskId, null, null, 'orphaning');

  const task = queryOne<{ initiative_id: string | null }>(
    'SELECT initiative_id FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(task?.initiative_id, null);

  const history = queryAll<{ to_initiative_id: string | null }>(
    'SELECT to_initiative_id FROM task_initiative_history WHERE task_id = ? ORDER BY created_at',
    [taskId],
  );
  assert.equal(history[history.length - 1].to_initiative_id, null);
});

// ─── getTaskInitiativeHistory join ────────────────────────────────────

test('getTaskInitiativeHistory returns chronological rows with both titles joined', async () => {
  const a = createInitiative({ workspace_id: 'default', kind: 'story', title: 'Alpha' });
  const b = createInitiative({ workspace_id: 'default', kind: 'story', title: 'Beta' });
  const { id: taskId } = promoteInitiativeToTask(a.id);
  // ISO created_at is millisecond-precision but consecutive helpers can
  // collide on the same ms; force a 2ms gap so ordering is deterministic.
  await new Promise(r => setTimeout(r, 5));
  moveTaskToInitiative(taskId, b.id, null, 'shift');
  await new Promise(r => setTimeout(r, 5));
  moveTaskToInitiative(taskId, null, null, 'detach');

  const rows = getTaskInitiativeHistory(taskId);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].from_initiative_id, null);
  assert.equal(rows[0].to_initiative_title, 'Alpha');
  assert.equal(rows[1].from_initiative_title, 'Alpha');
  assert.equal(rows[1].to_initiative_title, 'Beta');
  // null initiative_id must not break the join — column is null, not undefined.
  assert.equal(rows[2].to_initiative_id, null);
  assert.equal(rows[2].to_initiative_title, null);
});

// ─── emitConvertEvent ─────────────────────────────────────────────────

test('emitConvertEvent writes an initiative_kind_changed row when kinds differ', () => {
  const init = createInitiative({ workspace_id: 'default', kind: 'story', title: 'C' });
  convertInitiative(init.id, 'epic');
  emitConvertEvent({
    initiative_id: init.id,
    initiative_title: init.title,
    from_kind: 'story',
    to_kind: 'epic',
    reason: 'scope grew',
  });

  const events = queryAll<{ type: string; metadata: string | null }>(
    "SELECT type, metadata FROM events WHERE type = 'initiative_kind_changed'",
  );
  const matching = events.find(e => e.metadata && e.metadata.includes(init.id));
  assert.ok(matching, 'event row not found');
  const meta = JSON.parse(matching!.metadata!);
  assert.equal(meta.from_kind, 'story');
  assert.equal(meta.to_kind, 'epic');
  assert.equal(meta.reason, 'scope grew');
});

test('emitConvertEvent is a no-op when from_kind === to_kind', () => {
  const init = createInitiative({ workspace_id: 'default', kind: 'story', title: 'D' });
  const beforeCount = queryOne<{ n: number }>(
    "SELECT COUNT(*) as n FROM events WHERE type = 'initiative_kind_changed'",
  )!.n;
  emitConvertEvent({
    initiative_id: init.id,
    initiative_title: init.title,
    from_kind: 'story',
    to_kind: 'story',
  });
  const afterCount = queryOne<{ n: number }>(
    "SELECT COUNT(*) as n FROM events WHERE type = 'initiative_kind_changed'",
  )!.n;
  assert.equal(afterCount, beforeCount);
});

// ─── end-to-end provenance trace ──────────────────────────────────────

test('end-to-end: idea → initiative → draft → move → promote-to-inbox preserves full provenance', async () => {
  // Idea
  const productId = seedProduct();
  const ideaId = seedIdea({ productId, title: 'Big idea' });

  // Promote idea → initiative A
  const { initiative: a } = promoteIdeaToInitiative(ideaId);
  assert.equal(a.title, 'Big idea');
  assert.equal(a.source_idea_id, ideaId);

  // Decompose: another initiative B in the same workspace
  const b = createInitiative({ workspace_id: a.workspace_id, kind: 'story', title: 'Spinoff' });

  // Promote A to draft task
  const { id: taskId } = promoteInitiativeToTask(a.id, { task_title: 'Build it' });

  // Re-parent draft to B (gap ensures audit row ordering is deterministic).
  await new Promise(r => setTimeout(r, 5));
  moveTaskToInitiative(taskId, b.id, null, 'rescoped');

  // Promote draft → inbox
  promoteTaskToInbox(taskId);

  // Final state
  const task = queryOne<{ initiative_id: string; status: string }>(
    'SELECT initiative_id, status FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(task?.initiative_id, b.id);
  assert.equal(task?.status, 'inbox');

  const history = queryAll<{ from_initiative_id: string | null; to_initiative_id: string | null }>(
    'SELECT from_initiative_id, to_initiative_id FROM task_initiative_history WHERE task_id = ? ORDER BY created_at',
    [taskId],
  );
  assert.equal(history.length, 2);
  assert.equal(history[0].from_initiative_id, null);
  assert.equal(history[0].to_initiative_id, a.id);
  assert.equal(history[1].from_initiative_id, a.id);
  assert.equal(history[1].to_initiative_id, b.id);

  // Idea still references its original initiative A
  const idea = queryOne<{ initiative_id: string }>(
    'SELECT initiative_id FROM ideas WHERE id = ?',
    [ideaId],
  );
  assert.equal(idea?.initiative_id, a.id);
});
