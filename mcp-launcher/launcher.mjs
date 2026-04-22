#!/usr/bin/env node
/**
 * sc-mission-control MCP launcher.
 *
 * OpenClaw spawns this as a stdio MCP server (one process, shared across
 * agents — Phase 0 spike confirmed the subprocess is re-used). This
 * process proxies every JSON-RPC message over HTTP to MC's /mcp
 * endpoint.
 *
 * Config (passed via openclaw.json `mcp.servers.sc-mission-control.env`):
 *   MC_URL        — e.g. http://localhost:4001/mcp (required)
 *   MC_API_TOKEN  — bearer token for the MC endpoint (required)
 *
 * Usage:
 *   openclaw mcp set sc-mission-control '{
 *     "command": "node",
 *     "args": ["/abs/path/to/mcp-launcher/launcher.mjs"],
 *     "env": { "MC_URL": "http://localhost:4001/mcp",
 *              "MC_API_TOKEN": "<token>" }
 *   }'
 *
 * Everything happens in one shared subprocess — agents distinguish
 * themselves by passing `agent_id` on every state-changing tool call.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const MC_URL = process.env.MC_URL;
const MC_API_TOKEN = process.env.MC_API_TOKEN;

if (!MC_URL) {
  process.stderr.write('[launcher] MC_URL env var is required\n');
  process.exit(1);
}
if (!MC_API_TOKEN) {
  process.stderr.write('[launcher] MC_API_TOKEN env var is required\n');
  process.exit(1);
}

process.stderr.write(`[launcher] sc-mission-control launcher starting, proxying to ${MC_URL}\n`);

// Connect an MCP client to MC's HTTP endpoint. This is the upstream
// we'll forward every inbound JSON-RPC call to.
const upstream = new Client({ name: 'sc-mc-launcher', version: '0.1.0' });
const upstreamTransport = new StreamableHTTPClientTransport(new URL(MC_URL), {
  requestInit: {
    headers: { Authorization: `Bearer ${MC_API_TOKEN}` },
  },
});

try {
  await upstream.connect(upstreamTransport);
} catch (err) {
  const raw = err?.message ?? String(err);
  let parsedUrl;
  try { parsedUrl = new URL(MC_URL); } catch { /* MC_URL invalid — fall through */ }

  process.stderr.write(`[launcher] Failed to connect to MC at ${MC_URL}\n`);

  // Replace the raw error (which for HTTP failures often includes a full
  // HTML page dump from Next.js) with a targeted hint when we can
  // recognise the failure mode. Falls back to a truncated raw message
  // for anything we don't recognise.
  const hint = diagnose(raw, parsedUrl);
  if (hint) {
    process.stderr.write(`[launcher] ${hint}\n`);
  } else {
    const truncated = raw.length > 400 ? raw.slice(0, 400) + '… (truncated)' : raw;
    process.stderr.write(`[launcher] ${truncated}\n`);
  }
  process.exit(2);
}

/**
 * Map a launcher-connect error into a human-readable, actionable hint.
 * Each case surfaces the most likely cause + the exact fix. Returns null
 * when we don't recognise the failure — the caller prints a truncated
 * raw error instead.
 *
 * Cases recognised:
 *   1. HTML response  — MC is up but MC_URL path is wrong
 *                       (PR 7 moved the route from /mcp to /api/mcp; the
 *                       most common misconfiguration is a stale openclaw
 *                       mcp set with the old path).
 *   2. 503 disabled   — MC_MCP_ENABLED isn't set on the MC container.
 *   3. 401 / auth     — MC_API_TOKEN mismatch between launcher env and MC.
 *   4. ECONNREFUSED   — MC isn't running on the host/port in MC_URL.
 *   5. DNS / host     — bad hostname.
 *   6. non-JSON body  — endpoint responded but didn't speak JSON-RPC.
 */
function diagnose(rawError, mcUrl) {
  const lower = String(rawError).toLowerCase();

  if (lower.includes('<!doctype html') || lower.includes('<html')) {
    if (mcUrl && mcUrl.pathname !== '/api/mcp') {
      return (
        `Response was HTML (likely a Next.js 404). Your MC_URL path is "${mcUrl.pathname}" ` +
        `but sc-mission-control mounts at /api/mcp. Fix: ` +
        `openclaw mcp set sc-mission-control '...' with MC_URL=${mcUrl.protocol}//${mcUrl.host}/api/mcp, ` +
        `then openclaw gateway restart.`
      );
    }
    return (
      `Response was HTML (likely a 404/error page). MC may not be running the PR-7-or-newer ` +
      `build that mounts /api/mcp. Check 'docker ps | grep mission-control' and the container was rebuilt recently.`
    );
  }

  if (lower.includes('mcp endpoint is disabled') || lower.includes('503')) {
    return (
      `MC returned 503 — MC_MCP_ENABLED isn't set on the MC container. ` +
      `Add MC_MCP_ENABLED: "1" to docker-compose.yml (mission-control.environment) and restart.`
    );
  }

  if (lower.includes('401') || lower.includes('unauthorized')) {
    return (
      `MC returned 401 — MC_API_TOKEN mismatch. Compare the token in ` +
      `'openclaw mcp show sc-mission-control' with the MC_API_TOKEN env in the mission-control container ` +
      `(docker inspect mission-control | grep MC_API_TOKEN).`
    );
  }

  if (
    lower.includes('econnrefused') ||
    lower.includes('connect refused') ||
    lower.includes('fetch failed')
  ) {
    const host = mcUrl ? `${mcUrl.protocol}//${mcUrl.host}` : MC_URL;
    return (
      `Connection refused to ${host}. MC isn't reachable on that port. ` +
      `Check 'docker ps | grep mission-control' and 'curl ${host}/api/health'.`
    );
  }

  if (lower.includes('enotfound') || lower.includes('getaddrinfo')) {
    return (
      `DNS lookup failed for ${mcUrl?.host ?? MC_URL}. Check the hostname ` +
      `(use 'localhost' when MC runs on the same host as the launcher, or 'host.docker.internal' only when the LAUNCHER runs inside a container).`
    );
  }

  if (
    lower.includes('unexpected token') ||
    lower.includes('invalid json') ||
    lower.includes('not valid json')
  ) {
    return (
      `Endpoint responded but returned non-JSON. The MC_URL is probably not the /api/mcp route. ` +
      `Current: ${mcUrl?.pathname ?? '(invalid URL)'}. Expected: /api/mcp.`
    );
  }

  return null;
}

// Downstream server — openclaw connects to this over stdio.
const downstream = new Server(
  { name: 'sc-mission-control', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// Proxy tools/list
downstream.setRequestHandler(ListToolsRequestSchema, async () => {
  return await upstream.listTools();
});

// Proxy tools/call
downstream.setRequestHandler(CallToolRequestSchema, async (req) => {
  return await upstream.callTool({
    name: req.params.name,
    arguments: req.params.arguments ?? {},
  });
});

const downstreamTransport = new StdioServerTransport();
await downstream.connect(downstreamTransport);

process.stderr.write('[launcher] ready; awaiting stdio requests\n');

// Clean shutdown on SIGTERM/SIGINT so openclaw's process supervisor
// doesn't accumulate zombies.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    process.stderr.write(`[launcher] ${sig} received; closing\n`);
    await downstream.close().catch(() => {});
    await upstream.close().catch(() => {});
    process.exit(0);
  });
}
