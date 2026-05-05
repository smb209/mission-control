/**
 * Shared streamable-HTTP handler for MCP route variants.
 *
 * The default `/api/mcp` route mounts every group; scoped routes
 * (`/api/mcp/pm`, `/api/mcp/crud`, future per-agent splits) mount a
 * narrower subset by passing a `groups` array to `buildServer`.
 *
 * See `src/lib/mcp/server.ts` for group definitions and
 * `specs/mcp-surface-review.md` for why we split.
 */

import { NextRequest, NextResponse } from 'next/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildServer, type McpGroup } from '@/lib/mcp/server';

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
 * Returns a `(request) => Response` handler bound to the given group
 * subset. Per-request the server + transport are constructed fresh —
 * see `src/app/api/mcp/route.ts` original comment for the rationale.
 */
export function createMcpRouteHandler(groups?: McpGroup[]) {
  return async function handle(request: NextRequest): Promise<Response> {
    if (!isEnabled()) return disabledResponse();

    const server = buildServer(groups);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);

    try {
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
  };
}
