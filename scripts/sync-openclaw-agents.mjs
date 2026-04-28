#!/usr/bin/env node
/**
 * sync-openclaw-agents.mjs
 *
 * Mirrors stable MC agent definitions in ~/.openclaw/openclaw.json under
 * a parallel `-dev` roster pointing at the dev MC instance. Lets the
 * operator iterate on MC by running stable + dev side by side without
 * cross-contaminating their agent rosters.
 *
 * What it does:
 *   1. Ensures `mcp.servers.sc-mission-control-dev` exists pointing at
 *      MC dev (default http://localhost:4010/api/mcp). The token is left
 *      alone if already set; otherwise a placeholder is written and the
 *      operator is prompted to fill it in.
 *   2. For every agent matching ^mc-[a-z-]+$ (i.e. a stable MC agent),
 *      ensures a parallel `<id>-dev` agent exists with:
 *        - workspace path suffixed `-dev`
 *        - tools.alsoAllow rewritten so `sc-mission-control__*` becomes
 *          `sc-mission-control-dev__*`
 *        - all other fields copied from the stable block (model, skills,
 *          heartbeat, etc.)
 *   3. Writes openclaw.json back, formatted, after taking a backup.
 *
 * Idempotent: re-running re-syncs the dev blocks to whatever the stable
 * blocks currently look like. Use it after editing a stable agent block
 * (new skill, tool change, etc.) to keep the dev block aligned.
 *
 * Does NOT:
 *   - Create or copy agent workspace directories. Run the one-time
 *     workspace-copy step in docs/DOGFOOD_PLAYBOOK.md manually.
 *   - Touch any agent that already exists with `-dev` suffix and an
 *     `id` not corresponding to a stable counterpart (custom agents
 *     are preserved untouched).
 *   - Generate API tokens. The operator wires the dev token in by
 *     hand the first time.
 *
 * Usage:
 *   node scripts/sync-openclaw-agents.mjs               # sync, write back
 *   node scripts/sync-openclaw-agents.mjs --dry-run     # report only
 *   node scripts/sync-openclaw-agents.mjs --config=PATH # alt openclaw.json
 *
 * Exits non-zero on parse errors or when --dry-run finds drift (useful
 * in CI / pre-commit if the dev roster is ever committed).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEV_SERVER_NAME = 'sc-mission-control-dev';
const STABLE_SERVER_NAME = 'sc-mission-control';
const DEV_MC_URL_DEFAULT = 'http://localhost:4010/api/mcp';
const STABLE_AGENT_ID_RE = /^mc-[a-z-]+$/;

function isStableMcAgentId(id) {
  return typeof id === 'string' && STABLE_AGENT_ID_RE.test(id) && !id.endsWith('-dev');
}

function devIdFor(stableId) {
  return `${stableId}-dev`;
}

function devWorkspaceFor(stableWorkspace) {
  if (typeof stableWorkspace !== 'string' || !stableWorkspace) return stableWorkspace;
  const base = path.basename(stableWorkspace);
  const parent = path.dirname(stableWorkspace);
  return path.join(parent, `${base}-dev`);
}

function rewriteAlsoAllow(alsoAllow) {
  if (!Array.isArray(alsoAllow)) return alsoAllow;
  return alsoAllow.map((entry) =>
    typeof entry === 'string' && entry.startsWith(`${STABLE_SERVER_NAME}__`)
      ? entry.replace(`${STABLE_SERVER_NAME}__`, `${DEV_SERVER_NAME}__`)
      : entry,
  );
}

function buildDevBlock(stableBlock) {
  // Deep clone so we don't mutate the stable block.
  const dev = JSON.parse(JSON.stringify(stableBlock));
  dev.id = devIdFor(stableBlock.id);
  if (dev.workspace) dev.workspace = devWorkspaceFor(stableBlock.workspace);
  if (dev.tools && Array.isArray(dev.tools.alsoAllow)) {
    dev.tools = { ...dev.tools, alsoAllow: rewriteAlsoAllow(dev.tools.alsoAllow) };
  }
  return dev;
}

function shallowEqualBlocks(a, b) {
  // Stringify with stable key ordering for a structural compare.
  return JSON.stringify(a) === JSON.stringify(b);
}

function ensureDevMcpServer(config, { dryRun }) {
  config.mcp ??= { servers: {} };
  config.mcp.servers ??= {};
  const stable = config.mcp.servers[STABLE_SERVER_NAME];
  const existing = config.mcp.servers[DEV_SERVER_NAME];

  if (existing) {
    return { changed: false, message: `mcp.servers.${DEV_SERVER_NAME} already configured` };
  }

  if (!stable) {
    throw new Error(
      `mcp.servers.${STABLE_SERVER_NAME} not found in openclaw.json — set up stable first.`,
    );
  }

  const placeholder = {
    command: stable.command,
    args: [...(stable.args ?? [])],
    env: {
      MC_URL: DEV_MC_URL_DEFAULT,
      MC_API_TOKEN: '__SET_DEV_MC_API_TOKEN__',
    },
  };

  if (!dryRun) {
    config.mcp.servers[DEV_SERVER_NAME] = placeholder;
  }
  return {
    changed: true,
    message:
      `Added mcp.servers.${DEV_SERVER_NAME} pointing at ${DEV_MC_URL_DEFAULT}. ` +
      `Replace MC_API_TOKEN placeholder with the dev MC's token before starting agents.`,
  };
}

function syncAgents(config, { dryRun }) {
  const list = config.agents?.list;
  if (!Array.isArray(list)) {
    throw new Error('Expected agents.list array in openclaw.json');
  }

  const byId = new Map(list.map((a, i) => [a.id, { agent: a, index: i }]));
  const changes = [];

  for (const agent of list) {
    if (!isStableMcAgentId(agent.id)) continue;
    const expected = buildDevBlock(agent);
    const existing = byId.get(expected.id);

    if (!existing) {
      changes.push({ kind: 'add', id: expected.id, block: expected });
      continue;
    }
    if (!shallowEqualBlocks(existing.agent, expected)) {
      changes.push({ kind: 'update', id: expected.id, index: existing.index, block: expected });
    }
  }

  if (!dryRun) {
    // Apply additions (append) and updates (in place).
    for (const change of changes) {
      if (change.kind === 'add') {
        list.push(change.block);
      } else if (change.kind === 'update') {
        list[change.index] = change.block;
      }
    }
  }

  return changes;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const configFlag = args.find((a) => a.startsWith('--config='));
  const configPath = configFlag
    ? configFlag.slice('--config='.length).replace(/^~/, os.homedir())
    : path.join(os.homedir(), '.openclaw', 'openclaw.json');

  const raw = await fs.readFile(configPath, 'utf8');
  const config = JSON.parse(raw);

  const mcpResult = ensureDevMcpServer(config, { dryRun });
  const agentChanges = syncAgents(config, { dryRun });

  console.log(`[sync-openclaw-agents] config: ${configPath}`);
  console.log(`[sync-openclaw-agents] mode: ${dryRun ? 'dry-run' : 'write'}`);
  console.log(`[sync-openclaw-agents] mcp: ${mcpResult.message}`);
  if (agentChanges.length === 0) {
    console.log('[sync-openclaw-agents] agents: in sync (no changes)');
  } else {
    for (const c of agentChanges) {
      console.log(`[sync-openclaw-agents] agents: ${c.kind} ${c.id}`);
    }
  }

  if (dryRun) {
    if (mcpResult.changed || agentChanges.length > 0) {
      process.exitCode = 2;
    }
    return;
  }

  if (!mcpResult.changed && agentChanges.length === 0) {
    return;
  }

  const backupPath = `${configPath}.bak.${Date.now()}`;
  await fs.copyFile(configPath, backupPath);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  console.log(`[sync-openclaw-agents] wrote ${configPath} (backup: ${path.basename(backupPath)})`);
  console.log('[sync-openclaw-agents] restart openclaw to load the new agent roster.');
}

main().catch((err) => {
  console.error(`[sync-openclaw-agents] ERROR: ${err.message}`);
  process.exit(1);
});
