/**
 * Phase I: provision a per-workspace PM agent in openclaw.
 *
 * Uses openclaw's native CLI bindings (not raw config-file editing) so
 * the script rides along with openclaw upgrades and config schema
 * changes. Then seeds the workspace dir with the role-templated
 * SOUL.md / AGENTS.md / IDENTITY.md from `agent-templates/<role>/`,
 * overwriting openclaw's defaults — without those, the PM's first-turn
 * context comes from openclaw's generic templates instead of the MC
 * role guidance.
 *
 * Steps:
 *   1. `openclaw agents add <id> --workspace <dir> --model <m> --non-interactive --json`
 *      Creates the agent record + workspace dir + writes the basic
 *      entry into ~/.openclaw/openclaw.json.
 *   2. `openclaw config get agents.list` to find the new entry's index.
 *   3. `openclaw config set --batch-json [...]` to enrich with display
 *      name / skills / heartbeat / tools profile (allow sc-mission-
 *      control-<env>__*, deny opposite).
 *   4. Seed role-templated files into the workspace dir
 *      (SOUL.md, AGENTS.md, IDENTITY.md from agent-templates/<role>/).
 *      AGENTS.md gets the pm-coordinator addendum appended so the PM
 *      knows how to handle MC's META envelopes from Phase J2.
 *
 * Idempotency:
 *   - If the agent already exists in openclaw config, bails with a
 *     clear "already exists" message instead of stacking duplicates.
 *   - `--reseed-templates` re-runs step 4 only (skips agents add +
 *     config enrich), useful for picking up template updates without
 *     touching the openclaw record.
 *
 * Usage:
 *   yarn workspace:provision <slug> [--prod] [--reseed-templates]
 *
 * Examples:
 *   yarn workspace:provision foia
 *     → creates `mc-pm-foia-dev`; seeds workspace dir with PM templates
 *   yarn workspace:provision foia --prod
 *     → creates `mc-pm-foia` with sc-mission-control MCP scope
 *   yarn workspace:provision foia --reseed-templates
 *     → existing agent: just re-seed SOUL.md/AGENTS.md/IDENTITY.md
 *       from agent-templates/pm/. No openclaw config changes.
 */

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SEGMENT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED_PREFIXES = ['agent', 'cron', 'run', 'thread', 'subagent', 'main'];
const DEFAULT_SKILLS = [
  'acp-router',
  'discord',
  'github',
  'gog',
  'healthcheck',
  'node-connect',
  'openai-whisper',
  'peekaboo',
  'session-logs',
  'skill-creator',
  'tmux',
  'video-frames',
  'taskflow',
];
const DEFAULT_MODEL = 'spark-lb/agent';
const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'agent-templates');

/**
 * Files we manage from the role template. Anything outside this list
 * (HEARTBEAT.md, TOOLS.md, USER.md, MC-CONTEXT.json) stays as openclaw
 * provided it — those are operator state, not role identity.
 */
const TEMPLATED_FILES = ['SOUL.md', 'AGENTS.md', 'IDENTITY.md'];

/**
 * Files we delete from openclaw's defaults if present. BOOTSTRAP.md is
 * openclaw's first-run "agent doesn't know who it is — ask the operator
 * for a name, timezone, messaging channel" script. The MC role
 * personas have already supplied identity (SOUL.md / IDENTITY.md), so
 * the bootstrap dialog actively misfires — the agent says "I'm
 * Margaret Maps Hamilton, your workspace PM" and then immediately asks
 * "who am I talking to, what timezone, WhatsApp or Telegram?" because
 * BOOTSTRAP.md was still in the workspace dir at session start.
 *
 * BOOTSTRAP.md self-documents that it should be deleted when done:
 * "When you are done — Delete this file. You don't need a bootstrap
 * script anymore — you're you now." Provisioning is exactly that
 * "when you are done."
 */
const REMOVED_FILES = ['BOOTSTRAP.md'];

function fail(msg: string): never {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(1);
}

function parseArgs(): { slug: string; isProd: boolean; reseedOnly: boolean } {
  const args = process.argv.slice(2).filter((a) => !!a);
  if (args.length === 0) {
    fail('usage: yarn workspace:provision <slug> [--prod] [--reseed-templates]');
  }
  let isProd = false;
  let reseedOnly = false;
  let slug: string | null = null;
  for (const a of args) {
    if (a === '--prod') isProd = true;
    else if (a === '--reseed-templates') reseedOnly = true;
    else if (a.startsWith('--')) fail(`unknown flag: ${a}`);
    else if (slug === null) slug = a;
    else fail(`unexpected positional arg: ${a}`);
  }
  if (!slug) fail('slug is required');
  return { slug: slug!, isProd, reseedOnly };
}

