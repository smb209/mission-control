/**
 * MCP error mapping.
 *
 * Service-layer functions throw `AuthzError` with a typed `code`. MCP tool
 * handlers catch and return a standard tool-error content block so the
 * calling agent sees a clean "forbidden" message instead of a JSON-RPC
 * protocol error (which would be interpreted as server malfunction).
 */

import { AuthzError } from '@/lib/authz/agent-task';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function authzErrorToToolResult(err: AuthzError): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `Authorization denied (${err.code}): ${err.message}`,
      },
    ],
    structuredContent: {
      error: 'authz_denied',
      code: err.code,
      message: err.message,
    },
  };
}

export function internalErrorToToolResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `Internal error: ${message}`,
      },
    ],
    structuredContent: {
      error: 'internal_error',
      message,
    },
  };
}
