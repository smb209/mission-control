#!/usr/bin/env node
/**
 * Launcher smoke test.
 *
 * Spawns the real launcher.mjs as a subprocess with stdio piped, and runs
 * it against a throwaway HTTP server that pretends to be Mission Control's
 * /mcp endpoint. We drive the launcher over its stdin/stdout as any
 * MCP stdio client would, and assert:
 *
 *   1. The launcher connects upstream (handshake with the mock)
 *   2. `tools/list` arrives through the proxy and returns the mock's list
 *   3. `tools/call` arrives through the proxy, carrying correct args +
 *      bearer to the mock
 *   4. Clean shutdown on SIGTERM
 *
 * No Mission Control required. Exits 0 on success, non-zero on failure
 * with a human-readable diagnosis on stderr.
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const LAUNCHER = new URL('./launcher.mjs', import.meta.url).pathname;

// ─── Mock MC /mcp endpoint ──────────────────────────────────────────
//
// The SDK's Streamable-HTTP client sends JSON-RPC over POST and opens a
// GET for server→client notifications. We respond to POSTs with the
// expected JSON-RPC envelopes and 200-noop GETs.

const mockCalls = [];

function buildMockMc() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      mockCalls.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body || null,
      });

      if (req.method !== 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end();
        return;
      }

      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }

      const respond = (result) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };

      switch (msg.method) {
        case 'initialize':
          respond({
            protocolVersion: '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'mock-mc', version: '0.0.0' },
          });
          break;
        case 'notifications/initialized':
          res.writeHead(202).end();
          break;
        case 'tools/list':
          respond({
            tools: [
              { name: 'whoami', description: 'test', inputSchema: { type: 'object' } },
              { name: 'register_deliverable', description: 'test', inputSchema: { type: 'object' } },
            ],
          });
          break;
        case 'tools/call':
          respond({
            content: [{ type: 'text', text: `mock got ${msg.params?.name}` }],
            structuredContent: { got: msg.params?.name, args: msg.params?.arguments ?? {} },
          });
          break;
        default:
          respond({});
      }
    });
  });
}

// ─── Drive the launcher over stdio ──────────────────────────────────

function writeLine(proc, obj) {
  proc.stdin.write(JSON.stringify(obj) + '\n');
}

async function readOneJsonRpcFrame(buf) {
  // Content-Length framing isn't used here; the SDK's stdio transport
  // writes one JSON per line.
  const idx = buf.indexOf('\n');
  if (idx < 0) return { frame: null, remainder: buf };
  const line = buf.slice(0, idx);
  return { frame: line.toString('utf8'), remainder: buf.slice(idx + 1) };
}

async function collectFrames(proc, want, timeoutMs = 4000) {
  let buf = Buffer.alloc(0);
  const frames = [];
  const deadline = Date.now() + timeoutMs;

  return await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let out;
      while ((out = readOneJsonRpcFrameSync(buf)).frame !== null) {
        buf = out.remainder;
        try {
          frames.push(JSON.parse(out.frame));
        } catch {
          // ignore
        }
        if (frames.length >= want) {
          proc.stdout.off('data', onData);
          resolve(frames);
          return;
        }
      }
    };
    proc.stdout.on('data', onData);

    const checker = setInterval(() => {
      if (Date.now() > deadline) {
        clearInterval(checker);
        proc.stdout.off('data', onData);
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for ${want} frame(s); got ${frames.length}`,
          ),
        );
      }
    }, 50);
  });
}

function readOneJsonRpcFrameSync(buf) {
  const idx = buf.indexOf('\n');
  if (idx < 0) return { frame: null, remainder: buf };
  return { frame: buf.slice(0, idx).toString('utf8'), remainder: buf.slice(idx + 1) };
}

// ─── Main ───────────────────────────────────────────────────────────

const failures = [];
function expect(cond, msg) {
  if (!cond) failures.push(msg);
}

const mock = buildMockMc();
await new Promise((r) => mock.listen(0, r));
const port = mock.address().port;
const MC_URL = `http://127.0.0.1:${port}/mcp`;
console.log(`[smoke] mock MC listening on ${MC_URL}`);

const proc = spawn('node', [LAUNCHER], {
  env: {
    ...process.env,
    MC_URL,
    MC_API_TOKEN: 'spike-token-42',
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});

try {
  // Wait for the launcher to connect to the mock upstream before we
  // start sending stdio requests. The "[launcher] ready" line shows up
  // on stderr (inherited) — give it a beat.
  await delay(500);

  // 1. initialize
  writeLine(proc, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    },
  });
  writeLine(proc, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });

  // 2. tools/list
  writeLine(proc, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });

  // 3. tools/call
  writeLine(proc, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'register_deliverable',
      arguments: {
        agent_id: 'test-agent',
        task_id: 'test-task',
        deliverable_type: 'artifact',
        title: 'smoke',
      },
    },
  });

  const frames = await collectFrames(proc, 3);

  // Responses may arrive in id order. Match by id.
  const byId = Object.fromEntries(frames.filter((f) => f.id).map((f) => [f.id, f]));

  expect(byId[1]?.result?.protocolVersion, 'initialize response missing protocolVersion');
  expect(
    Array.isArray(byId[2]?.result?.tools) && byId[2].result.tools.length >= 2,
    'tools/list should return at least two tools from the mock',
  );
  expect(
    byId[3]?.result?.structuredContent?.got === 'register_deliverable',
    'tools/call should forward the tool name to the mock',
  );

  // Verify the mock actually saw the bearer on every inbound request.
  const seenBearer = mockCalls
    .filter((c) => c.method === 'POST')
    .every((c) => c.headers.authorization === 'Bearer spike-token-42');
  expect(seenBearer, 'launcher did not carry the MC_API_TOKEN bearer to every POST');

  // Verify the mock received the tool args literally (the launcher should
  // not mutate request payloads).
  const toolCall = mockCalls
    .filter((c) => c.method === 'POST' && c.body?.includes('tools/call'))
    .pop();
  expect(
    toolCall && JSON.parse(toolCall.body).params?.arguments?.title === 'smoke',
    'launcher should forward tool arguments unchanged',
  );
} finally {
  proc.kill('SIGTERM');
  await new Promise((r) => proc.once('close', r));
  await new Promise((r) => mock.close(r));
}

// ─── Regression test: launcher's diagnose() must emit a friendly hint
// when MC returns HTML 404 instead of JSON-RPC. This is the exact
// failure mode a stale openclaw mcp set (MC_URL pointing at /mcp
// instead of /api/mcp) produces in production.
{
  const htmlMock = http.createServer((_req, res) => {
    // Minimal Next.js-ish 404 page. The launcher's diagnose() matches on
    // "<!DOCTYPE html" / "<html".
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end(
      '<!DOCTYPE html><html><body><h1>404</h1><p>This page could not be found.</p></body></html>',
    );
  });
  await new Promise((r) => htmlMock.listen(0, r));
  const htmlPort = htmlMock.address().port;

  // Use a path that doesn't match /api/mcp so the path-specific branch
  // of diagnose() fires (the highest-value message).
  const badUrl = `http://127.0.0.1:${htmlPort}/mcp`;
  const proc2 = spawn('node', [LAUNCHER], {
    env: { ...process.env, MC_URL: badUrl, MC_API_TOKEN: 'spike-token-42' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderrChunks = [];
  proc2.stderr.on('data', (c) => stderrChunks.push(c));

  const code = await new Promise((r) => proc2.once('close', r));
  const stderr = Buffer.concat(stderrChunks).toString('utf8');

  expect(code === 2, `launcher should exit 2 on connect failure, got ${code}`);
  expect(
    stderr.includes('Response was HTML') && stderr.includes('/api/mcp'),
    `expected diagnose() HTML-404 hint in stderr, got: ${stderr.slice(0, 300)}`,
  );
  expect(
    !stderr.includes('<!DOCTYPE html'),
    "diagnose() should replace the raw HTML dump with a hint — don't leak the HTML to stderr",
  );

  await new Promise((r) => htmlMock.close(r));
}

if (failures.length) {
  console.error('\n[smoke] FAILED:');
  for (const f of failures) console.error('  -', f);
  process.exit(1);
}
console.log(`[smoke] OK — ${mockCalls.filter((c) => c.method === 'POST').length} proxied POSTs validated + HTML-404 diagnosis regression`);
