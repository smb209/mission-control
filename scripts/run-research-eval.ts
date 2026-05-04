#!/usr/bin/env tsx
/**
 * yarn research:eval entry point.
 *
 * By default runs all fixtures from src/lib/research/eval/fixtures.ts
 * against a fresh eval workspace. Each fixture either dispatches via
 * the orchestrator (for live evaluation against the gateway) or uses
 * its canned reply (for harness self-test / R6.2).
 *
 * Flags:
 *   --only <id1,id2>   subset of fixture ids
 *   --output <dir>     output directory (default: tmp/research-eval)
 *   --workspace <id>   reuse an existing workspace
 *   --timeout <ms>     per-brief timeout (default 5min)
 */

import { runEval } from '@/lib/research/eval/runner';

function parseArgs(argv: string[]): {
  only?: string[]; outputDir?: string; workspaceId?: string; timeoutMs?: number;
} {
  const out: ReturnType<typeof parseArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--only' && next) { out.only = next.split(',').map(s => s.trim()).filter(Boolean); i++; }
    else if (a === '--output' && next) { out.outputDir = next; i++; }
    else if (a === '--workspace' && next) { out.workspaceId = next; i++; }
    else if (a === '--timeout' && next) { out.timeoutMs = parseInt(next, 10); i++; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('[research-eval] starting…', args);
  const report = await runEval(args);
  console.log('[research-eval] done.');
  console.log(`  run_id:    ${report.run_id}`);
  console.log(`  workspace: ${report.workspace_id}`);
  console.log(`  aggregate: ${report.aggregate.toFixed(3)}`);
  console.log(`  fixtures:`);
  for (const r of report.fixtures) {
    console.log(`    ${r.fixture_id}  (${r.status})  agg=${r.rubric.aggregate.toFixed(3)}`);
    for (const [axis, v] of Object.entries(r.rubric.axes)) {
      console.log(`      ${axis.padEnd(11)} ${v.score.toFixed(3)}  ${v.rationale}`);
    }
  }
}

main().catch(err => {
  console.error('[research-eval] failed:', err);
  process.exit(1);
});
