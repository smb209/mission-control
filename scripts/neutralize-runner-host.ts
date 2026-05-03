/**
 * Copies `agent-templates/runner-host/{SOUL,AGENTS,IDENTITY}.md` into
 * `~/.openclaw/workspaces/mc-runner{,-dev}/` so the runner agent's
 * openclaw session loads neutral host docs instead of the
 * PM-flavored copies the user originally seeded those workspaces with.
 *
 * Phase C of specs/scope-keyed-sessions.md. Run once after this PR
 * lands; idempotent (overwrites the three files exactly).
 *
 * Files outside the host triple (HEARTBEAT.md, USER.md, MEMORY-ORG.md
 * symlink, etc.) are left alone — those are operator state.
 *
 * Usage: yarn tsx scripts/neutralize-runner-host.ts
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_DIR = path.join(REPO_ROOT, 'agent-templates', 'runner-host');
const TARGETS = ['mc-runner', 'mc-runner-dev'];
const FILES = ['SOUL.md', 'AGENTS.md', 'IDENTITY.md'];

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function copyOne(src: string, dest: string): Promise<'copied' | 'identical' | 'skipped-no-source'> {
  if (!(await pathExists(src))) return 'skipped-no-source';
  const buf = await fs.readFile(src);
  if (await pathExists(dest)) {
    const existing = await fs.readFile(dest);
    if (existing.equals(buf)) return 'identical';
  }
  await fs.writeFile(dest, buf);
  return 'copied';
}

async function neutralize(): Promise<void> {
  process.stderr.write(`Source templates: ${TEMPLATE_DIR}\n`);
  for (const target of TARGETS) {
    const targetDir = path.join(os.homedir(), '.openclaw', 'workspaces', target);
    if (!(await pathExists(targetDir))) {
      process.stderr.write(`[${target}] workspace missing — skipping\n`);
      continue;
    }
    process.stderr.write(`[${target}]\n`);
    for (const file of FILES) {
      const status = await copyOne(
        path.join(TEMPLATE_DIR, file),
        path.join(targetDir, file),
      );
      process.stderr.write(`  ${file.padEnd(15)} ${status}\n`);
    }
  }
  process.stderr.write('\nDone. The runner agents now load neutral host docs at session start.\n');
}

neutralize().catch((err) => {
  console.error('[neutralize-runner-host] fatal:', err);
  process.exit(1);
});
