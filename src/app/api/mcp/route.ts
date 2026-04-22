/**
 * sc-mission-control MCP endpoint.
 *
 * Streamable-HTTP transport served at POST /api/mcp (JSON-RPC) and
 * GET /api/mcp (SSE notification channel).
 *
 * Gated behind `MC_MCP_ENABLED=1`. When disabled, returns 503 so operators
 * can roll it out gradually without a code change.
 *
 * Authentication is handled by the existing src/proxy.ts middleware —
 * every request must carry `Authorization: Bearer $MC_API_TOKEN` (same as
 * the HTTP API). OpenClaw passes no agent identity, so each tool takes
 * `agent_id` as an explicit argument and the server authorizes using
 * assertAgentCanActOnTask inside each service.
 *
 * Implementation note: we use `WebStandardStreamableHTTPServerTransport`
 * (SDK's Web-Standard variant) rather than the Node-flavored
 * `StreamableHTTPServerTransport`. The Web-Standard variant takes a
 * Web-Standard `Request` and returns a `Response` — exactly what Next.js
 * App Router route handlers give us. An earlier revision tried to shim
 * the Node variant with fake req/res adapters and hit a 500 on first
 * `handleRequest` call (the SDK uses Hono's getRequestListener under the
 * hood, which expects real IncomingMessage events and can't be faked).
 * The Web-Standard variant bypasses that entirely.
 */

import { NextRequest, NextResponse } from 'next/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildServer } from '@/lib/mcp/server';

export const dynamic = 'force-dynamic';

function isEnabled(): boolean {
  return process.env.MC_MCP_ENABLED === '1' || process.env.MC_MCP_ENABLED === 'true';
}

function disabledResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'MCP endpoint is disabled',
      hint: 'Set MC_MCP_ENABLED=1 in the MC environment to enable the sc-mission-control MCP adapter.',
    },
    { status: 503 },
  );
}

/**
 * Per-request MCP server. Streamable-HTTP with `sessionIdGenerator:
 * undefined` is stateless — every request gets a fresh server + transport.
 * That matches the Phase 0 spike and avoids sharing state across
 * concurrent calls.
 */
async function handle(request: NextRequest): Promise<Response> {
  if (!isEnabled()) return disabledResponse();

  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // `enableJsonResponse: true` makes tool/list + tool/call responses plain
    // JSON. Default is SSE streaming, which is awkward for one-shot RPC
    // calls (client has to parse `data: ...` frames) and doesn't buy us
    // anything since each tool call produces exactly one response. The
    // MCP SDK clients (including our launcher's `Client`) handle both
    // modes; operators running curl diagnostics get readable JSON.
    enableJsonResponse: true,
  });
  await server.connect(transport);

  try {
    // Delegate directly to the SDK's Web-Standard handler. It reads the
    // body, runs the JSON-RPC dispatch through the connected server, and
    // returns a fully-formed Response (including SSE streaming when the
    // Accept header requests it).
    return await transport.handleRequest(request);
  } catch (err) {
    console.error('[MCP] transport.handleRequest threw:', err);
    return NextResponse.json(
      { error: 'MCP transport error', message: (err as Error).message },
      { status: 500 },
    );
  } finally {
    await transport.close().catch(() => {});
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  return handle(request);
}

export async function GET(request: NextRequest): Promise<Response> {
  return handle(request);
}
