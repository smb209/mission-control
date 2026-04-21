/**
 * Worker context provisioning.
 *
 * MC drops a single MC-CONTEXT.json file into each gateway agent's openclaw
 * workspace so the agent has a stable, durable way to discover:
 *   - mc_url            — host-reachable URL to call Mission Control
 *   - mc_token          — bearer token for every MC callback
 *   - my_agent_id       — the agent's own MC agent_id (for From: headers in mail)
 *   - my_gateway_id     — the gateway handle (e.g. "mc-writer")
 *   - peer_agent_ids    — map of peer gateway id → MC agent_id
 *   - written_at        — ISO8601 timestamp
 *   - schema_version    — integer, bumped on breaking changes
 *
 * Why a file and not env vars / message-embedded secrets:
 *   - env vars are scoped to MC's container; openclaw runs on the host and
 *     those vars do not propagate into the agent's exec shell.
 *   - message-embedded secrets leak into `agent.event` streams and get
 *     rotated out of context by long work — the writer failure mode in the
 *     2026-04-21 debug export was exactly this.
 *   - a file on disk survives compaction, is re-readable at any time, and
 *     has no secondary transport to go wrong.
 */

import fs from 'node:fs';
import path from 'node:path';
import { queryAll } from '@/lib/db';
import { getMissionControlUrl } from '@/lib/config';

export const MC_CONTEXT_FILENAME = 'MC-CONTEXT.json';
export const MC_CONTEXT_SCHEMA_VERSION = 1;

/** Resolve the container-mounted path to openclaw's workspaces dir. */
export function getOpenclawWorkspacesPath(): string | null {
  // Prefer the container-side mount (docker-compose wires this). Fall back
  // to the host-side var so local `next dev` (no docker) still works when
  // MC is run directly against a host workspace dir.
  const explicit =
    process.env.OPENCLAW_WORKSPACES_CONTAINER_PATH ||
    process.env.OPENCLAW_WORKSPACES_HOST_PATH ||
    null;
  if (explicit) return explicit;
  // Last-ditch default for `next dev` on the host. Don't try to expand `~`
  // automatically — operators should set the env var explicitly.
  return null;
}

export interface WorkerContextFile {
  schema_version: number;
  written_at: string;
  mc_url: string;
  mc_token: string;
  my_agent_id: string;
  my_gateway_id: string;
  peer_agent_ids: Record<string, string>;
}

interface GatewayAgentRow {
  id: string;
  gateway_agent_id: string | null;
  name: string | null;
}

function loadAllGatewayAgents(): GatewayAgentRow[] {
  return queryAll<GatewayAgentRow>(
    `SELECT id, gateway_agent_id, name FROM agents
     WHERE gateway_agent_id IS NOT NULL AND gateway_agent_id != ''`
  );
}

function buildPeerMap(agents: GatewayAgentRow[], excludeGatewayId: string): Record<string, string> {
  const peers: Record<string, string> = {};
  for (const a of agents) {
    if (!a.gateway_agent_id || a.gateway_agent_id === excludeGatewayId) continue;
    peers[a.gateway_agent_id] = a.id;
  }
  return peers;
}

/** Atomically write MC-CONTEXT.json into a single agent's workspace. */
function writeContextFile(
  workspacesDir: string,
  gatewayId: string,
  payload: WorkerContextFile,
): { path: string; skipped?: string } {
  const agentDir = path.join(workspacesDir, gatewayId);
  if (!fs.existsSync(agentDir)) {
    // Don't create the workspace dir from MC — openclaw owns that lifecycle.
    // A missing dir usually means the agent hasn't been initialised in
    // openclaw yet; skip rather than mkdir'ing something half-populated.
    return { path: agentDir, skipped: 'workspace-missing' };
  }

  const target = path.join(agentDir, MC_CONTEXT_FILENAME);
  const tmp = `${target}.tmp`;
  const body = JSON.stringify(payload, null, 2) + '\n';
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, target);
  // Harden perms on rename (renameSync preserves mode of the tmp, but some
  // filesystems strip it — set explicitly as defence in depth).
  try { fs.chmodSync(target, 0o600); } catch { /* best-effort */ }
  return { path: target };
}

/**
 * Provision MC-CONTEXT.json for one gateway agent by its gateway id.
 * Returns the path written (or a skip reason). Throws if the workspaces
 * mount is not configured.
 */
export function writeWorkerContext(gatewayAgentId: string): { path: string; skipped?: string } {
  const workspacesDir = getOpenclawWorkspacesPath();
  if (!workspacesDir) {
    throw new Error(
      'OPENCLAW_WORKSPACES_CONTAINER_PATH (or _HOST_PATH) is not set — cannot write MC-CONTEXT.json'
    );
  }

  const agents = loadAllGatewayAgents();
  const me = agents.find((a) => a.gateway_agent_id === gatewayAgentId);
  if (!me) {
    throw new Error(`No agent in catalog with gateway_agent_id="${gatewayAgentId}"`);
  }

  const token = process.env.MC_API_TOKEN || '';
  const payload: WorkerContextFile = {
    schema_version: MC_CONTEXT_SCHEMA_VERSION,
    written_at: new Date().toISOString(),
    mc_url: getMissionControlUrl(),
    mc_token: token,
    my_agent_id: me.id,
    my_gateway_id: gatewayAgentId,
    peer_agent_ids: buildPeerMap(agents, gatewayAgentId),
  };

  return writeContextFile(workspacesDir, gatewayAgentId, payload);
}

/**
 * Provision MC-CONTEXT.json for every known gateway agent. Used at MC
 * startup and after every catalog sync. Returns per-agent outcomes so
 * callers can log a summary.
 */
export function writeAllWorkerContexts(): Array<{
  gateway_agent_id: string;
  path: string;
  skipped?: string;
  error?: string;
}> {
  const workspacesDir = getOpenclawWorkspacesPath();
  if (!workspacesDir) {
    return [];
  }

  const agents = loadAllGatewayAgents();
  const token = process.env.MC_API_TOKEN || '';
  const mcUrl = getMissionControlUrl();
  const now = new Date().toISOString();
  const results: Array<{ gateway_agent_id: string; path: string; skipped?: string; error?: string }> = [];

  for (const me of agents) {
    if (!me.gateway_agent_id) continue;
    const payload: WorkerContextFile = {
      schema_version: MC_CONTEXT_SCHEMA_VERSION,
      written_at: now,
      mc_url: mcUrl,
      mc_token: token,
      my_agent_id: me.id,
      my_gateway_id: me.gateway_agent_id,
      peer_agent_ids: buildPeerMap(agents, me.gateway_agent_id),
    };
    try {
      const out = writeContextFile(workspacesDir, me.gateway_agent_id, payload);
      results.push({ gateway_agent_id: me.gateway_agent_id, ...out });
    } catch (err) {
      results.push({
        gateway_agent_id: me.gateway_agent_id,
        path: path.join(workspacesDir, me.gateway_agent_id, MC_CONTEXT_FILENAME),
        error: (err as Error).message,
      });
    }
  }

  return results;
}
