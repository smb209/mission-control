/**
 * Velocity tests (Phase 4).
 *
 * Pure-function tests against `computeVelocityFromTasks`. The DB-backed
 * `getVelocityRatio` / `computeVelocity` are exercised by the e2e test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeVelocityFromTasks } from './velocity';

test('zero history returns 1.0 (no adjustment)', () => {
  assert.equal(computeVelocityFromTasks([]), 1.0);
});

test('single consistent cost ratio returned as-is', () => {
  // estimated 100, actual 100 → ratio 1.0
  const r = computeVelocityFromTasks([
    { estimated_cost_usd: 100, actual_cost_usd: 100 },
  ]);
  assert.equal(r, 1.0);
});

test('underspend (faster) → ratio > 1', () => {
  // est 100 / act 50 → ratio 2.0
  const r = computeVelocityFromTasks([
    { estimated_cost_usd: 100, actual_cost_usd: 50 },
  ]);
  assert.equal(r, 2.0);
});

test('overspend (slower) → ratio < 1', () => {
  // est 50 / act 100 → ratio 0.5
  const r = computeVelocityFromTasks([
    { estimated_cost_usd: 50, actual_cost_usd: 100 },
  ]);
  assert.equal(r, 0.5);
});

test('mixed signal → averaged', () => {
  // Two samples: 1.0 and 0.5 → average 0.75
  const r = computeVelocityFromTasks([
    { estimated_cost_usd: 100, actual_cost_usd: 100 },
    { estimated_cost_usd: 50, actual_cost_usd: 100 },
  ]);
  assert.equal(r, 0.75);
});

test('skips rows without cost or wall-clock fallback', () => {
  // First two rows give no signal; third has both → ratio 1.0.
  const r = computeVelocityFromTasks([
    {},
    { actual_cost_usd: 100 }, // missing estimated
    { estimated_cost_usd: 100, actual_cost_usd: 100 },
  ]);
  assert.equal(r, 1.0);
});

test('wall-clock fallback uses complexity expected hours', () => {
  // Complexity 'M' = 12 hours expected; actual wall-clock 6 hours → ratio 2.0
  const start = '2026-04-01T00:00:00.000Z';
  const end = '2026-04-01T06:00:00.000Z';
  const r = computeVelocityFromTasks([
    { complexity: 'M', created_at: start, updated_at: end },
  ]);
  assert.equal(r, 2.0);
});

test('extreme ratios are clamped to [0.1, 10]', () => {
  // Insanely fast: est 1000 / act 1 → 1000, clamped to 10
  const fast = computeVelocityFromTasks([
    { estimated_cost_usd: 1000, actual_cost_usd: 1 },
  ]);
  assert.equal(fast, 10);
  // Insanely slow: est 1 / act 1000 → 0.001, clamped to 0.1
  const slow = computeVelocityFromTasks([
    { estimated_cost_usd: 1, actual_cost_usd: 1000 },
  ]);
  assert.equal(slow, 0.1);
});

test('zero or negative cost values are skipped (no divide-by-zero)', () => {
  // Only the second row contributes (1.0); the first two are unusable.
  const r = computeVelocityFromTasks([
    { estimated_cost_usd: 0, actual_cost_usd: 5 },
    { estimated_cost_usd: 100, actual_cost_usd: 100 },
    { estimated_cost_usd: -10, actual_cost_usd: 5 },
  ]);
  assert.equal(r, 1.0);
});
