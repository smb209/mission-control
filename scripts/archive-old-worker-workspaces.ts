/**
 * Phase F filesystem cleanup.
 *
 * Moves `~/.openclaw/workspaces/mc-{role}{,-dev}/` into a sibling
 * `.archive/` directory so they're out of the runner's way. Skips the
 * runner workspace pair. Idempotent — already-archived workspaces are
 * left alone.
 *
 * Why move and not delete:
 *  - Openclaw's session reaper (cron/session-reaper.ts) auto-prunes
 *    after 30d of disuse anyway. Archival here is just visual cleanup.
 *  - The trajectories may still be referenced if you scroll back in
 *    history; preserving them under .archive/ keeps the option to
 *    rehydrate manually.
 *
 * Run with:
 *   yarn tsx scripts/archive-old-worker-workspaces.ts [--dry-run]
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const WORKSPACES = path.join(os.homedir(), '.openclaw', 'workspaces');
const ARCHIVE = path.join(WORKSPACES, '.archive');

const ROLES = [
  'mc-builder',
  'mc-coordinator',
  'mc-tester',
  'mc-reviewer',
  'mc-writer',
  'mc-researcher',
  'mc-learner',
  'mc-project-manager',
];
const VARIANTS = ['', '-dev'];
const KEEP = new Set(['mc-runner', 'mc-runner-dev']);

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function archive(name: string, dryRun: boolean): Promise<'archived' | 'absent' | 'already-archived'> {
  if (KEEP.has(name)) return 'absent';
  const src = path.join(WORKSPACES, name);
  if (!(await pathExists(src))) return 'absent';
  const dest = path.join(ARCHIVE, name);
  if (await pathExists(dest)) return 'already-archived';
  if (dryRun) return 'archived';
  await fs.mkdir(ARCHIVE, { recursive: true });
  await fs.rename(src, dest);
  return 'archived';
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  process.stderr.write(`Workspaces dir: ${WORKSPACES}\n`);
  process.stderr.write(`Archive target: ${ARCHIVE}\n`);
  if (dryRun) process.stderr.write('--dry-run: no filesystem changes will be made\n');
  process.stderr.write('\n');

  let total = 0;
  let archived = 0;
  for (const role of ROLES) {
    for (const variant of VARIANTS) {
      const name = role + variant;
      const status = await archive(name, dryRun);
      total++;
      if (status === 'archived') archived++;
      process.stderr.write(`  ${name.padEnd(28)} ${status}\n`);
    }
  }

  process.stderr.write(`\n${archived}/${total} workspace dirs ${dryRun ? 'would be ' : ''}moved to .archive/.\n`);
  process.stderr.write('mc-runner and mc-runner-dev preserved.\n');
}

main().catch((err) => {
  console.error('[archive-old-worker-workspaces] fatal:', err);
  process.exit(1);
});
