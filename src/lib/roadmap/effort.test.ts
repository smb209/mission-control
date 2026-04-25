/**
 * Effort helper tests (Phase 4).
 *
 * Pure-function tests — no DB needed; build mini snapshots in-memory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPLEXITY_HOURS,
  getEffectiveEffortHours,
  rollupEffort,
} from './effort';
import type { RoadmapInitiative, RoadmapSnapshot } from '@/lib/db/roadmap';

function init(partial: Partial<RoadmapInitiative> & { id: string; kind?: RoadmapInitiative['kind'] }): RoadmapInitiative {
  return {
    id: partial.id,
    parent_initiative_id: partial.parent_initiative_id ?? null,
    product_id: null,
    kind: partial.kind ?? 'story',
    title: partial.id,
    status: 'planned',
    owner_agent_id: partial.owner_agent_id ?? null,
    owner_agent_name: null,
    complexity: partial.complexity ?? null,
    estimated_effort_hours: partial.estimated_effort_hours ?? null,
    target_start: partial.target_start ?? null,
    target_end: partial.target_end ?? null,
    derived_start: partial.derived_start ?? null,
    derived_end: partial.derived_end ?? null,
    committed_end: partial.committed_end ?? null,
    status_check_md: null,
    sort_order: 0,
    depth: 0,
    task_counts: { draft: 0, active: 0, done: 0, total: 0 },
  };
}

function snap(initiatives: RoadmapInitiative[]): RoadmapSnapshot {
  return {
    initiatives,
    dependencies: [],
    tasks: [],
    owner_availability: [],
    workspace_id: 'test',
    product_id: null,
    truncated: false,
  };
}

test('getEffectiveEffortHours prefers explicit hours when both set', () => {
  assert.equal(
    getEffectiveEffortHours({ estimated_effort_hours: 7, complexity: 'L' }),
    7,
  );
});

test('getEffectiveEffortHours falls back to complexity table', () => {
  assert.equal(getEffectiveEffortHours({ complexity: 'M' }), COMPLEXITY_HOURS.M);
  assert.equal(getEffectiveEffortHours({ complexity: 'XL' }), 120);
});

test('getEffectiveEffortHours returns null when neither field set', () => {
  assert.equal(getEffectiveEffortHours({}), null);
});

test('getEffectiveEffortHours treats zero hours as missing', () => {
  // zero is not a useful estimate; complexity should win
  assert.equal(
    getEffectiveEffortHours({ estimated_effort_hours: 0, complexity: 'S' }),
    COMPLEXITY_HOURS.S,
  );
});

test('rollupEffort returns own effort when leaf', () => {
  const s = snap([init({ id: 'a', estimated_effort_hours: 10 })]);
  assert.equal(rollupEffort('a', s), 10);
});

test('rollupEffort sums leaf descendants for a container', () => {
  const s = snap([
    init({ id: 'epic', kind: 'epic' }),
    init({ id: 'a', parent_initiative_id: 'epic', estimated_effort_hours: 10 }),
    init({ id: 'b', parent_initiative_id: 'epic', complexity: 'M' }), // 12
    init({ id: 'c', parent_initiative_id: 'epic', estimated_effort_hours: 5 }),
  ]);
  assert.equal(rollupEffort('epic', s), 10 + 12 + 5);
});

test('rollupEffort recurses through grandchildren', () => {
  const s = snap([
    init({ id: 'milestone', kind: 'milestone' }),
    init({ id: 'epic', kind: 'epic', parent_initiative_id: 'milestone' }),
    init({ id: 'story1', parent_initiative_id: 'epic', complexity: 'L' }), // 40
    init({ id: 'story2', parent_initiative_id: 'epic', complexity: 'S' }), // 4
  ]);
  assert.equal(rollupEffort('milestone', s), 44);
});

test('rollupEffort falls back to container effort when no descendant signal', () => {
  // Epic has children but none have estimates yet; epic has its own.
  const s = snap([
    init({ id: 'epic', kind: 'epic', estimated_effort_hours: 40 }),
    init({ id: 'a', parent_initiative_id: 'epic' }),
    init({ id: 'b', parent_initiative_id: 'epic' }),
  ]);
  assert.equal(rollupEffort('epic', s), 40);
});

test('rollupEffort returns null when nothing has effort', () => {
  const s = snap([
    init({ id: 'epic', kind: 'epic' }),
    init({ id: 'a', parent_initiative_id: 'epic' }),
  ]);
  assert.equal(rollupEffort('epic', s), null);
});

test('rollupEffort skips children with no effort but uses ones that do', () => {
  const s = snap([
    init({ id: 'epic', kind: 'epic' }),
    init({ id: 'a', parent_initiative_id: 'epic', estimated_effort_hours: 8 }),
    init({ id: 'b', parent_initiative_id: 'epic' }), // no signal — contributes 0
  ]);
  assert.equal(rollupEffort('epic', s), 8);
});
