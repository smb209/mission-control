/**
 * sc-mission-control MCP server factory.
 *
 * Returns a fresh McpServer per invocation. Per-request instantiation is
 * the recommended pattern for streamable-HTTP transports when
 * `sessionIdGenerator: undefined` (stateless) — matches the Phase 0 spike
 * (see mcp-spike/server.mjs, now removed).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './tools';

export const SERVER_NAME = 'sc-mission-control';
export const SERVER_VERSION = '0.1.0';

export function buildServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerAllTools(server);
  return server;
}
