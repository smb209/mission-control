#!/usr/bin/env node
/**
 * Next.js end-to-end test for /api/mcp.
 *
 * Spawns a real `next dev` subprocess on a random port against a throwaway
 * sqlite DB, then exercises the MCP endpoint over HTTP like a production
 * caller would. Complements scripts/mcp-integration-test.mjs, which mounts
 * the MCP server on a plain node:http listener — that version misses
 * Next.js-specific wrapper bugs in src/app/api/mcp/route.ts.
 *
 * The two bugs that shipped to production on PR 7 and would have been
 * caught by this harness:
 *
 *   1. `StreamableHTTPServerTransport` (Node-flavoured) wrapped with a
 *      fake IncomingMessage/ServerResponse shim → 500 on every request.
 *      This harness calls the REAL Next.js route handler, so the shim
 *      path (or lack thereof) is exercised.
 *
 *   2. The MCP Streamable-HTTP spec requires `Accept: application/json,
 *      text/event-stream` on every POST. Our node:http integration test
 *      used the MCP SDK client which sets this automatically. Direct
 *      `fetch` calls in this harness include and omit the header
 *      deliberately to pin down the 406 behaviour.
 *
 * WARNING: do NOT run this while `yarn dev` is running on the default
 * port — both processes would try to write to `.next/`. We use a
 * random port but share the `.next` build cache, so concurrent dev
 * servers clobber each other's incremental compilation state.
 *
 * Run:  yarn mcp:e2e:next
 * Exit: 0 on success, non-zero on first failure.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// ─── helpers ─────────────────────────────────────────────────────────

async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, { timeoutMs = 60_000, label = 'server' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      // Any 2xx/3xx/4xx proves the HTTP listener is up — 404 on the root
      // is fine, we just need a live socket that speaks HTTP.
      const res = await fetch(url, { method: 'GET' });
      if (res.status < 500) return;
    } catch (err) {
      lastErr = err;
    }
    await delay(400);
  }
  throw new Error(`${label} did not come up within ${timeoutMs}ms; last error: ${lastErr?.message ?? 'n/a'}`);
}

// ─── fixtures ────────────────────────────────────────────────────────

const fixtures = {
  agentId: '00000000-0000-0000-0000-000000000a01',
  outsiderId: '00000000-0000-0000-0000-000000000a02',
  taskId: '00000000-0000-0000-0000-000000000b10',
};

const MC_API_TOKEN = 'next-e2e-token';

// ─── main ────────────────────────────────────────────────────────────

const tmpDb = path.join(os.tmpdir(), `mcp-next-e2e-${process.pid}.db`);
for (const s of ['', '-shm', '-wal']) {
  const p = tmpDb + s;
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

const failures = [];
function expect(cond, msg) {
  if (!cond) failures.push(msg);
}

let nextProc;
let port;

try {
  port = await pickFreePort();
  const BASE = `http://127.0.0.1:${port}`;
  console.log(`[next-e2e] DB=${tmpDb} PORT=${port}`);

  // Seed fixtures via a sibling tsx script. Doing it from this plain-node
  // file directly would require bringing in tsx as a runtime; spawning a
  // small seeder keeps that layer thin.
  const { spawnSync } = await import('node:child_process');
  const seederPath = new URL('./mcp-next-e2e.seed.ts', import.meta.url).pathname;
  const seed = spawnSync('npx', ['tsx', seederPath], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_PATH: tmpDb,
      SEED_AGENT_ID: fixtures.agentId,
      SEED_OUTSIDER_ID: fixtures.outsiderId,
      SEED_TASK_ID: fixtures.taskId,
    },
    stdio: 'inherit',
  });
  if (seed.status !== 0) throw new Error('seeder failed');

  // Spawn next dev. Inherit stdio so compile errors surface. Use NODE_ENV
  // undefined so next picks 'development' itself — setting NODE_ENV=test
  // makes next refuse to start.
  console.log('[next-e2e] spawning next dev …');
  nextProc = spawn('npx', ['next', 'dev', '-p', String(port), '-H', '127.0.0.1'], {
    env: {
      ...process.env,
      NODE_ENV: undefined,
      DATABASE_PATH: tmpDb,
      MC_API_TOKEN,
      MC_MCP_ENABLED: '1',
      // Keep next dev quiet-ish so our test output stays legible.
      NEXT_TELEMETRY_DISABLED: '1',
    },
    stdio: 'inherit',
  });

  // Wait for next dev to accept HTTP connections. First request after
  // cold-start also triggers on-demand compilation of the MCP route, so
  // give it generous time.
  await waitForServer(BASE, { timeoutMs: 90_000, label: 'next dev' });

  // Prime the /api/mcp route so subsequent timing measurements aren't
  // skewed by cold-compile. Any disabled / 4xx response is fine; we just
  // need the route handler compiled.
  await fetch(`${BASE}/api/mcp`, { method: 'GET' }).catch(() => {});

  const post = async (body, extraHeaders = {}) => {
    const res = await fetch(`${BASE}/api/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MC_API_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  };

  // ── 1. 406 when Accept header is missing the SSE mime ──
  {
    const res = await fetch(`${BASE}/api/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MC_API_TOKEN}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const body = await res.json();
    expect(res.status === 406, `expected 406 when Accept omits text/event-stream, got ${res.status}`);
    expect(
      typeof body?.error?.message === 'string' &&
        body.error.message.toLowerCase().includes('must accept'),
      'expected 406 body to explain the Accept-header requirement',
    );
  }

  // ── 2. 401 when bearer is wrong ──
  {
    const res = await fetch(`${BASE}/api/mcp`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer totally-wrong',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status === 401, `expected 401 for bad bearer, got ${res.status}`);
  }

  // ── 3. tools/list returns 11 tools as JSON (not SSE) ──
  {
    const { status, json } = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    expect(status === 200, `tools/list should 200, got ${status}`);
    expect(
      Array.isArray(json?.result?.tools) && json.result.tools.length === 11,
      `tools/list should return 11 tools, got ${json?.result?.tools?.length}`,
    );
    const names = new Set(json?.result?.tools?.map((t) => t.name) ?? []);
    for (const t of [
      'whoami',
      'list_peers',
      'get_task',
      'fetch_mail',
      'register_deliverable',
      'log_activity',
      'update_task_status',
      'fail_task',
      'save_checkpoint',
      'send_mail',
      'delegate',
    ]) {
      expect(names.has(t), `tools/list missing ${t}`);
    }
  }

  // ── 4. whoami hits the real DB via the real route ──
  {
    const { status, json } = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'whoami', arguments: { agent_id: fixtures.agentId } },
    });
    expect(status === 200, `whoami should 200, got ${status}`);
    const sc = json?.result?.structuredContent ?? {};
    expect(sc.id === fixtures.agentId, `whoami should echo agent id; got ${sc.id}`);
    expect(sc.gateway_agent_id === 'mc-e2e-builder', 'whoami should return seeded gateway_agent_id');
  }

  // ── 5. register_deliverable happy path ──
  {
    const { json } = await post({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'register_deliverable',
        arguments: {
          agent_id: fixtures.agentId,
          task_id: fixtures.taskId,
          deliverable_type: 'artifact',
          title: 'next-e2e',
        },
      },
    });
    const sc = json?.result?.structuredContent ?? {};
    expect(sc.deliverable?.task_id === fixtures.taskId, 'deliverable row should reference the task');
  }

  // ── 6. cross-agent authz ──
  {
    const { json } = await post({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'register_deliverable',
        arguments: {
          agent_id: fixtures.outsiderId,
          task_id: fixtures.taskId,
          deliverable_type: 'artifact',
          title: 'should-be-blocked',
        },
      },
    });
    expect(json?.result?.isError === true, 'outsider agent should be blocked');
    expect(
      json?.result?.structuredContent?.error === 'authz_denied',
      `outsider should get authz_denied; got ${JSON.stringify(json?.result?.structuredContent)}`,
    );
  }

  // ── 7. MC_MCP_ENABLED kill-switch returns 503 (separate next dev restart
  //     would be needed to actually test the 503 path without fiddling
  //     with env mid-run; we assert the happy path and trust unit tests
  //     for the 503 branch). ──
} finally {
  if (nextProc) {
    nextProc.kill('SIGTERM');
    // Give next dev a chance to tidy up its file handles; then force-kill.
    const closed = await Promise.race([
      new Promise((r) => nextProc.once('close', r)),
      delay(5000).then(() => 'timeout'),
    ]);
    if (closed === 'timeout') nextProc.kill('SIGKILL');
  }
  for (const s of ['', '-shm', '-wal']) {
    const p = tmpDb + s;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

if (failures.length) {
  console.error('\n[next-e2e] FAILED:');
  for (const f of failures) console.error('  -', f);
  process.exit(1);
}
console.log('[next-e2e] OK — real /api/mcp route validated via next dev');
