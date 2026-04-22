/**
 * Worker context provisioning.
 *
 * MC drops a single MC-CONTEXT.json file into each gateway agent's
 * openclaw workspace. After PR 6, the file carries exactly one durable
 * piece of information: the agent's own MC agent_id, which it needs to
 * pass as the first arg to every sc-mission-control MCP tool call. The
 * `mc_url`, `mc_token`, and `peer_agent_ids` fields were removed — the
 * MCP launcher already carries the URL + token in its env, and peers
 * are discovered via the live `list_peers` tool.
 *
 * Schema:
 *   - my_agent_id       — the agent's own MC agent_id
 *   - my_gateway_id     — the gateway handle (e.g. "mc-writer")
 *   - written_at        — ISO8601 timestamp
 *   - schema_version    — integer, bumped on breaking changes (v2 in PR 6)
 */

import fs from 'node:fs';
import path from 'node:path';
import { queryAll } from '@/lib/db';

export const MC_CONTEXT_FILENAME = 'MC-CONTEXT.json';
export const MC_CONTEXT_SCHEMA_VERSION = 2;

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
  my_agent_id: string;
  my_gateway_id: string;
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

  const payload: WorkerContextFile = {
    schema_version: MC_CONTEXT_SCHEMA_VERSION,
    written_at: new Date().toISOString(),
    my_agent_id: me.id,
    my_gateway_id: gatewayAgentId,
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
  const now = new Date().toISOString();
  const results: Array<{ gateway_agent_id: string; path: string; skipped?: string; error?: string }> = [];

  for (const me of agents) {
    if (!me.gateway_agent_id) continue;
    const payload: WorkerContextFile = {
      schema_version: MC_CONTEXT_SCHEMA_VERSION,
      written_at: now,
      my_agent_id: me.id,
      my_gateway_id: me.gateway_agent_id,
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
