/**
 * Provision / re-seed the gateway runner workspaces from the
 * canonical templates in `agent-templates/runner-host/`.
 *
 * For each of `~/.openclaw/workspaces/mc-runner` and
 * `~/.openclaw/workspaces/mc-runner-dev`:
 *   1. Overwrite SOUL.md / AGENTS.md / IDENTITY.md / USER.md from the
 *      template dir. These are the runner's identity & contract files
 *      (including the direct-chat persona-init protocol in SOUL.md);
 *      they should always match the repo's source-of-truth.
 *   2. Remove `HEARTBEAT.md` and `TOOLS.md` if present. Those are
 *      artifacts cloned from another openclaw workspace template and
 *      don't apply to a neutral runner — HEARTBEAT.md is PM-flavored
 *      and TOOLS.md is environment-specific scratch space. Leaving
 *      them in place causes the runner to load PM heartbeat behavior
 *      it shouldn't run.
 *
 * Run this:
 *   - Once after first checkout to neutralize a freshly-cloned
 *     openclaw workspace (originally PM-flavored).
 *   - Whenever the templates in `agent-templates/runner-host/`
 *     change, to push the update to the gateway dirs.
 *
 * Idempotent — copies are content-compared, removals tolerate ENOENT.
 * The MEMORY-ORG.md / MESSAGING-PROTOCOL.md / SHARED-RULES.md
 * symlinks, MC-CONTEXT.json, team-roster.md, memory/, and projects/
 * are left alone — those are operator state.
 *
 * Usage: yarn runner-host:reseed
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_DIR = path.join(REPO_ROOT, 'agent-templates', 'runner-host');
const TARGETS = ['mc-runner', 'mc-runner-dev'];
// HEARTBEAT.md ships an explicit empty-stub instead of being deleted —
// openclaw auto-recreates the file on session start with its own
// scaffold, so deleting it just produces churn. The repo-managed copy
// makes the "intentionally empty" intent explicit and survives
// openclaw's recreation pass.
const FILES = ['SOUL.md', 'AGENTS.md', 'IDENTITY.md', 'USER.md', 'HEARTBEAT.md'];
// Files that must NOT exist on a neutral runner (cloned-template
// artifacts). Removed on every run so an upstream re-clone gets
// cleaned up automatically.
const FILES_TO_REMOVE = ['TOOLS.md'];

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

async function removeOne(p: string): Promise<'removed' | 'absent'> {
  try {
    await fs.unlink(p);
    return 'removed';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw err;
  }
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
    for (const file of FILES_TO_REMOVE) {
      const status = await removeOne(path.join(targetDir, file));
      process.stderr.write(`  ${file.padEnd(15)} ${status}\n`);
    }
  }
  process.stderr.write('\nDone. Runner workspaces are aligned with agent-templates/runner-host/.\n');
}

neutralize().catch((err) => {
  console.error('[neutralize-runner-host] fatal:', err);
  process.exit(1);
});
