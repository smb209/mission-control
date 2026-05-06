/**
 * sc-mission-control MCP endpoint (default — all groups).
 *
 * Streamable-HTTP transport served at POST /api/mcp (JSON-RPC) and
 * GET /api/mcp (SSE notification channel). Mounts every tool group —
 * preserves the pre-split surface for back-compat. Use `/api/mcp/pm`
 * or `/api/mcp/crud` for narrower mounts.
 *
 * Gated behind `MC_MCP_ENABLED=1`. Authentication via the existing
 * src/proxy.ts middleware — every request needs `Authorization: Bearer
 * $MC_API_TOKEN`.
 *
 * See `_handler.ts` for the streamable-HTTP plumbing comments.
 */

import { NextRequest } from 'next/server';
import { createMcpRouteHandler } from './_handler';

export const dynamic = 'force-dynamic';

const handle = createMcpRouteHandler();

export async function POST(request: NextRequest): Promise<Response> {
  return handle(request);
}

export async function GET(request: NextRequest): Promise<Response> {
  return handle(request);
}
