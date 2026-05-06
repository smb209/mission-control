#!/usr/bin/env node
/**
 * apply-mc-servers.mjs
 *
 * Keeps the MCP server registry + per-agent allowlists in
 * ~/.openclaw/openclaw.json in sync with the MC route layout.
 *
 * Background: post-PR2, MC exposes three MCP routes per environment:
 *   - /api/mcp           — full surface (default; runner mounts this)
 *   - /api/mcp/pm        — narrower surface (PM mounts this)
 *   - /api/mcp/crud      — parked surface (no agent mounts by default)
 *
 * This script realizes the per-route savings by writing matching
 * `mcp.servers.*` entries and rewriting each named agent's
 * `tools.alsoAllow` so the PM allowlist references the PM-scoped
 * server name instead of the full one.
 *
 * What it does, idempotently:
 *   1. Ensures `mcp.servers` has these entries (stable + dev variants):
 *        - sc-mission-control          → :4001/api/mcp        (existing)
 *        - sc-mission-control-dev      → :4010/api/mcp        (existing)
 *        - sc-mission-control-pm       → :4001/api/mcp/pm     (new)
 *        - sc-mission-control-pm-dev   → :4010/api/mcp/pm     (new)
 *        - sc-mission-control-crud     → :4001/api/mcp/crud   (new)
 *        - sc-mission-control-crud-dev → :4010/api/mcp/crud   (new)
 *      Token + command + args are copied from the existing default-route
 *      entry. Existing entries are not mutated.
 *
 *   2. For each agent matching ^mc-pm- (matches mc-pm-default,
 *      mc-pm-foia-dev, mc-pm-default-dev, etc.):
 *        - Rewrites `tools.alsoAllow` so any reference to the full-surface
 *          server (`sc-mission-control[-dev]__*`) becomes the matching
 *          PM-scoped server (`sc-mission-control-pm[-dev]__*`). Keeps
 *          environment matching: dev PMs land on dev PM server, stable
 *          PMs on stable PM server.
 *        - Mirrors the cross-env deny pattern (the runner pattern
 *          already does this for the full-surface servers; we extend it
 *          to the PM-scoped servers too).
 *
 *   3. For runner agents (^mc-runner[-dev]?$): no tools allowlist
 *      change — they keep the full surface. Adds cross-env deny for the
 *      new PM/CRUD servers so a stable runner can't see dev PM tools etc.
 *
 *   4. Writes openclaw.json back, formatted, after taking a timestamped
 *      backup. Skips the write entirely when no changes are needed.
 *
 * Idempotent: re-running after a successful apply is a no-op.
 *
 * Usage:
 *   node scripts/apply-mc-servers.mjs                # apply, write back
 *   node scripts/apply-mc-servers.mjs --dry-run      # report only (exits 2 on drift)
 *   node scripts/apply-mc-servers.mjs --config=PATH  # alternate openclaw.json
 *
 * Exits non-zero on parse errors or when --dry-run finds drift.
 *
 * NOTE: this script does NOT migrate the gateway agent workspace files
 * (AGENTS.md / SOUL.md / IDENTITY.md) — that's the next script
 * (yarn openclaw:sync-named-agents) which the build plan tracks as PR 3.5.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ─── server registry definitions ────────────────────────────────────

const STABLE_FULL = 'sc-mission-control';
const DEV_FULL = 'sc-mission-control-dev';

// Each entry: serverName → { route suffix, paired-env counterpart }
const SCOPED_SERVERS = {
  'sc-mission-control-pm':       { template: STABLE_FULL, route: '/api/mcp/pm' },
  'sc-mission-control-pm-dev':   { template: DEV_FULL,    route: '/api/mcp/pm' },
  'sc-mission-control-crud':     { template: STABLE_FULL, route: '/api/mcp/crud' },
  'sc-mission-control-crud-dev': { template: DEV_FULL,    route: '/api/mcp/crud' },
};

// All MCP server names this script knows about. Used to compute deny
// rules so that prod agents can't see dev-flavored tool catalogs and
// vice-versa.
const STABLE_SERVERS = new Set([STABLE_FULL, 'sc-mission-control-pm', 'sc-mission-control-crud']);
const DEV_SERVERS    = new Set([DEV_FULL,    'sc-mission-control-pm-dev', 'sc-mission-control-crud-dev']);

// ─── server registry sync ───────────────────────────────────────────

function ensureScopedServer(config, name, { dryRun }) {
  config.mcp ??= { servers: {} };
  config.mcp.servers ??= {};
  if (config.mcp.servers[name]) {
    return { changed: false, message: `mcp.servers.${name} already configured` };
  }

  const def = SCOPED_SERVERS[name];
  const template = config.mcp.servers[def.template];
  if (!template) {
    throw new Error(
      `mcp.servers.${def.template} not found in openclaw.json — set up the default route first.`,
    );
  }

  // Copy command/args/token/etc. from the template; replace the URL with
  // the scoped route while preserving host:port.
  const baseUrl = template.env?.MC_URL;
  if (!baseUrl) {
    throw new Error(`mcp.servers.${def.template}.env.MC_URL missing — can't derive scoped URL.`);
  }
  const scopedUrl = baseUrl.replace(/\/api\/mcp(\/[a-z]+)?$/, def.route);
  if (scopedUrl === baseUrl || !scopedUrl.endsWith(def.route)) {
    throw new Error(
      `Failed to derive ${def.route} URL from template ${baseUrl} (expected /api/mcp suffix)`,
    );
  }

  const placeholder = {
    command: template.command,
    args: [...(template.args ?? [])],
    env: { ...template.env, MC_URL: scopedUrl },
  };

  if (!dryRun) {
    config.mcp.servers[name] = placeholder;
  }
  return { changed: true, message: `add mcp.servers.${name} → ${scopedUrl}` };
}

// ─── agent allowlist sync ───────────────────────────────────────────

const PM_AGENT_RE = /^mc-pm-/;
const RUNNER_AGENT_RE = /^mc-runner(?:-dev)?$/;

function isDevAgentId(id) {
  return id.endsWith('-dev');
}

/** PM-server name for the agent's environment. */
function pmServerFor(agentId) {
  return isDevAgentId(agentId) ? 'sc-mission-control-pm-dev' : 'sc-mission-control-pm';
}

