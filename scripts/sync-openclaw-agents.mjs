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
 *   2. For every agent matching ^mc-[a-z-]+$ (i.e. a stable MC agent):
 *        - Ensures the stable block's `tools.deny` includes
 *          `sc-mission-control-dev__*` so the prod agent can't even SEE
 *          the dev MCP tool catalog (alsoAllow only gates calls, not
 *          visibility — without deny, prod agents call dev tools by
 *          accident and produce blocked-state errors during roll calls).
 *        - Ensures a parallel `<id>-dev` agent exists with:
 *            - workspace path suffixed `-dev`
 *            - tools.alsoAllow rewritten so `sc-mission-control__*`
 *              becomes `sc-mission-control-dev__*`
 *            - tools.deny rewritten so it denies `sc-mission-control__*`
 *              (the inverse of stable's deny rule)
 *            - all other fields copied from the stable block (model,
 *              skills, heartbeat, etc.)
 *   3. Writes openclaw.json back, formatted, after taking a backup.
 *
 * Idempotent: re-running re-syncs both stable and dev blocks. Use it
 * after editing a stable agent block (new skill, tool change, etc.) to
 * keep the dev block aligned. The script only touches stable blocks
 * additively — it adds the dev-server deny rule if missing; it never
 * removes anything from a stable block.
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

// Tool patterns each side denies. The deny rules are belt-and-suspenders
// to alsoAllow: openclaw still lists every registered MCP server's tool
// catalog to every agent, so without an explicit deny the LLM in a prod
// agent will see (and try to call) `sc-mission-control-dev__send_mail`
// even though alsoAllow doesn't authorize it. deny is checked before
// tool resolution and removes the cross-side tools from the catalog
// entirely.
const STABLE_DENY_DEV_PATTERN = `${DEV_SERVER_NAME}__*`;     // sc-mission-control-dev__*
const DEV_DENY_STABLE_PATTERN = `${STABLE_SERVER_NAME}__*`;  // sc-mission-control__*

function rewriteAlsoAllow(alsoAllow) {
  if (!Array.isArray(alsoAllow)) return alsoAllow;
  return alsoAllow.map((entry) =>
    typeof entry === 'string' && entry.startsWith(`${STABLE_SERVER_NAME}__`)
      ? entry.replace(`${STABLE_SERVER_NAME}__`, `${DEV_SERVER_NAME}__`)
      : entry,
  );
}

/**
 * Stable-side: deep-add `sc-mission-control-dev__*` to deny[]. Returns
 * the original block untouched if the rule is already present so the
 * change-detector can report a no-op.
 */
function ensureStableDeny(stableBlock) {
  if (!stableBlock.tools || typeof stableBlock.tools !== 'object') return stableBlock;
  const existing = Array.isArray(stableBlock.tools.deny) ? stableBlock.tools.deny : [];
  if (existing.includes(STABLE_DENY_DEV_PATTERN)) return stableBlock;
  return {
    ...stableBlock,
    tools: { ...stableBlock.tools, deny: [...existing, STABLE_DENY_DEV_PATTERN] },
  };
}

/**
 * Dev-side: rebuild deny[] so it has `sc-mission-control__*` (the
 * inverse of stable's deny rule) and does NOT carry over the
 * dev-server deny pattern that exists in stable. Idempotent.
 */
function rewriteDeny(deny) {
  const existing = Array.isArray(deny) ? deny : [];
  // Drop the stable-side deny rule (irrelevant on the dev block).
  const filtered = existing.filter((e) => e !== STABLE_DENY_DEV_PATTERN);
  if (!filtered.includes(DEV_DENY_STABLE_PATTERN)) {
    filtered.push(DEV_DENY_STABLE_PATTERN);
  }
  return filtered;
}

function buildDevBlock(stableBlock) {
  // Deep clone so we don't mutate the stable block.
  const dev = JSON.parse(JSON.stringify(stableBlock));
  dev.id = devIdFor(stableBlock.id);
  if (dev.workspace) dev.workspace = devWorkspaceFor(stableBlock.workspace);
  if (dev.tools && typeof dev.tools === 'object') {
    if (Array.isArray(dev.tools.alsoAllow)) {
      dev.tools = { ...dev.tools, alsoAllow: rewriteAlsoAllow(dev.tools.alsoAllow) };
    }
    dev.tools = { ...dev.tools, deny: rewriteDeny(dev.tools.deny) };
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

  for (let i = 0; i < list.length; i++) {
    const agent = list[i];
    if (!isStableMcAgentId(agent.id)) continue;

    // Step 1: ensure the stable block denies the dev MCP server. Only
    // additive — we never remove anything from operator-authored stable
    // blocks. Same change-detection pattern as the dev-side build.
    const updatedStable = ensureStableDeny(agent);
    if (!shallowEqualBlocks(agent, updatedStable)) {
      changes.push({
        kind: 'update',
        id: agent.id,
        index: i,
        block: updatedStable,
        reason: 'add deny rule for dev MCP server',
      });
    }

    // Step 2: ensure the dev counterpart exists and is in sync. Build
    // dev from the (possibly updated) stable so deny inversion sees a
    // consistent baseline.
    const expected = buildDevBlock(updatedStable);
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
      const suffix = c.reason ? ` (${c.reason})` : '';
      console.log(`[sync-openclaw-agents] agents: ${c.kind} ${c.id}${suffix}`);
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
