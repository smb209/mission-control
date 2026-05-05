/**
 * sc-mission-control MCP server factory.
 *
 * Returns a fresh McpServer per invocation. Per-request instantiation is
 * the recommended pattern for streamable-HTTP transports when
 * `sessionIdGenerator: undefined` (stateless) — matches the Phase 0 spike
 * (see mcp-spike/server.mjs, now removed).
 *
 * Tools are split into 5 groups (core / read / work / pm / crud) so
 * future PRs can register a subset per dispatch (e.g. role-scoped surfaces).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCoreTools } from './groups/core';
import { registerWorkTools } from './groups/work';
import { registerReadTools } from './groups/read';
import { registerPmTools } from './groups/pm';
import { registerCrudTools } from './groups/crud';

export const SERVER_NAME = 'sc-mission-control';
export const SERVER_VERSION = '0.1.0';

export type McpGroup = 'core' | 'read' | 'work' | 'pm' | 'crud';
export const ALL_GROUPS: McpGroup[] = ['core', 'read', 'work', 'pm', 'crud'];

export function buildServer(groups: McpGroup[] = ALL_GROUPS): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  if (groups.includes('core')) registerCoreTools(server);
  if (groups.includes('read')) registerReadTools(server);
  if (groups.includes('work')) registerWorkTools(server);
  if (groups.includes('pm')) registerPmTools(server);
  if (groups.includes('crud')) registerCrudTools(server);
  return server;
}
