import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldHideSubtaskForCollapse,
  filterTasksForBoard,
  convoyBadgeText,
} from './convoy-board-render';
import type { Task } from './types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? 't-' + Math.random().toString(36).slice(2, 8),
    title: 'mock',
    status: 'inbox',
    priority: 'normal',
    assigned_agent_id: null,
    created_by_agent_id: null,
    workspace_id: 'w-1',
    business_id: 'default',
    created_at: '2026-05-14T00:00:00Z',
    updated_at: '2026-05-14T00:00:00Z',
    ...overrides,
  };
}

test('plain task: not collapsed', () => {
  const t = makeTask({ id: 'plain', is_subtask: 0 });
  assert.equal(shouldHideSubtaskForCollapse(t), false);
});

test('subtask in 1-slice convoy: collapsed (hidden)', () => {
  const t = makeTask({
    id: 'sub-1',
    is_subtask: 1,
    convoy_id: 'c1',
    convoy_total_subtasks: 1,
  });
  assert.equal(shouldHideSubtaskForCollapse(t), true);
});

test('subtask in 3-slice convoy: NOT collapsed (first-class)', () => {
  const t = makeTask({
    id: 'sub-3a',
    is_subtask: 1,
    convoy_id: 'c2',
    convoy_total_subtasks: 3,
  });
  assert.equal(shouldHideSubtaskForCollapse(t), false);
});

test('subtask with null convoy_total_subtasks: not collapsed (defensive)', () => {
  const t = makeTask({
    id: 'sub-orphan',
    is_subtask: 1,
    convoy_id: 'c-missing',
    convoy_total_subtasks: null,
  });
  assert.equal(shouldHideSubtaskForCollapse(t), false);
});

test('filterTasksForBoard: 1-slice convoy parent stays, subtask drops', () => {
  const parent = makeTask({
    id: 'parent-1s',
    status: 'convoy_active',
    convoy_summary: {
      convoy_id: 'c1',
      total_subtasks: 1,
      completed_subtasks: 0,
      failed_subtasks: 0,
      status: 'active',
    },
  });
  const sub = makeTask({
    id: 'sub-1s',
    is_subtask: 1,
    convoy_id: 'c1',
    convoy_total_subtasks: 1,
  });
  const plain = makeTask({ id: 'plain' });

  const rows = filterTasksForBoard([parent, sub, plain]);
  assert.deepEqual(rows.map(r => r.id).sort(), ['parent-1s', 'plain']);
});

test('filterTasksForBoard: 3-slice convoy parent + all 3 subtasks visible', () => {
  const parent = makeTask({
    id: 'parent-3s',
    status: 'convoy_active',
    convoy_summary: {
      convoy_id: 'c2',
      total_subtasks: 3,
      completed_subtasks: 1,
      failed_subtasks: 0,
      status: 'active',
    },
  });
  const subs = [1, 2, 3].map(i =>
    makeTask({ id: `s${i}`, is_subtask: 1, convoy_id: 'c2', convoy_total_subtasks: 3 }),
  );
  const rows = filterTasksForBoard([parent, ...subs]);
  assert.equal(rows.length, 4);
});

test('convoyBadgeText: multi-slice returns badge', () => {
  const t = makeTask({
    convoy_summary: {
      convoy_id: 'c',
      total_subtasks: 3,
      completed_subtasks: 1,
      failed_subtasks: 0,
      status: 'active',
    },
  });
  assert.equal(convoyBadgeText(t), 'Convoy · 3 slices · 1 done');
});

test('convoyBadgeText: failures surfaced', () => {
  const t = makeTask({
    convoy_summary: {
      convoy_id: 'c',
      total_subtasks: 4,
      completed_subtasks: 2,
      failed_subtasks: 1,
      status: 'active',
    },
  });
  assert.equal(convoyBadgeText(t), 'Convoy · 4 slices · 2 done · 1 failed');
});

test('convoyBadgeText: 1-slice convoy returns null (collapsed)', () => {
  const t = makeTask({
    convoy_summary: {
      convoy_id: 'c',
      total_subtasks: 1,
      completed_subtasks: 0,
      failed_subtasks: 0,
      status: 'active',
    },
  });
  assert.equal(convoyBadgeText(t), null);
});

test('convoyBadgeText: no convoy returns null', () => {
  const t = makeTask();
  assert.equal(convoyBadgeText(t), null);
});

test('convoy in done status still renders correctly', () => {
  // Parent auto-promoted to review/done; convoy_summary may still exist
  // until cleanup. The collapse rule is structural, not status-driven.
  const parent = makeTask({
    id: 'p-done',
    status: 'review',
    convoy_summary: {
      convoy_id: 'c',
      total_subtasks: 1,
      completed_subtasks: 1,
      failed_subtasks: 0,
      status: 'done',
    },
  });
  const sub = makeTask({
    id: 's-done',
    status: 'done',
    is_subtask: 1,
    convoy_id: 'c',
    convoy_total_subtasks: 1,
  });
  const rows = filterTasksForBoard([parent, sub]);
  // 1-slice convoy: parent visible, single subtask elided.
  assert.deepEqual(rows.map(r => r.id), ['p-done']);
});
