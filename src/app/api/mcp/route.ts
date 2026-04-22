/**
 * sc-mission-control MCP endpoint.
 *
 * Streamable-HTTP transport served at POST /mcp (for JSON-RPC messages)
 * and GET /mcp (for the server→client SSE notification channel).
 *
 * Gated behind `MC_MCP_ENABLED=1`. When disabled, returns 503 so operators
 * can roll it out gradually without a code change.
 *
 * Authentication is handled by the existing src/proxy.ts middleware —
 * every request must carry `Authorization: Bearer $MC_API_TOKEN` (same as
 * the HTTP API). OpenClaw passes no agent identity, so each tool takes
 * `agent_id` as an explicit argument and the server authorizes using
 * assertAgentCanActOnTask inside each service.
 */

import { NextRequest, NextResponse } from 'next/server';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
 * Handle an MCP JSON-RPC request. Per the SDK pattern for stateless
 * streamable-HTTP servers, we build a fresh server + transport per call.
 * This matches the spike and avoids sharing state across concurrent
 * requests (each agent's call gets its own handler).
 *
 * Next.js route handlers receive a `Request` object, but the MCP SDK's
 * `handleRequest` expects a Node `IncomingMessage`/`ServerResponse` pair.
 * We bridge via a minimal adapter.
 */
async function handle(request: NextRequest): Promise<Response> {
  if (!isEnabled()) return disabledResponse();

  // Read the full body once — the SDK expects an already-parsed JSON body
  // for POST (it doesn't re-read the stream).
  let body: unknown = undefined;
  if (request.method === 'POST') {
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  // Collect response into a Web Response — the SDK writes into a Node
  // ServerResponse-like object. We accumulate chunks and the final
  // status/headers, then hand back a standard Response.
  const responseChunks: Uint8Array[] = [];
  let responseStatus = 200;
  const responseHeaders = new Headers();
  let finished = false;

  // Minimal ServerResponse adapter. The SDK uses writeHead/setHeader/write/end.
  const fakeRes = {
    statusCode: 200,
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      responseStatus = status;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) responseHeaders.set(k, v);
      }
      return fakeRes;
    },
    setHeader(name: string, value: string | string[]) {
      const v = Array.isArray(value) ? value.join(', ') : value;
      responseHeaders.set(name, v);
      return fakeRes;
    },
    getHeader(name: string) {
      return responseHeaders.get(name);
    },
    write(chunk: unknown) {
      const buf =
        typeof chunk === 'string'
          ? new TextEncoder().encode(chunk)
          : (chunk as Uint8Array);
      responseChunks.push(buf);
      return true;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) {
        const buf =
          typeof chunk === 'string'
            ? new TextEncoder().encode(chunk)
            : (chunk as Uint8Array);
        responseChunks.push(buf);
      }
      finished = true;
      return fakeRes;
    },
    on() {
      return fakeRes;
    },
    once() {
      return fakeRes;
    },
    emit() {
      return false;
    },
  };

  // The SDK's `handleRequest` reads req.headers/method for routing. Build
  // a minimal IncomingMessage-like object.
  const fakeReq = {
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers.entries()),
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await transport.handleRequest(fakeReq as any, fakeRes as any, body);
  } catch (err) {
    // Close the transport on error so connect() doesn't leak; rethrow.
    await transport.close().catch(() => {});
    return NextResponse.json(
      { error: 'MCP transport error', message: (err as Error).message },
      { status: 500 },
    );
  }

  await transport.close().catch(() => {});

  // Concatenate collected chunks
  const bodyBytes =
    responseChunks.length === 0
      ? new Uint8Array()
      : responseChunks.length === 1
        ? responseChunks[0]
        : (() => {
            const total = responseChunks.reduce((n, c) => n + c.length, 0);
            const merged = new Uint8Array(total);
            let offset = 0;
            for (const c of responseChunks) {
              merged.set(c, offset);
              offset += c.length;
            }
            return merged;
          })();

  // `bodyBytes` is a Uint8Array. Node's `new Response(body)` accepts
  // BodyInit including strings — decoding first sidesteps TS's confusion
  // between Uint8Array<ArrayBuffer> and Uint8Array<ArrayBufferLike>
  // variants. MCP responses are always UTF-8 JSON.
  const bodyText = new TextDecoder().decode(bodyBytes);
  return new Response(bodyText, {
    status: finished ? responseStatus : 200,
    headers: responseHeaders,
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  return handle(request);
}

export async function GET(request: NextRequest): Promise<Response> {
  return handle(request);
}
