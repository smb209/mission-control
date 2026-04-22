/**
 * Debug-log helper for MCP tool invocations.
 *
 * Emits one `mcp.tool_call` row per invocation so the debug-events export
 * shows tool calls inline with the rest of the agent's traffic. Mirrors
 * the shape used by dispatch's `chat.send` rows so filters / the export
 * UI don't need special-casing.
 */

import { logDebugEvent } from '@/lib/debug-log';

export interface McpToolCallLog {
  toolName: string;
  agentId: string | null;
  taskId?: string | null;
  ok: boolean;
  durationMs: number;
  error?: string;
  /** Safe arg summary — never includes secrets. */
  argsSummary?: Record<string, unknown>;
}

export function logMcpToolCall(entry: McpToolCallLog): void {
  logDebugEvent({
    type: 'mcp.tool_call',
    direction: 'inbound',
    taskId: entry.taskId ?? null,
    agentId: entry.agentId,
    durationMs: entry.durationMs,
    error: entry.error ?? null,
    metadata: {
      tool_name: entry.toolName,
      ok: entry.ok,
      ...(entry.argsSummary ? { args: entry.argsSummary } : {}),
    },
  });
}
