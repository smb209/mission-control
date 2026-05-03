/**
 * Imports role-specific markdown templates from
 * `~/.openclaw/workspaces/mc-{role}-dev/` into the in-repo
 * `agent-templates/<role>/` directory.
 *
 * One-shot seeder: source-controls the role definitions so authoring a
 * new role becomes a PR rather than filesystem surgery. After this
 * runs, the openclaw workspaces become reference / dead — MC reads
 * templates from the in-repo copy.
 *
 * Run with:
 *   yarn tsx scripts/import-agent-templates.ts
 *
 * Re-run safely: file overwrites are byte-exact, so rerunning has no
 * effect unless an upstream openclaw workspace changed. Diff the result
 * in git before committing to spot drift.
 *
 * Files imported per role: SOUL.md, AGENTS.md, IDENTITY.md.
 * Files NOT imported (intentionally):
 *   - HEARTBEAT.md → role-specific cron logic; replaced by `recurring_jobs`.
 *   - TOOLS.md → openclaw-side tool catalog; MC doesn't need it.
 *   - USER.md → operator-private; not source-controlled.
 *   - MEMORY-ORG.md → symlink to shared; imported separately to _shared.
 *
 * The runner-host/ template is hand-authored (intentionally neutral)
 * and NOT touched by this import. Same for _shared/notetaker.md.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'agent-templates');
const OPENCLAW_WORKSPACES = path.join(os.homedir(), '.openclaw', 'workspaces');

interface RoleMapping {
  /** Role name as used inside MC (and as the `agent-templates/<role>/` directory). */
  role: string;
  /** openclaw workspace name (the `mc-{name}-dev` form). */
  source: string;
}

const ROLES: RoleMapping[] = [
  { role: 'pm', source: 'mc-project-manager-dev' },
  { role: 'coordinator', source: 'mc-coordinator-dev' },
  { role: 'builder', source: 'mc-builder-dev' },
  { role: 'researcher', source: 'mc-researcher-dev' },
  { role: 'tester', source: 'mc-tester-dev' },
  { role: 'reviewer', source: 'mc-reviewer-dev' },
  { role: 'writer', source: 'mc-writer-dev' },
  { role: 'learner', source: 'mc-learner-dev' },
];

const ROLE_FILES = ['SOUL.md', 'AGENTS.md', 'IDENTITY.md'];
const SHARED_FILES = ['MESSAGING-PROTOCOL.md', 'SHARED-RULES.md'];

async function copyIfExists(srcPath: string, destPath: string): Promise<'copied' | 'missing'> {
  try {
    const buf = await fs.readFile(srcPath);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, buf);
    return 'copied';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw err;
  }
}

async function importRoleTemplates(mapping: RoleMapping): Promise<void> {
  const srcDir = path.join(OPENCLAW_WORKSPACES, mapping.source);
  const destDir = path.join(TEMPLATES_DIR, mapping.role);

  for (const file of ROLE_FILES) {
    const status = await copyIfExists(path.join(srcDir, file), path.join(destDir, file));
    process.stderr.write(`  ${file.padEnd(15)} ${status}\n`);
  }
}

async function importSharedDocs(): Promise<void> {
  // The shared docs (MESSAGING-PROTOCOL.md, SHARED-RULES.md) are
  // symlinked by every per-role openclaw workspace into a single source
  // at /workspaces/{name}.md. We resolve the symlink by reading from
  // any per-role workspace — the resolved file is the canonical text.
  const sourceWorkspace = path.join(OPENCLAW_WORKSPACES, 'mc-builder-dev');
  for (const file of SHARED_FILES) {
    const dest = path.join(TEMPLATES_DIR, '_shared', file.toLowerCase());
    const status = await copyIfExists(path.join(sourceWorkspace, file), dest);
    process.stderr.write(`  _shared/${file.toLowerCase().padEnd(25)} ${status}\n`);
  }
}

async function main(): Promise<void> {
  process.stderr.write(`Importing agent templates from ${OPENCLAW_WORKSPACES}\n`);
  process.stderr.write(`Target: ${TEMPLATES_DIR}\n\n`);

  for (const mapping of ROLES) {
    process.stderr.write(`[${mapping.role}] from ${mapping.source}:\n`);
    await importRoleTemplates(mapping);
  }
  process.stderr.write('\n[_shared] from mc-builder-dev (symlink-resolved):\n');
  await importSharedDocs();

  process.stderr.write('\nDone. Review with `git diff agent-templates/` before committing.\n');
  process.stderr.write('Hand-authored files (NOT touched by this import):\n');
  process.stderr.write('  - agent-templates/runner-host/{SOUL,AGENTS,IDENTITY}.md\n');
  process.stderr.write('  - agent-templates/_shared/notetaker.md\n');
  process.stderr.write('  - agent-templates/README.md\n');
}

main().catch((err) => {
  console.error('[import-agent-templates] fatal:', err);
  process.exit(1);
});