/** Full-server name for the agent's environment. */
function fullServerFor(agentId) {
  return isDevAgentId(agentId) ? DEV_FULL : STABLE_FULL;
}

/** All cross-env server names (i.e. server names from the OTHER environment). */
function crossEnvServers(agentId) {
  return isDevAgentId(agentId) ? [...STABLE_SERVERS] : [...DEV_SERVERS];
}

/**
 * Rewrite a PM agent's alsoAllow patterns so any full-surface pattern
 * becomes the PM-scoped pattern in the same env. Other entries
 * (browser, etc.) pass through unchanged.
 */
function rewritePmAlsoAllow(alsoAllow, agentId) {
  if (!Array.isArray(alsoAllow)) return alsoAllow;
  const fullPrefix = `${fullServerFor(agentId)}__`;
  const pmPrefix = `${pmServerFor(agentId)}__`;
  return alsoAllow.map((entry) => {
    if (typeof entry !== 'string') return entry;
    if (entry.startsWith(fullPrefix)) {
      return entry.replace(fullPrefix, pmPrefix);
    }
    return entry;
  });
}

/**
 * Ensure deny[] contains a glob for every cross-env server name, plus
 * for the full-surface server in the SAME env if this is a PM agent
 * (PMs shouldn't see worker tools even in their own env). Idempotent.
 */
function rewritePmDeny(deny, agentId) {
  const existing = Array.isArray(deny) ? deny : [];
  const wanted = new Set(existing);
  // Cross-env: deny every server from the OTHER environment.
  for (const name of crossEnvServers(agentId)) {
    wanted.add(`${name}__*`);
  }
  // Same-env: PM agents must explicitly deny the full-surface server
  // (otherwise the openclaw catalog would still expose worker tools to
  // them even though alsoAllow only references the PM server).
  wanted.add(`${fullServerFor(agentId)}__*`);
  // Same-env crud: PM never reads CRUD either.
  wanted.add(isDevAgentId(agentId) ? 'sc-mission-control-crud-dev__*' : 'sc-mission-control-crud__*');
  return [...wanted];
}

/**
 * Tools we never want a runner-hosted persona to call. Surface area
 * pruning — every additional tool burns ~450 tokens of schema and adds
 * noise to the agent's decision tree. These three were called out by
 * the operator as actively unhelpful for the worker roles the runner
 * hosts:
 *   - memory_search / memory_get — openclaw's built-in personal memory
 *     surface. Runner-hosted personas get their context from MC's
 *     scope-keyed sessions + the briefing pipeline, not openclaw's
 *     per-agent memory; the memory tools encourage personas to write
 *     state that won't survive into the next dispatch.
 *   - x_search — Twitter / X search. Not a useful research surface for
 *     this org's workloads.
 */
