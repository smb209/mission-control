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
  process.stderr.write(`[launcher] Failed to connect to MC at ${MC_URL}: ${err.message}\n`);
  process.exit(2);
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
