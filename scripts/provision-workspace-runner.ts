/**
 * Phase I: provision a per-workspace PM agent in openclaw.
 *
 * Uses openclaw's native CLI bindings (not raw config-file editing) so
 * the script rides along with openclaw upgrades and config schema
 * changes:
 *
 *   1. `openclaw agents add <id> --workspace <dir> --model <m> --non-interactive --json`
 *      Creates the agent record + workspace dir + writes the basic
 *      entry into ~/.openclaw/openclaw.json.
 *   2. `openclaw config get agents.list` to find the new entry's index.
 *   3. `openclaw config set --batch-json [...]` to enrich with tools
 *      profile / skills / heartbeat / display name.
 *
 * Idempotent — if the agent already exists (id collision), bails with
 * a clear message instead of creating a duplicate. Use
 * `openclaw agents delete <id> --force` first to recreate.
 *
 * Usage:
 *   yarn workspace:provision <slug> [--prod]
 *
 * Examples:
 *   yarn workspace:provision foia
 *     → creates `mc-pm-foia-dev` with sc-mission-control-dev MCP scope
 *   yarn workspace:provision foia --prod
 *     → creates `mc-pm-foia` with sc-mission-control MCP scope
 *
 * MCP scope is derived from --prod flag and openclaw.json must already
 * have both `sc-mission-control` and `sc-mission-control-dev` MCP
 * server entries (run `openclaw mcp show <name>` to verify).
 */

import { spawnSync } from 'node:child_process';
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

function fail(msg: string): never {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(1);
}

function parseArgs(): { slug: string; isProd: boolean } {
  const args = process.argv.slice(2).filter((a) => !!a);
  if (args.length === 0) {
    fail('usage: yarn workspace:provision <slug> [--prod]');
  }
  let isProd = false;
  let slug: string | null = null;
  for (const a of args) {
    if (a === '--prod') isProd = true;
    else if (a.startsWith('--')) fail(`unknown flag: ${a}`);
    else if (slug === null) slug = a;
    else fail(`unexpected positional arg: ${a}`);
  }
  if (!slug) fail('slug is required');
  return { slug: slug!, isProd };
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

function provision(slug: string, isProd: boolean): void {
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

  // 1. Idempotency check.
  const before = getAgentsList();
  if (findAgentIndex(before, gatewayId) >= 0) {
    process.stderr.write(
      `agent "${gatewayId}" already exists in openclaw.json — nothing to do.\n` +
        `(to recreate: openclaw agents delete ${gatewayId} --force)\n`,
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

  // 5. Verify final shape.
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

function main(): void {
  const { slug, isProd } = parseArgs();
  validateSlug(slug);
  provision(slug, isProd);
}

main();
