#!/usr/bin/env tsx
/**
 * yarn research:eval:schedule entry point.
 *
 * Exercises the recurring-scheduler research dispatch path end-to-end
 * with a canned-reply gateway stub. Validates RP2.S6.1 in the
 * phase-2 validation plan.
 */

import { runScheduleEval } from '@/lib/research/eval/schedule-runner';

async function main() {
  console.log('[schedule-eval] starting…');
  const report = await runScheduleEval();
  console.log('[schedule-eval] done.');
  console.log(`  run_id:       ${report.run_id}`);
  console.log(`  workspace:    ${report.workspace_id}`);
  console.log(`  schedule:     ${report.schedule_id}`);
  console.log(`  brief_id:     ${report.brief_id ?? '(none)'}`);
  console.log(`  brief_status: ${report.brief_status}`);
  console.log(`  run_count:    ${report.schedule_run_count_after}`);
  console.log(`  failures:     ${report.schedule_consecutive_failures_after}`);
  console.log(`  passed:       ${report.passed}`);
  if (!report.passed) process.exit(1);
}

main().catch(err => {
  console.error('[schedule-eval] failed:', err);
  process.exit(1);
});
