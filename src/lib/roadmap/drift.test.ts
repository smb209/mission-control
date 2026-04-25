/**
 * Drift detector tests (Phase 4).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { detectDrift, SLIPPAGE_THRESHOLD_DAYS } from './drift';
import type { DeriveResult } from './derive';
import type { RoadmapInitiative, RoadmapSnapshot } from '@/lib/db/roadmap';

function init(p: Partial<RoadmapInitiative> & { id: string }): RoadmapInitiative {
  return {
    id: p.id,
    parent_initiative_id: p.parent_initiative_id ?? null,
    product_id: null,
    kind: p.kind ?? 'story',
    title: p.id,
    status: p.status ?? 'planned',
    owner_agent_id: null,
    owner_agent_name: null,
    complexity: null,
    estimated_effort_hours: null,
    target_start: null,
    target_end: p.target_end ?? null,
    derived_start: null,
    derived_end: null,
    committed_end: p.committed_end ?? null,
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

function derivedResult(map: Record<string, { start: string | null; end: string | null }>, opts: Partial<DeriveResult> = {}): DeriveResult {
  const schedule = new Map<string, { derived_start: string | null; derived_end: string | null }>();
  for (const [id, v] of Object.entries(map)) {
    schedule.set(id, { derived_start: v.start, derived_end: v.end });
  }
  return {
    schedule,
    cycle: opts.cycle ?? [],
    noEffort: opts.noEffort ?? [],
    warnings: opts.warnings ?? [],
  };
}

test('milestone_at_risk fires when derived_end exceeds committed_end', () => {
  const s = snap([
    init({ id: 'm', kind: 'milestone', committed_end: '2026-05-01' }),
  ]);
  const d = derivedResult({ m: { start: '2026-04-01', end: '2026-05-10' } });
  const events = detectDrift(s, d);
  const m = events.find(e => e.kind === 'milestone_at_risk');
  assert.ok(m && m.kind === 'milestone_at_risk');
  if (m && m.kind === 'milestone_at_risk') {
    assert.equal(m.initiative_id, 'm');
    assert.equal(m.committed_end, '2026-05-01');
    assert.equal(m.derived_end, '2026-05-10');
    assert.equal(m.days_over, 9);
  }
});

test('milestone_at_risk does NOT fire when on schedule', () => {
  const s = snap([
    init({ id: 'm', kind: 'milestone', committed_end: '2026-05-01' }),
  ]);
  const d = derivedResult({ m: { start: '2026-04-01', end: '2026-04-30' } });
  const events = detectDrift(s, d);
  assert.equal(events.filter(e => e.kind === 'milestone_at_risk').length, 0);
});

test('slippage fires past threshold; does not fire below threshold', () => {
  const s = snap([
    init({ id: 'a', target_end: '2026-04-30' }),
    init({ id: 'b', target_end: '2026-04-30' }),
  ]);
  // a: derived 2 days past target → below threshold (3); no event.
  // b: derived 5 days past target → fires.
  const d = derivedResult({
    a: { start: '2026-04-01', end: '2026-05-02' },
    b: { start: '2026-04-01', end: '2026-05-05' },
  });
  const events = detectDrift(s, d);
  const slips = events.filter(e => e.kind === 'slippage');
  assert.equal(slips.length, 1);
  if (slips[0].kind === 'slippage') {
    assert.equal(slips[0].initiative_id, 'b');
    assert.equal(slips[0].days_over, 5);
  }
  // Threshold sanity.
  assert.ok(SLIPPAGE_THRESHOLD_DAYS > 0);
});

test('milestones do not fire generic slippage (their kind has its own event)', () => {
  const s = snap([
    init({ id: 'm', kind: 'milestone', committed_end: '2026-05-01', target_end: '2026-05-01' }),
  ]);
  const d = derivedResult({ m: { start: '2026-04-01', end: '2026-05-10' } });
  const events = detectDrift(s, d);
  // Only the milestone_at_risk event, not a duplicate slippage event.
  assert.equal(events.filter(e => e.kind === 'slippage').length, 0);
  assert.equal(events.filter(e => e.kind === 'milestone_at_risk').length, 1);
});

test('cycle_detected event lists all members', () => {
  const s = snap([
    init({ id: 'a' }),
    init({ id: 'b' }),
  ]);
  const events = detectDrift(s, derivedResult({}, { cycle: ['a', 'b'] }));
  const c = events.find(e => e.kind === 'cycle_detected');
  assert.ok(c && c.kind === 'cycle_detected');
  if (c && c.kind === 'cycle_detected') {
    assert.deepEqual(c.initiative_ids.sort(), ['a', 'b']);
  }
});

test('no_effort_signal walks up to nearest milestone ancestor', () => {
  const s = snap([
    init({ id: 'm', kind: 'milestone', committed_end: '2026-06-01' }),
    init({ id: 'epic', kind: 'epic', parent_initiative_id: 'm' }),
    init({ id: 'orphan-story', kind: 'story', parent_initiative_id: 'epic' }),
  ]);
  const events = detectDrift(s, derivedResult({}, { noEffort: ['orphan-story'] }));
  const ne = events.find(e => e.kind === 'no_effort_signal');
  assert.ok(ne && ne.kind === 'no_effort_signal');
  if (ne && ne.kind === 'no_effort_signal') {
    assert.equal(ne.initiative_id, 'orphan-story');
    assert.equal(ne.ancestor_milestone_id, 'm');
  }
});

test('no_effort_signal with no milestone ancestor leaves ancestor_milestone_id undefined', () => {
  const s = snap([init({ id: 'a', kind: 'story' })]);
  const events = detectDrift(s, derivedResult({}, { noEffort: ['a'] }));
  const ne = events.find(e => e.kind === 'no_effort_signal');
  if (ne && ne.kind === 'no_effort_signal') {
    assert.equal(ne.ancestor_milestone_id, undefined);
  }
});

test('non-drifting initiatives produce no events', () => {
  const s = snap([
    init({ id: 'a', target_end: '2026-04-30' }),
    init({ id: 'm', kind: 'milestone', committed_end: '2026-05-01' }),
  ]);
  const d = derivedResult({
    a: { start: '2026-04-01', end: '2026-04-29' },
    m: { start: '2026-04-01', end: '2026-04-30' },
  });
  const events = detectDrift(s, d);
  assert.equal(events.length, 0);
});
