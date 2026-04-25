/**
 * Derivation engine tests (Phase 4).
 *
 * Pure-function tests with hand-built snapshots and fixed `today` for
 * deterministic output. We pin `today = 2026-04-13` (a Monday) so business-
 * day arithmetic is unambiguous in expectations.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSchedule, HOURS_PER_DAY } from './derive';
import type {
  RoadmapDependency,
  RoadmapInitiative,
  RoadmapOwnerAvailability,
  RoadmapSnapshot,
} from '@/lib/db/roadmap';
import { addDays, daysBetween, toIsoDay } from './date-math';

const TODAY = '2026-04-13'; // Monday

function init(p: Partial<RoadmapInitiative> & { id: string }): RoadmapInitiative {
  return {
    id: p.id,
    parent_initiative_id: p.parent_initiative_id ?? null,
    product_id: null,
    kind: p.kind ?? 'story',
    title: p.id,
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

function dep(from: string, to: string, kind: string = 'finish_to_start'): RoadmapDependency {
  return {
    id: `${from}-${to}`,
    initiative_id: from,
    depends_on_initiative_id: to,
    kind,
    note: null,
  };
}

function avail(agent: string, start: string, end: string): RoadmapOwnerAvailability {
  return { id: `${agent}-${start}`, agent_id: agent, unavailable_start: start, unavailable_end: end, reason: null };
}

// ─── Determinism + basic schedule ──────────────────────────────────

test('leaf initiative with effort schedules from today', () => {
  // 6 hours = 1 effective day (HOURS_PER_DAY = 6).
  const s = snap({
    initiatives: [init({ id: 'a', estimated_effort_hours: 6 })],
  });
  const { schedule } = deriveSchedule(s, { today: TODAY });
  const r = schedule.get('a')!;
  assert.equal(r.derived_start, TODAY);
  // 1 effective day, business-day inclusive: same day.
  assert.equal(r.derived_end, TODAY);
});

test('multi-day effort spans business days, skipping weekend', () => {
  // 24 hours = 4 effective days.
  const s = snap({
    initiatives: [init({ id: 'a', estimated_effort_hours: 24 })],
  });
  const { schedule } = deriveSchedule(s, { today: TODAY });
  const r = schedule.get('a')!;
  // Mon → Thu (4 business days inclusive).
  assert.equal(r.derived_start, '2026-04-13'); // Mon
  assert.equal(r.derived_end, '2026-04-16'); // Thu
});

test('effort that crosses a weekend skips Sat+Sun', () => {
  // 36 hours = 6 effective days. Mon → following Mon (skipping Sat/Sun).
  const s = snap({
    initiatives: [init({ id: 'a', estimated_effort_hours: 36 })],
  });
  const { schedule } = deriveSchedule(s, { today: TODAY });
  const r = schedule.get('a')!;
  assert.equal(r.derived_start, '2026-04-13'); // Mon
  assert.equal(r.derived_end, '2026-04-20'); // Mon next week (skipping Apr 18-19)
});

test('initiative with no effort signal gets NULL derived_*', () => {
  const s = snap({
    initiatives: [init({ id: 'a' })],
  });
  const { schedule, noEffort } = deriveSchedule(s, { today: TODAY });
  assert.equal(schedule.get('a')?.derived_start, null);
  assert.equal(schedule.get('a')?.derived_end, null);
  assert.deepEqual(noEffort, ['a']);
});

// ─── Dependencies ──────────────────────────────────────────────────

test('linear chain A→B→C: derived_end of C is past A+B+C effort', () => {
  // A,B,C each 6 hours = 1 day.
  const s = snap({
    initiatives: [
      init({ id: 'A', estimated_effort_hours: 6 }),
      init({ id: 'B', estimated_effort_hours: 6 }),
      init({ id: 'C', estimated_effort_hours: 6 }),
    ],
    dependencies: [dep('B', 'A'), dep('C', 'B')],
  });
  const { schedule } = deriveSchedule(s, { today: TODAY });
  // A: Mon(13). B: Tue(14). C: Wed(15).
  assert.equal(schedule.get('A')!.derived_end, '2026-04-13');
  assert.equal(schedule.get('B')!.derived_end, '2026-04-14');
  assert.equal(schedule.get('C')!.derived_end, '2026-04-15');
});

test('multi-prereq: C waits for max(A.end, B.end)', () => {
  const s = snap({
    initiatives: [
      // A finishes faster than B.
      init({ id: 'A', estimated_effort_hours: 6 }),  // 1 day
      init({ id: 'B', estimated_effort_hours: 18 }), // 3 days, ends Wed
      init({ id: 'C', estimated_effort_hours: 6 }),  // 1 day
    ],
    dependencies: [dep('C', 'A'), dep('C', 'B')],
  });
  const { schedule } = deriveSchedule(s, { today: TODAY });
  // C starts day after B ends (Wed 15) → Thu 16.
  assert.equal(schedule.get('B')!.derived_end, '2026-04-15');
  assert.equal(schedule.get('C')!.derived_start, '2026-04-16');
  assert.equal(schedule.get('C')!.derived_end, '2026-04-16');
});

test('start_to_start dep: B can start when A starts (not when A ends)', () => {
  const s = snap({
    initiatives: [
      init({ id: 'A', estimated_effort_hours: 18 }), // 3 days
      init({ id: 'B', estimated_effort_hours: 6 }),  // 1 day
    ],
    dependencies: [dep('B', 'A', 'start_to_start')],
  });
  const { schedule } = deriveSchedule(s, { today: TODAY });
  // A: Mon-Wed; B starts same day as A (Mon).
  assert.equal(schedule.get('A')!.derived_start, '2026-04-13');
  assert.equal(schedule.get('B')!.derived_start, '2026-04-13');
});

test('informational dep is non-blocking', () => {
  const s = snap({
    initiatives: [
      init({ id: 'A', estimated_effort_hours: 24 }), // 4 days
      init({ id: 'B', estimated_effort_hours: 6 }),
    ],
    dependencies: [dep('B', 'A', 'informational')],
  });
  const { schedule } = deriveSchedule(s, { today: TODAY });
  // B doesn't wait for A.
  assert.equal(schedule.get('B')!.derived_start, TODAY);
});

// ─── Cycles ────────────────────────────────────────────────────────

test('cycle members get NULL; non-cycle initiatives compute normally', () => {
  const s = snap({
    initiatives: [
      init({ id: 'X', estimated_effort_hours: 6 }), // outside the cycle
      init({ id: 'A', estimated_effort_hours: 6 }),
      init({ id: 'B', estimated_effort_hours: 6 }),
      init({ id: 'C', estimated_effort_hours: 6 }),
    ],
    // A → B → C → A (cycle); X is independent.
    dependencies: [dep('A', 'B'), dep('B', 'C'), dep('C', 'A')],
  });
  const { schedule, cycle, warnings } = deriveSchedule(s, { today: TODAY });
  assert.deepEqual([...cycle].sort(), ['A', 'B', 'C']);
  for (const id of ['A', 'B', 'C']) {
    assert.equal(schedule.get(id)?.derived_start, null);
    assert.equal(schedule.get(id)?.derived_end, null);
  }
  assert.equal(schedule.get('X')!.derived_start, TODAY);
  assert.ok(warnings.some(w => w.toLowerCase().includes('cycle')));
});

// ─── Owner availability ────────────────────────────────────────────

test('owner availability overlap pushes derived_end later by overlap business days', () => {
  // 18 hours = 3 effective days. Owner unavailable Tue-Wed (2 business days).
  const s = snap({
    initiatives: [
      init({ id: 'A', estimated_effort_hours: 18, owner_agent_id: 'sarah' }),
    ],
    owner_availability: [avail('sarah', '2026-04-14', '2026-04-15')], // Tue-Wed
  });
  const { schedule } = deriveSchedule(s, { today: TODAY });
  // Without availability: Mon-Wed (Apr 13-15).
  // With availability: 2 business days inside that window → push 2 days.
  // New end: Fri Apr 17.
  const r = schedule.get('A')!;
  assert.equal(r.derived_start, '2026-04-13');
  assert.equal(r.derived_end, '2026-04-17');
});

test('availability with no overlap leaves schedule alone', () => {
  const s = snap({
    initiatives: [
      init({ id: 'A', estimated_effort_hours: 12, owner_agent_id: 'sarah' }),
    ],
    // Far in the future.
    owner_availability: [avail('sarah', '2026-12-01', '2026-12-10')],
  });
  const { schedule } = deriveSchedule(s, { today: TODAY });
  // 12h = 2 days: Mon-Tue.
  assert.equal(schedule.get('A')!.derived_end, '2026-04-14');
});

// ─── Container rollup ──────────────────────────────────────────────

test('container with three stories uses sum of stories', () => {
  // Epic with no own effort, 3 stories = 6+6+12 = 24 hours = 4 days.
  const s = snap({
    initiatives: [
      init({ id: 'epic', kind: 'epic' }),
      init({ id: 's1', parent_initiative_id: 'epic', estimated_effort_hours: 6 }),
      init({ id: 's2', parent_initiative_id: 'epic', estimated_effort_hours: 6 }),
      init({ id: 's3', parent_initiative_id: 'epic', estimated_effort_hours: 12 }),
    ],
  });
  const { schedule } = deriveSchedule(s, { today: TODAY });
  // 24h / 6 = 4 days. Mon-Thu.
  assert.equal(schedule.get('epic')!.derived_end, '2026-04-16');
});

// ─── Velocity ──────────────────────────────────────────────────────

test('velocity ratio < 1 (slow) lengthens schedule', () => {
  // 12 hours / 0.5 velocity = 24 effective hours → 4 days (vs 2 at velocity 1).
  const s = snap({
    initiatives: [
      init({ id: 'A', estimated_effort_hours: 12, owner_agent_id: 'slow' }),
    ],
  });
  const { schedule } = deriveSchedule(s, {
    today: TODAY,
    velocityMap: new Map([['slow', 0.5]]),
  });
  // 4 business days: Mon-Thu.
  assert.equal(schedule.get('A')!.derived_end, '2026-04-16');
});

test('velocity ratio > 1 (fast) shortens schedule', () => {
  // 12 hours / 2 velocity = 6 effective hours → 1 day (vs 2 at velocity 1).
  const s = snap({
    initiatives: [
      init({ id: 'A', estimated_effort_hours: 12, owner_agent_id: 'fast' }),
    ],
  });
  const { schedule } = deriveSchedule(s, {
    today: TODAY,
    velocityMap: new Map([['fast', 2]]),
  });
  assert.equal(schedule.get('A')!.derived_end, TODAY);
});

// ─── Determinism ──────────────────────────────────────────────────

test('repeated runs produce identical output', () => {
  const s = snap({
    initiatives: [
      init({ id: 'A', estimated_effort_hours: 6 }),
      init({ id: 'B', estimated_effort_hours: 12 }),
      init({ id: 'C', estimated_effort_hours: 18 }),
    ],
    dependencies: [dep('B', 'A'), dep('C', 'B')],
  });
  const r1 = deriveSchedule(s, { today: TODAY });
  const r2 = deriveSchedule(s, { today: TODAY });
  for (const id of ['A', 'B', 'C']) {
    assert.deepEqual(r1.schedule.get(id), r2.schedule.get(id));
  }
});

test('today anchor is respected (not new Date)', () => {
  const s = snap({
    initiatives: [init({ id: 'A', estimated_effort_hours: 6 })],
  });
  const { schedule } = deriveSchedule(s, { today: '2030-01-07' }); // Mon
  assert.equal(schedule.get('A')!.derived_start, '2030-01-07');
});

// ─── target_start hint ────────────────────────────────────────────

test('target_start in the future delays start past today', () => {
  const s = snap({
    initiatives: [
      init({
        id: 'A',
        estimated_effort_hours: 6,
        target_start: '2026-05-04', // a Monday
      }),
    ],
  });
  const { schedule } = deriveSchedule(s, { today: TODAY });
  assert.equal(schedule.get('A')!.derived_start, '2026-05-04');
});

// ─── HOURS_PER_DAY constant exposed ───────────────────────────────

test('HOURS_PER_DAY constant is exported and reasonable', () => {
  assert.ok(HOURS_PER_DAY > 0 && HOURS_PER_DAY <= 12);
});

// silence unused
void addDays;
void daysBetween;
void toIsoDay;
