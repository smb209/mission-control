/**
 * MCP identity-passing spike — stdio edition.
 *
 * Phase 0 of the sc-mission-control MCP adapter plan. Answers one question:
 * when openclaw launches or talks to an MCP server, how (if at all) does it
 * tell the server which agent is calling?
 *
 * The header-interpolation design we first considered is dead: openclaw's
 * `${OPENCLAW_AGENT_ID}` resolution happens at config load against the
 * shell env, not per-agent at connection time. So for identity we need one
 * of:
 *
 *   - openclaw injects per-agent env vars into the MCP subprocess at spawn
 *   - openclaw populates `initialize.params.clientInfo` with agent-ish data
 *   - openclaw passes agent id in the tool-call arguments
 *   - nothing — in which case every tool must take an explicit agent-id arg
 *
 * This server probes all four by logging:
 *   - every env var visible to the subprocess
 *   - argv and cwd
 *   - the full `initialize` params (which carries `clientInfo`)
 *   - the full `_meta` / args of every tool call
 *
 * All observation output goes to a LOG FILE (stdout is the JSON-RPC channel
 * for stdio transport). The `whoami` tool returns the same dump so the
 * agent-side also sees what arrived.
 *
 * Run: `node server.mjs`  — prints the log path to stderr on startup.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const LOG_PATH = path.join(os.tmpdir(), 'mcp-spike.log');
const log = fs.createWriteStream(LOG_PATH, { flags: 'a' });
const write = (obj) => log.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n');

// Dump what the subprocess saw at launch — this is where per-agent env
// injection would appear if openclaw does any.
write({
  event: 'process_start',
  argv: process.argv,
  cwd: process.cwd(),
  pid: process.pid,
  ppid: process.ppid,
  env: Object.fromEntries(
    Object.entries(process.env).filter(([k]) =>
      // only dump openclaw-ish / agent-ish keys to keep the log readable
      /openclaw|agent|mcp|mission|claw|gateway/i.test(k),
    ),
  ),
  env_all_keys: Object.keys(process.env).sort(),
});

// stderr summary so the operator sees the file path without tailing
process.stderr.write(`[spike-echo] pid=${process.pid} logging to ${LOG_PATH}\n`);

const server = new McpServer({ name: 'spike-echo', version: '0.0.1' });

server.registerTool(
  'whoami',
  {
    description:
      'Returns everything the spike MCP server could observe about who is calling: env, argv, clientInfo from initialize, and the tool-call _meta.',
    inputSchema: {},
  },
  async (_args, extra) => {
    // authInfo / sessionId / _meta are where MCP normally carries identity
    // and per-call metadata — pull their VALUES, not just the key names.
    const authInfo = extra && 'authInfo' in extra ? safeJson(extra.authInfo) : null;
    const sessionId = extra && 'sessionId' in extra ? extra.sessionId : null;
    const meta = extra && '_meta' in extra ? safeJson(extra._meta) : null;
    const requestInfo = extra && 'requestInfo' in extra ? safeJson(extra.requestInfo) : null;

    write({
      event: 'tool_call_whoami',
      extra_keys: extra ? Object.keys(extra) : [],
      authInfo,
      sessionId,
      meta,
      requestInfo,
      // Full extra (functions stripped by safeJson) for anything we missed.
      extra: safeJson(extra),
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              note: 'see mcp-spike.log on the host for full process_start + initialized dumps',
              pid: process.pid,
              cwd: process.cwd(),
              // Identity candidates — echo the VALUES so the agent can see them in chat.
              sessionId,
              authInfo,
              meta,
              requestInfo,
              // Plus any env vars that look openclaw/agent/mcp-ish
              env_openclaw_ish: Object.fromEntries(
                Object.entries(process.env).filter(([k]) =>
                  /openclaw|agent|mcp|mission|claw|gateway|session/i.test(k),
                ),
              ),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// Hook the underlying Server to capture the `initialize` params too — the
// high-level McpServer doesn't expose those directly.
const rawServer = server.server;
const originalInit = rawServer.oninitialized;
rawServer.oninitialized = () => {
  write({
    event: 'initialized',
    clientInfo: rawServer.getClientVersion?.() ?? null,
    clientCapabilities: rawServer.getClientCapabilities?.() ?? null,
  });
  if (typeof originalInit === 'function') originalInit();
};

const transport = new StdioServerTransport();
await server.connect(transport);

function safeJson(obj) {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return String(obj);
  }
}
