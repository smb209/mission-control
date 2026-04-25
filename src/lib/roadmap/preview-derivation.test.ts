/**
 * previewDerivation tests (Phase 5).
 *
 * Coverage:
 *   - Returns the same schedule applyDerivation WOULD have written, but
 *     writes nothing.
 *   - Velocity overrides apply on top of the computed map.
 *   - Availability overrides layer on top of the snapshot's existing
 *     rows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  RoadmapDependency,
  RoadmapInitiative,
  RoadmapOwnerAvailability,
  RoadmapSnapshot,
} from '@/lib/db/roadmap';
import { previewDerivation } from './apply-derivation';
import { deriveSchedule } from './derive';

const TODAY = '2026-04-13';

function init(p: Partial<RoadmapInitiative> & { id: string }): RoadmapInitiative {
  return {
    id: p.id,
    parent_initiative_id: p.parent_initiative_id ?? null,
    product_id: null,
    kind: p.kind ?? 'story',
    title: p.title ?? p.id,
    status: 'planned',
    owner_agent_id: p.owner_agent_id ?? null,
    owner_agent_name: null,
    complexity: p.complexity ?? null,
    estimated_effort_hours: p.estimated_effort_hours ?? null,
    target_start: p.target_start ?? null,
    target_end: p.target_end ?? null,
    derived_start: p.derived_start ?? null,
    derived_end: p.derived_end ?? null,
    committed_end: p.committed_end ?? null,
    status_check_md: null,
    sort_order: 0,
    depth: 0,
    task_counts: { draft: 0, active: 0, done: 0, total: 0 },
  };
}

function snap(opts: {
  initiatives: RoadmapInitiative[];
  dependencies?: RoadmapDependency[];
  owner_availability?: RoadmapOwnerAvailability[];
}): RoadmapSnapshot {
  return {
    initiatives: opts.initiatives,
    dependencies: opts.dependencies ?? [],
    tasks: [],
    owner_availability: opts.owner_availability ?? [],
    workspace_id: 'test',
    product_id: null,
    truncated: false,
  };
}

test('previewDerivation matches deriveSchedule output for the same inputs', () => {
  const s = snap({
    initiatives: [
      init({ id: 'A', estimated_effort_hours: 24, owner_agent_id: 'sarah' }),
      init({ id: 'B', estimated_effort_hours: 12, owner_agent_id: 'sarah' }),
    ],
  });

  const direct = deriveSchedule(s, { today: TODAY });
  const preview = previewDerivation(s, { today: TODAY });
  for (const i of s.initiatives) {
    const d = direct.schedule.get(i.id);
    const p = preview.derived.schedule.get(i.id);
    assert.deepEqual(p, d, `schedule mismatch for ${i.id}`);
  }
});

test('previewDerivation produces a diff list against the snapshot stored derived_*', () => {
  const s = snap({
    initiatives: [
      init({
        id: 'A',
        estimated_effort_hours: 24,
        owner_agent_id: 'sarah',
        // Pretend a stale stored value.
        derived_start: '2020-01-01',
        derived_end: '2020-01-05',
      }),
    ],
  });
  const result = previewDerivation(s, { today: TODAY });
  assert.equal(result.diffs.length, 1);
  assert.equal(result.diffs[0].initiative_id, 'A');
  assert.notEqual(result.diffs[0].after.derived_start, '2020-01-01');
});

test('previewDerivation: availabilityOverrides push derived_end later', () => {
  const s = snap({
    initiatives: [
      init({ id: 'A', estimated_effort_hours: 6, owner_agent_id: 'sarah' }), // 1 day
    ],
  });

  const before = previewDerivation(s, { today: TODAY });
  const beforeEnd = before.derived.schedule.get('A')?.derived_end;

  const after = previewDerivation(s, {
    today: TODAY,
    availabilityOverrides: [
      { agent_id: 'sarah', unavailable_start: TODAY, unavailable_end: '2026-04-20', reason: null },
    ],
  });
  const afterEnd = after.derived.schedule.get('A')?.derived_end;

  assert.ok(beforeEnd, 'must have a baseline end');
  assert.ok(afterEnd, 'preview must produce an end');
  assert.ok(
    afterEnd! > beforeEnd!,
    `availability override should push derived_end later: before=${beforeEnd} after=${afterEnd}`,
  );
});

test('previewDerivation: velocityOverrides slow the schedule down', () => {
  const s = snap({
    initiatives: [
      init({ id: 'A', estimated_effort_hours: 12, owner_agent_id: 'sarah' }),
    ],
  });

  // 0.5 ratio = 50% velocity = work takes twice as long.
  const slow = previewDerivation(s, {
    today: TODAY,
    velocityOverrides: { sarah: 0.5 },
  });
  const fast = previewDerivation(s, {
    today: TODAY,
    velocityOverrides: { sarah: 1.0 },
  });

  const slowEnd = slow.derived.schedule.get('A')?.derived_end;
  const fastEnd = fast.derived.schedule.get('A')?.derived_end;
  assert.ok(slowEnd && fastEnd);
  assert.ok(slowEnd! >= fastEnd!, `slower velocity must finish later: slow=${slowEnd} fast=${fastEnd}`);
});

test('previewDerivation does NOT mutate the input snapshot', () => {
  const s = snap({
    initiatives: [init({ id: 'A', estimated_effort_hours: 6, owner_agent_id: 'sarah' })],
    owner_availability: [
      { id: 'orig', agent_id: 'sarah', unavailable_start: '2026-06-01', unavailable_end: '2026-06-02', reason: null },
    ],
  });
  const beforeAvailLen = s.owner_availability.length;
  previewDerivation(s, {
    today: TODAY,
    availabilityOverrides: [
      { agent_id: 'sarah', unavailable_start: '2026-04-15', unavailable_end: '2026-04-20', reason: null },
    ],
  });
  assert.equal(s.owner_availability.length, beforeAvailLen);
});
