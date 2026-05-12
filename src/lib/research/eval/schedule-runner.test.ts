/**
 * schedule-runner self-test.
 *
 * Self-contained: spins up its own workspace, researcher, runner,
 * topic, schedule, and stubbed gateway client; confirms a brief was
 * produced and the schedule's run_count advanced.
 *
 * Mirrors RP2.S6.1 in
 * docs/archive/research-phase-2-validation/02-test-plan.md.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { runScheduleEval } from './schedule-runner';

test('schedule-runner: produces a brief and advances run_count', async () => {
  const tmpDir = path.join(os.tmpdir(), `mc-sched-eval-${Date.now()}`);
  const report = await runScheduleEval({ outputDir: tmpDir });
  assert.equal(report.brief_status, 'complete');
  assert.notEqual(report.brief_id, null);
  assert.equal(report.schedule_run_count_after, 1);
  assert.equal(report.schedule_consecutive_failures_after, 0);
  assert.ok(report.passed);
});