function validateSlug(slug: string): void {
  if (!SEGMENT_RE.test(slug)) {
    fail(
      `slug "${slug}" must match the openclaw segment grammar [a-z0-9][a-z0-9_-]{0,63}`,
    );
  }
  if (RESERVED_PREFIXES.includes(slug)) {
    fail(`slug "${slug}" is a reserved openclaw prefix`);
  }
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runOpenclaw(args: string[]): RunResult {
  const result = spawnSync('openclaw', args, { encoding: 'utf8' });
  if (result.error) {
    fail(
      `failed to invoke openclaw CLI: ${result.error.message}\n` +
        `is the openclaw binary on PATH? (try: which openclaw)`,
    );
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

interface AgentListEntry {
  id?: string;
  name?: string;
}

function getAgentsList(): AgentListEntry[] {
  const r = runOpenclaw(['config', 'get', 'agents.list']);
  if (r.status !== 0) {
    fail(`'openclaw config get agents.list' failed:\n${r.stderr || r.stdout}`);
  }
  try {
    const parsed = JSON.parse(r.stdout) as AgentListEntry[];
    if (!Array.isArray(parsed)) {
      fail(`agents.list is not an array: ${typeof parsed}`);
    }
    return parsed;
  } catch (err) {
    fail(`failed to parse agents.list JSON: ${(err as Error).message}\n${r.stdout.slice(0, 200)}`);
  }
}

function findAgentIndex(list: AgentListEntry[], id: string): number {
  return list.findIndex((a) => a.id === id);
}

/**
 * Step 4: seed the workspace dir with role-templated content.
 * Always overwrites the three templated files regardless of prior
 * content. The pm-coordinator addendum is appended to AGENTS.md so
 * the PM knows how to handle MC's META envelopes (Phase J2).
 *
 * Returns true if any file changed.
 */
async function seedRoleTemplates(role: string, workspaceDir: string): Promise<boolean> {
  const roleDir = path.join(TEMPLATES_DIR, role);
  let changed = 0;

  for (const file of TEMPLATED_FILES) {
    const src = path.join(roleDir, file);
    const dest = path.join(workspaceDir, file);
    let content: string;
    try {
      content = await fs.readFile(src, 'utf8');
    } catch (err) {
      // Some roles may not have all three files — that's fine.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        process.stderr.write(`  ${file.padEnd(15)} skipped (template missing in agent-templates/${role}/)\n`);
        continue;
      }
      throw err;
    }

    // PM AGENTS.md gets the coordinator addendum appended so the
    // operator-side workspace dir mirrors what the briefing builder
    // injects on dispatch. Without this, the agent's first-turn
    // context (read from these files at session start) wouldn't
    // include META-envelope handling.
    if (role === 'pm' && file === 'AGENTS.md') {
      const addendumPath = path.join(TEMPLATES_DIR, '_shared', 'pm-coordinator.md');
      try {
        const addendum = await fs.readFile(addendumPath, 'utf8');
        content = content.trimEnd() + '\n\n---\n\n' + addendum;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        // pm-coordinator.md is optional; skip silently if absent.
      }
    }

    let prior: string | null = null;
    try {
      prior = await fs.readFile(dest, 'utf8');
    } catch {
      // missing destination — that's fine, we'll create it.
    }
    if (prior === content) {
      process.stderr.write(`  ${file.padEnd(15)} unchanged\n`);
      continue;
    }
    await fs.writeFile(dest, content);
    process.stderr.write(`  ${file.padEnd(15)} ${prior === null ? 'created' : 'overwrote openclaw default'}\n`);
    changed++;
  }

  // Strip openclaw defaults that conflict with the MC role personas.
  for (const file of REMOVED_FILES) {
    const dest = path.join(workspaceDir, file);
    try {
      await fs.unlink(dest);
      process.stderr.write(`  ${file.padEnd(15)} removed (openclaw default conflicts with MC persona)\n`);
      changed++;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // Already absent — fine.
    }
  }

  return changed > 0;
}

async function provision(slug: string, isProd: boolean, reseedOnly: boolean): Promise<void> {
  const env = isProd ? '' : '-dev';
  const gatewayId = `mc-pm-${slug}${env}`;
  if (gatewayId.length > 64) {
    fail(
      `gateway_agent_id "${gatewayId}" exceeds the 64-char openclaw segment limit (slug too long)`,
    );
  }
  const mcpServer = isProd ? 'sc-mission-control' : 'sc-mission-control-dev';
  const otherMcp = isProd ? 'sc-mission-control-dev' : 'sc-mission-control';
  const workspaceDir = path.join(os.homedir(), '.openclaw', 'workspaces', gatewayId);
  const role = 'pm'; // mc-pm-<slug>-* always maps to the PM role.

  // 1. Idempotency check.
  const before = getAgentsList();
  const exists = findAgentIndex(before, gatewayId) >= 0;

  if (reseedOnly) {
    if (!exists) {
      fail(
        `--reseed-templates requires the agent to already exist; ` +
          `${gatewayId} is not in agents.list. Drop the flag to provision fresh.`,
      );
    }
    process.stderr.write(`Re-seeding templates only for ${gatewayId}…\n`);
    const wsExists = await fs
      .stat(workspaceDir)
      .then(() => true)
      .catch(() => false);
    if (!wsExists) {
      fail(`workspace dir ${workspaceDir} doesn't exist; can't reseed templates`);
    }
    const changed = await seedRoleTemplates(role, workspaceDir);
    process.stderr.write(`\n${changed ? '✓ templates reseeded' : '✓ templates already up-to-date'}\n`);
    return;
  }

  if (exists) {
    process.stderr.write(
      `agent "${gatewayId}" already exists in openclaw.json — nothing to do.\n` +
        `(to recreate: openclaw agents delete ${gatewayId} --force)\n` +
        `(to re-seed templates only: yarn workspace:provision ${slug}${isProd ? ' --prod' : ''} --reseed-templates)\n`,
    );
    return;
  }

  // 2. Native add.
  process.stderr.write(`→ openclaw agents add ${gatewayId} --workspace ${workspaceDir}\n`);
  const addResult = runOpenclaw([
    'agents',
    'add',
    gatewayId,
    '--workspace',
    workspaceDir,
    '--model',
    DEFAULT_MODEL,
    '--non-interactive',
    '--json',
  ]);
  if (addResult.status !== 0) {
    fail(`'openclaw agents add' failed:\n${addResult.stderr || addResult.stdout}`);
  }

  // 3. Find the new index.
  const after = getAgentsList();
  const idx = findAgentIndex(after, gatewayId);
  if (idx < 0) {
    fail(`'openclaw agents add' reported success but agent "${gatewayId}" is missing from agents.list`);
  }

  // 4. Enrichment via batch config set.
  const displayName = `MC PM (${slug}${isProd ? '' : ' / dev'})`;
  const batch = [
    { path: `agents.list[${idx}].name`, value: displayName },
    { path: `agents.list[${idx}].skills`, value: DEFAULT_SKILLS },
    { path: `agents.list[${idx}].heartbeat.every`, value: '4h' },
    { path: `agents.list[${idx}].heartbeat.model`, value: DEFAULT_MODEL },
    { path: `agents.list[${idx}].heartbeat.includeSystemPromptSection`, value: false },
    { path: `agents.list[${idx}].tools.profile`, value: 'coding' },
    { path: `agents.list[${idx}].tools.alsoAllow`, value: ['browser', `${mcpServer}__*`] },
    {
      path: `agents.list[${idx}].tools.deny`,
      value: ['image_generate', 'music_generate', 'video_generate', `${otherMcp}__*`],
    },
  ];
  process.stderr.write(`→ openclaw config set --batch-json (${batch.length} ops)\n`);
  const enrichResult = runOpenclaw(['config', 'set', '--batch-json', JSON.stringify(batch)]);
  if (enrichResult.status !== 0) {
    fail(
      `'openclaw config set' batch failed:\n${enrichResult.stderr || enrichResult.stdout}\n` +
        `agent was created but tools/skills/heartbeat are not set. ` +
        `delete + retry: openclaw agents delete ${gatewayId} --force`,
    );
  }

  // 5. Seed role-templated workspace files.
  process.stderr.write(`→ seeding role templates from agent-templates/${role}/\n`);
  await seedRoleTemplates(role, workspaceDir);

  // 6. Verify final shape.
  const verifyResult = runOpenclaw(['config', 'get', `agents.list[${idx}]`]);
  if (verifyResult.status !== 0) {
    fail(`verification read failed:\n${verifyResult.stderr || verifyResult.stdout}`);
  }

  process.stderr.write('\n✓ provisioned\n\n');
  process.stdout.write(verifyResult.stdout);
  process.stdout.write('\n');
  process.stderr.write(`\nNext steps:\n`);
  process.stderr.write(`  1. (optional) openclaw config validate          # confirm schema clean\n`);
  process.stderr.write(`  2. /dev-restart                                  # MC catalog sync picks up within 60s\n`);
  process.stderr.write(`  3. sqlite3 mission-control.db "SELECT name, gateway_agent_id, workspace_id, is_pm, is_master FROM agents WHERE gateway_agent_id='${gatewayId}'"\n`);
  process.stderr.write(`     # expect: 1 row, pm=1, master=1, workspace_id=<workspace whose slug='${slug}'>\n`);
}

async function main(): Promise<void> {
  const { slug, isProd, reseedOnly } = parseArgs();
  validateSlug(slug);
  await provision(slug, isProd, reseedOnly);
}

main().catch((err) => {
  console.error('[provision-workspace-runner] fatal:', err);
  process.exit(1);
});