const RUNNER_ALWAYS_DENY = [
  // Memory layer — runner hosts every persona; openclaw memory is
  // persona-agnostic and would bleed context across persona switches.
  // Belt-and-suspenders to memorySearch.enabled = false stamped below.
  'memory_search',
  'memory_get',
  // Twitter / X search — not useful for any of the worker personas
  // the runner hosts.
  'x_search',
  // Cron — scheduling is a PM / operator concern, not a runner-hosted
  // persona concern. A coordinator subagent shouldn't be able to
  // schedule wake events on the runner gateway. MC's own
  // recurring-scheduler covers the runner-side scheduling needs.
  'cron',
];

/**
 * Canonical openclaw skills list for runner-hosted personas. Same
 * surface-pruning rationale as RUNNER_ALWAYS_DENY: skills that aren't
 * useful for any of the worker personas the runner hosts (coordinator,
 * builder, tester, reviewer, researcher, writer, learner) just burn
 * context and confuse the agent's decision tree. Kept in lock-step
 * with whatever the operator validates as the working set.
 */
const RUNNER_SKILLS = [
  'acp-router',
  'github',
  'healthcheck',
  'node-connect',
  'peekaboo',
  'tmux',
  'video-frames',
  'native-data-fetching',
  'taskflow',
];

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Runner agents keep the full-surface allowlist. They still need their
 * deny[] extended so they can't see the new PM/CRUD-scoped catalogs
 * from the OTHER environment (and to keep CRUD off their plate even in
 * their own env, since they don't use it). Plus the static
 * RUNNER_ALWAYS_DENY list of tools we never want runner personas to use.
 */
function rewriteRunnerDeny(deny, agentId) {
  const existing = Array.isArray(deny) ? deny : [];
  const wanted = new Set(existing);
  // Cross-env: deny every server from the OTHER environment.
  for (const name of crossEnvServers(agentId)) {
    wanted.add(`${name}__*`);
  }
  // Same-env CRUD/PM: runners don't need either.
  if (isDevAgentId(agentId)) {
    wanted.add('sc-mission-control-pm-dev__*');
    wanted.add('sc-mission-control-crud-dev__*');
  } else {
    wanted.add('sc-mission-control-pm__*');
    wanted.add('sc-mission-control-crud__*');
  }
  // Static deny list — bare tool names (no MCP-server prefix; these
  // come from openclaw's tool catalog directly).
  for (const tool of RUNNER_ALWAYS_DENY) {
    wanted.add(tool);
  }
  return [...wanted];
}

function applyAgentChanges(config, { dryRun }) {
  const list = config.agents?.list;
  if (!Array.isArray(list)) {
    throw new Error('Expected agents.list array in openclaw.json');
  }

  const changes = [];

  for (let i = 0; i < list.length; i++) {
    const agent = list[i];
    if (typeof agent?.id !== 'string') continue;

    let updated = agent;

    if (PM_AGENT_RE.test(agent.id)) {
      // PM allowlist + deny rewrite.
      const tools = agent.tools && typeof agent.tools === 'object' ? agent.tools : {};
      const newAlsoAllow = rewritePmAlsoAllow(tools.alsoAllow, agent.id);
      const newDeny = rewritePmDeny(tools.deny, agent.id);
      const nextTools = { ...tools, alsoAllow: newAlsoAllow, deny: newDeny };
      const candidate = { ...agent, tools: nextTools };
      if (JSON.stringify(candidate) !== JSON.stringify(agent)) {
        updated = candidate;
        changes.push({
          id: agent.id,
          index: i,
          kind: 'pm-rewrite',
          block: candidate,
        });
      }
    } else if (RUNNER_AGENT_RE.test(agent.id)) {
      // Runner agents host every persona (coordinator, builder, tester,
      // reviewer, researcher, writer, learner) via scope-keyed sessions.
      // Two mutations:
      //
      //   (a) Extend tools.deny[] with the cross-env / same-env scoped
      //       MCP servers + the static RUNNER_ALWAYS_DENY list.
      //
      //   (b) Force `memorySearch.enabled = false` so openclaw's memory
      //       layer doesn't bleed context between personas hosted on
      //       the same runner gateway agent. Per-agent override of
      //       agents.defaults.memorySearch.enabled. Note: a known QMD
      //       backend regression (openclaw/openclaw#20581) may ignore
      //       this flag — combined with the memory_search/memory_get
      //       deny in RUNNER_ALWAYS_DENY, the agent-loop side is still
      //       insulated from cross-persona leakage. Stamping the flag
      //       lands the documented intent in config so the disable
      //       takes effect when the regression is fixed (or when the
      //       operator switches memory.backend to "builtin").
      const tools = agent.tools && typeof agent.tools === 'object' ? agent.tools : {};
      const newDeny = rewriteRunnerDeny(tools.deny, agent.id);
      const nextTools = { ...tools, deny: newDeny };

      const existingMemorySearch =
        agent.memorySearch && typeof agent.memorySearch === 'object' ? agent.memorySearch : {};
      const nextMemorySearch = { ...existingMemorySearch, enabled: false };

      // (b2) NOTE — DO NOT stamp `startupContext.enabled = false` here.
      // Verified against the openclaw source tree: per-agent
      // `startupContext` is NOT in the schema. The loader at
      // src/auto-reply/reply/startup-context.ts only reads from
      // `agents.defaults.startupContext`, and `AgentConfig` in
      // src/config/types.agents.ts has no `startupContext` field. The
      // schema (zod-schema.agent-defaults.ts) declares it `.strict()`,
      // so any per-agent stamp gets rejected as Unrecognized and
      // openclaw atomically reverts to last-known-good — taking out
      // the rest of our changes (cron deny, etc.) as collateral.
      //
      // 2026.427's release notes implied per-agent support was added;
      // they were misleading. Tracking upstream feature request.
      //
      // To disable daily-memory bootstrap, the operator must set it
      // GLOBALLY at agents.defaults.startupContext.enabled = false
      // (affects every agent, PM included).
      //
      // Mitigation in place: memory_search / memory_get tool deny in
      // RUNNER_ALWAYS_DENY prevents the runner-hosted personas from
      // querying memory mid-session. The bootstrap text still arrives
      // in the prompt as an [Untrusted daily memory] block the agent
      // is instructed to treat as untrusted background only.

      // (c) Pin skills to the canonical RUNNER_SKILLS list. Hard
      // overwrite — operator-validated working set; anything else just
      // burns context for personas that won't use it.
      const nextSkills = arraysEqual(agent.skills, RUNNER_SKILLS) ? agent.skills : [...RUNNER_SKILLS];

      const candidate = {
        ...agent,
        tools: nextTools,
        memorySearch: nextMemorySearch,
        skills: nextSkills,
      };
      if (JSON.stringify(candidate) !== JSON.stringify(agent)) {
        updated = candidate;
        changes.push({
          id: agent.id,
          index: i,
          kind: 'runner-rewrite',
          block: candidate,
        });
      }
    }

    if (!dryRun && updated !== agent) {
      list[i] = updated;
    }
  }

  return changes;
}

// ─── main ───────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const configFlag = args.find((a) => a.startsWith('--config='));
  const configPath = configFlag
    ? configFlag.slice('--config='.length).replace(/^~/, os.homedir())
    : path.join(os.homedir(), '.openclaw', 'openclaw.json');

  const raw = await fs.readFile(configPath, 'utf8');
  const config = JSON.parse(raw);

  console.log(`[apply-mc-servers] config: ${configPath}`);
  console.log(`[apply-mc-servers] mode: ${dryRun ? 'dry-run' : 'write'}`);

  // 1. Server registry.
  const serverResults = [];
  for (const name of Object.keys(SCOPED_SERVERS)) {
    serverResults.push({ name, ...ensureScopedServer(config, name, { dryRun }) });
  }
  for (const r of serverResults) {
    console.log(`[apply-mc-servers] mcp.servers: ${r.message}`);
  }

  // 2. Agent allowlists.
  const agentChanges = applyAgentChanges(config, { dryRun });
  if (agentChanges.length === 0) {
    console.log('[apply-mc-servers] agents: in sync (no changes)');
  } else {
    for (const c of agentChanges) {
      console.log(`[apply-mc-servers] agents: ${c.kind} ${c.id}`);
    }
  }

  const anyServerChange = serverResults.some((r) => r.changed);
  const anyAgentChange = agentChanges.length > 0;

  if (dryRun) {
    if (anyServerChange || anyAgentChange) {
      process.exitCode = 2;
    }
    return;
  }

  if (!anyServerChange && !anyAgentChange) {
    return;
  }

  const backupPath = `${configPath}.bak.${Date.now()}`;
  await fs.copyFile(configPath, backupPath);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  console.log(`[apply-mc-servers] wrote ${configPath} (backup: ${path.basename(backupPath)})`);
  console.log('[apply-mc-servers] restart openclaw to load the new server registry + allowlists.');
}

main().catch((err) => {
  console.error(`[apply-mc-servers] ERROR: ${err.message}`);
  process.exit(1);
});
