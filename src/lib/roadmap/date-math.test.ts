/**
 * Tests for the roadmap date-math helpers (Phase 3).
 *
 * Focus: round-trip, snap-to-day, range clipping, edge cases.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PX_PER_DAY,
  addDays,
  axisTicks,
  daysBetween,
  dateToPx,
  defaultWindow,
  formatTick,
  pxToDate,
  rangeWidthPx,
  snapToDay,
  toIsoDay,
  toUtcDay,
  windowsOverlap,
} from './date-math';

// ─── toUtcDay / addDays / daysBetween ──────────────────────────────

test('toUtcDay normalizes ISO date strings to UTC midnight', () => {
  const d = toUtcDay('2026-04-24');
  assert.equal(d.getUTCFullYear(), 2026);
  assert.equal(d.getUTCMonth(), 3); // April
  assert.equal(d.getUTCDate(), 24);
  assert.equal(d.getUTCHours(), 0);
});

test('toUtcDay accepts full ISO timestamps and snaps to that day', () => {
  const d = toUtcDay('2026-04-24T17:30:00Z');
  assert.equal(toIsoDay(d), '2026-04-24');
});

test('toUtcDay throws on garbage input', () => {
  assert.throws(() => toUtcDay('not-a-date'));
});

test('daysBetween is signed and integer', () => {
  assert.equal(daysBetween('2026-04-24', '2026-04-25'), 1);
  assert.equal(daysBetween('2026-04-25', '2026-04-24'), -1);
  assert.equal(daysBetween('2026-04-24', '2026-04-24'), 0);
});

test('daysBetween crosses month/year boundaries cleanly', () => {
  assert.equal(daysBetween('2026-01-31', '2026-02-01'), 1);
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
  assert.equal(daysBetween('2026-04-01', '2026-05-01'), 30);
});

test('addDays plus daysBetween round-trip', () => {
  const start = '2026-04-24';
  for (const n of [-30, -1, 0, 1, 7, 90, 365]) {
    const d = addDays(start, n);
    assert.equal(daysBetween(start, d), n);
  }
});

// ─── dateToPx / pxToDate round-trip ────────────────────────────────

test('dateToPx is linear in days', () => {
  const ws = '2026-04-01';
  for (const z of ['week', 'month', 'quarter'] as const) {
    const ppd = PX_PER_DAY[z];
    assert.equal(dateToPx(ws, ws, ppd), 0);
    assert.equal(dateToPx('2026-04-15', ws, ppd), 14 * ppd);
    assert.equal(dateToPx('2026-03-25', ws, ppd), -7 * ppd);
  }
});

test('pxToDate inverts dateToPx for snapped values', () => {
  const ws = '2026-04-01';
  const ppd = PX_PER_DAY.month;
  for (const days of [-10, 0, 1, 14, 90]) {
    const date = addDays(ws, days);
    const px = dateToPx(date, ws, ppd);
    const back = pxToDate(px, ws, ppd);
    assert.equal(toIsoDay(back), toIsoDay(date));
  }
});

test('pxToDate snaps to nearest day at fractional pixel offsets', () => {
  const ws = '2026-04-01';
  const ppd = PX_PER_DAY.month; // 8 px/day
  // 12 px → 1.5 days → rounds to 2 → Apr 03
  assert.equal(toIsoDay(pxToDate(12, ws, ppd)), '2026-04-03');
  // 3 px → 0.375 → rounds to 0 → Apr 01
  assert.equal(toIsoDay(pxToDate(3, ws, ppd)), '2026-04-01');
});

test('pxToDate rejects non-positive pxPerDay', () => {
  assert.throws(() => pxToDate(10, '2026-04-01', 0));
  assert.throws(() => pxToDate(10, '2026-04-01', -1));
});

test('snapToDay alias matches toUtcDay', () => {
  const a = snapToDay('2026-04-24T13:00:00Z');
  const b = toUtcDay('2026-04-24T13:00:00Z');
  assert.equal(a.getTime(), b.getTime());
});

// ─── rangeWidthPx ──────────────────────────────────────────────────

test('rangeWidthPx is inclusive: same-day is one day wide', () => {
  const ppd = 8;
  assert.equal(rangeWidthPx('2026-04-24', '2026-04-24', ppd), ppd);
});

test('rangeWidthPx grows linearly with span', () => {
  const ppd = 8;
  assert.equal(rangeWidthPx('2026-04-01', '2026-04-08', ppd), 8 * ppd);
});

test('rangeWidthPx returns 0 when end < start', () => {
  assert.equal(rangeWidthPx('2026-04-08', '2026-04-01', 8), 0);
});

// ─── windowsOverlap ────────────────────────────────────────────────

test('windowsOverlap: clear overlap', () => {
  assert.equal(windowsOverlap('2026-04-01', '2026-04-30', '2026-04-15', '2026-05-15'), true);
});

test('windowsOverlap: clear miss', () => {
  assert.equal(windowsOverlap('2026-04-01', '2026-04-15', '2026-05-01', '2026-05-15'), false);
});

test('windowsOverlap: edge-touching counts as overlap (inclusive)', () => {
  assert.equal(windowsOverlap('2026-04-01', '2026-04-15', '2026-04-15', '2026-04-30'), true);
});

test('windowsOverlap: missing endpoints behave as unbounded', () => {
  // a is unbounded → always overlaps anything
  assert.equal(windowsOverlap(null, null, '2026-04-01', '2026-04-15'), true);
  // a starts before, no upper bound → overlaps later windows
  assert.equal(windowsOverlap('2026-04-01', null, '2030-01-01', '2030-12-31'), true);
});

// ─── defaultWindow ─────────────────────────────────────────────────

test('defaultWindow includes today and pads', () => {
  const today = '2026-04-24';
  const w = defaultWindow([], today);
  assert.ok(daysBetween(w.start, today) >= 14);
  assert.ok(daysBetween(today, w.end) >= 14);
});

test('defaultWindow expands to cover provided dates', () => {
  const today = '2026-04-24';
  const w = defaultWindow(['2026-01-01', '2026-12-31'], today);
  assert.ok(toIsoDay(w.start) <= '2025-12-18'); // padded by 14d before Jan 1
  assert.ok(toIsoDay(w.end) >= '2027-01-14');
});

test('defaultWindow ignores nulls', () => {
  // Should not throw or produce NaN.
  const w = defaultWindow([null, undefined, '2026-04-24'], '2026-04-24');
  assert.ok(w.start instanceof Date);
  assert.ok(!isNaN(w.start.getTime()));
});

// ─── axisTicks / formatTick ────────────────────────────────────────

test('axisTicks: month zoom returns month boundaries', () => {
  const t = axisTicks('2026-04-10', '2026-07-15', 'month');
  // First-of-May, June, July.
  assert.deepEqual(t.map(toIsoDay), ['2026-05-01', '2026-06-01', '2026-07-01']);
});

test('axisTicks: quarter zoom returns quarter starts', () => {
  const t = axisTicks('2026-02-01', '2026-12-31', 'quarter');
  assert.deepEqual(t.map(toIsoDay), ['2026-04-01', '2026-07-01', '2026-10-01']);
});

test('axisTicks: week zoom returns Mondays', () => {
  // 2026-04-20 is a Monday.
  const t = axisTicks('2026-04-18', '2026-05-05', 'week');
  assert.deepEqual(t.map(toIsoDay), ['2026-04-20', '2026-04-27', '2026-05-04']);
});

test('axisTicks: returns empty when end < start', () => {
  assert.deepEqual(axisTicks('2026-04-30', '2026-04-01', 'month'), []);
});

test('formatTick produces stable labels', () => {
  assert.equal(formatTick(toUtcDay('2026-04-01'), 'month'), 'Apr');
  assert.equal(formatTick(toUtcDay('2026-01-01'), 'month'), 'Jan 2026');
  assert.equal(formatTick(toUtcDay('2026-04-01'), 'quarter'), 'Q2 2026');
  assert.equal(formatTick(toUtcDay('2026-04-20'), 'week'), 'Apr 20');
});

// ─── degenerate / zero-length ranges ───────────────────────────────

test('zero-length range still renders one day wide', () => {
  const ws = '2026-04-01';
  const ppd = PX_PER_DAY.month;
  const start = dateToPx('2026-04-15', ws, ppd);
  const w = rangeWidthPx('2026-04-15', '2026-04-15', ppd);
  assert.equal(start, 14 * ppd);
  assert.equal(w, ppd);
});

test('range outside the visible window: dateToPx still produces signed coords', () => {
  // Caller is responsible for clipping in render; date math doesn't constrain.
  const ws = '2026-04-01';
  const ppd = PX_PER_DAY.month;
  // 90 days before window start.
  assert.equal(dateToPx('2026-01-01', ws, ppd), -90 * ppd);
  // Far into future.
  assert.ok(dateToPx('2027-04-01', ws, ppd) > 0);
});
