#!/usr/bin/env node
/**
 * End-to-end integration test for the sc-mission-control MCP adapter.
 *
 * What it validates:
 *   1. The MCP server (src/lib/mcp/server.ts + tools.ts) builds cleanly and
 *      listens over Streamable-HTTP.
 *   2. The launcher (mcp-launcher/launcher.mjs) proxies stdio JSON-RPC to
 *      that HTTP endpoint, carrying the bearer token.
 *   3. The full completion flow for a piloted agent:
 *        whoami → register_deliverable → log_activity → update_task_status
 *      succeeds end-to-end, and the task's status actually changes in sqlite.
 *   4. An unrelated agent is rejected with `authz_denied` at the tool layer
 *      (proves the service-level authz from PR 1 is reachable via MCP).
 *   5. `fetch_mail` refuses an unknown agent_id (proves the PR 7 authz fix).
 *
 * Shape: one process for the Node HTTP MCP server; one subprocess for the
 * launcher; stdio framing to drive it. No Next.js required — we mount the
 * same `buildServer()` + `StreamableHTTPServerTransport` the route handler
 * uses, directly on http.createServer.
 *
 * Run: npm run mcp:integration
 * Exit 0 on success, non-zero on first failure with a human-readable
 * diagnosis on stderr.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// Use a dedicated tmpfile DB so we don't touch the dev / test sqlite.
const tmpDbPath = path.join(os.tmpdir(), `mcp-e2e-${process.pid}.db`);
for (const suffix of ['', '-shm', '-wal']) {
  const p = tmpDbPath + suffix;
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = tmpDbPath;
process.env.MC_API_TOKEN = 'e2e-token';
process.env.MC_MCP_ENABLED = '1';

// Require tsx's loader so we can import TS source. We use --import tsx
// when running this script from package.json — see the companion script.
const { buildServer } = await import('../src/lib/mcp/server.ts');
const { StreamableHTTPServerTransport } = await import(
  '@modelcontextprotocol/sdk/server/streamableHttp.js'
);
const { run } = await import('../src/lib/db/index.ts');

// ─── Seed fixtures ───────────────────────────────────────────────────

const agentId = '00000000-0000-0000-0000-000000000001';
const outsiderId = '00000000-0000-0000-0000-000000000002';
const taskId = '00000000-0000-0000-0000-000000000010';
const recipientId = '00000000-0000-0000-0000-000000000003';

run(
  `INSERT INTO agents (id, name, role, workspace_id, is_active, gateway_agent_id, created_at, updated_at)
   VALUES (?, 'Piloted Builder', 'builder', 'default', 1, 'mc-builder-e2e', datetime('now'), datetime('now'))`,
  [agentId],
);
run(
  `INSERT INTO agents (id, name, role, workspace_id, is_active, gateway_agent_id, created_at, updated_at)
   VALUES (?, 'Outsider', 'tester', 'default', 1, 'mc-outsider', datetime('now'), datetime('now'))`,
  [outsiderId],
);
run(
  `INSERT INTO agents (id, name, role, workspace_id, is_active, gateway_agent_id, created_at, updated_at)
   VALUES (?, 'Recipient', 'reviewer', 'default', 1, 'mc-recipient', datetime('now'), datetime('now'))`,
  [recipientId],
);
run(
  `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at)
   VALUES (?, 'E2E task', 'in_progress', 'normal', 'default', 'default', ?, datetime('now'), datetime('now'))`,
  [taskId, agentId],
);

// ─── Mount MCP handler on a local HTTP server ────────────────────────
//
// Mirrors the handle() function in src/app/api/mcp/route.ts (Next.js
// route) but without Next. Same server, same transport — gives us a
// loopback MC MCP endpoint for the launcher to proxy to.

const mcServer = http.createServer(async (req, res) => {
  if (req.url !== '/mcp') {
    res.writeHead(404).end();
    return;
  }
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${process.env.MC_API_TOKEN}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  let body = undefined;
  if (req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        res.writeHead(400).end();
        return;
      }
    }
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  try {
    await transport.handleRequest(req, res, body);
  } finally {
    await transport.close().catch(() => {});
  }
});
await new Promise((r) => mcServer.listen(0, '127.0.0.1', r));
const mcPort = mcServer.address().port;
const MC_URL = `http://127.0.0.1:${mcPort}/mcp`;
console.log(`[e2e] MCP server on ${MC_URL}, sqlite at ${tmpDbPath}`);

// ─── Spawn the real launcher ─────────────────────────────────────────

const launcherPath = new URL('../mcp-launcher/launcher.mjs', import.meta.url).pathname;
const launcher = spawn('node', [launcherPath], {
  env: {
    ...process.env,
    MC_URL,
    MC_API_TOKEN: process.env.MC_API_TOKEN,
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});

// ─── Stdio RPC driver ────────────────────────────────────────────────

const pending = new Map();
let lineBuf = Buffer.alloc(0);
let nextId = 1;

launcher.stdout.on('data', (chunk) => {
  lineBuf = Buffer.concat([lineBuf, chunk]);
  let idx;
  while ((idx = lineBuf.indexOf('\n')) >= 0) {
    const line = lineBuf.slice(0, idx).toString('utf8');
    lineBuf = lineBuf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    launcher.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`rpc timeout waiting for ${method} (id=${id})`));
      }
    }, 8000);
  });
}

function notify(method, params) {
  launcher.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

// ─── Assertions ──────────────────────────────────────────────────────

const failures = [];
function expect(cond, msg) {
  if (!cond) failures.push(msg);
}

async function callTool(name, args) {
  return await rpc('tools/call', { name, arguments: args });
}

function isError(res) {
  return res.isError === true;
}

function structured(res) {
  return res.structuredContent ?? {};
}

// Give the launcher a beat to finish connecting upstream.
await delay(500);

try {
  // ── 1. handshake ──
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '0' },
  });
  notify('notifications/initialized');
  expect(init.serverInfo?.name === 'sc-mission-control', 'initialize should return our server name');

  // ── 2. tools/list ──
  const list = await rpc('tools/list', {});
  const names = new Set(list.tools.map((t) => t.name));
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
    'spawn_subtask',
    'save_knowledge',
  ]) {
    expect(names.has(t), `tools/list should expose ${t}`);
  }

  // ── 3. whoami for the piloted agent ──
  const whoami = await callTool('whoami', { agent_id: agentId });
  expect(!isError(whoami), 'whoami should succeed');
  const id = structured(whoami);
  expect(id.id === agentId, 'whoami should echo the agent id');
  expect(id.gateway_agent_id === 'mc-builder-e2e', 'whoami should return gateway id');
  expect(
    Array.isArray(id.assigned_task_ids) && id.assigned_task_ids.includes(taskId),
    'whoami should list the assigned task',
  );

  // ── 4. evidence gate rejects premature transition ──
  const premature = await callTool('update_task_status', {
    agent_id: agentId,
    task_id: taskId,
    status: 'review',
  });
  expect(isError(premature), 'evidence gate should reject transition with no deliverable/activity');
  expect(
    structured(premature).error === 'evidence_gate',
    `expected evidence_gate error, got ${JSON.stringify(structured(premature))}`,
  );

  // ── 5. register_deliverable ──
  const deliv = await callTool('register_deliverable', {
    agent_id: agentId,
    task_id: taskId,
    deliverable_type: 'artifact',
    title: 'e2e-deliverable',
  });
  expect(!isError(deliv), 'register_deliverable should succeed for assigned agent');

  // ── 6. log_activity ──
  const act = await callTool('log_activity', {
    agent_id: agentId,
    task_id: taskId,
    activity_type: 'completed',
    message: 'e2e build complete',
  });
  expect(!isError(act), 'log_activity should succeed');

  // ── 7. now update_task_status should succeed ──
  const transition = await callTool('update_task_status', {
    agent_id: agentId,
    task_id: taskId,
    status: 'review',
  });
  expect(!isError(transition), `update_task_status should succeed; got ${JSON.stringify(transition)}`);
  expect(
    structured(transition).task?.status === 'review',
    'task status should be "review" after transition',
  );

  // ── 8. Verify sqlite directly (prove the DB actually changed) ──
  const { queryOne } = await import('../src/lib/db/index.ts');
  const row = queryOne(`SELECT status FROM tasks WHERE id = ?`, [taskId]);
  expect(row?.status === 'review', `DB should show status=review; got ${row?.status}`);

  const deliverableCount = queryOne(
    `SELECT COUNT(*) as cnt FROM task_deliverables WHERE task_id = ?`,
    [taskId],
  );
  expect(deliverableCount?.cnt === 1, 'exactly one deliverable row should exist');

  const activityCount = queryOne(
    `SELECT COUNT(*) as cnt FROM task_activities WHERE task_id = ?`,
    [taskId],
  );
  expect(activityCount?.cnt >= 1, 'at least one activity row should exist');

  // ── 9. Cross-agent authz: outsider cannot act on someone else's task ──
  const denied = await callTool('register_deliverable', {
    agent_id: outsiderId,
    task_id: taskId,
    deliverable_type: 'artifact',
    title: 'should-be-blocked',
  });
  expect(isError(denied), 'outside agent should be blocked by authz');
  expect(
    structured(denied).error === 'authz_denied' && structured(denied).code === 'agent_not_on_task',
    `expected authz_denied/agent_not_on_task; got ${JSON.stringify(structured(denied))}`,
  );

  // ── 10. fetch_mail enforces authz on the agent_id ──
  const bogus = await callTool('fetch_mail', {
    agent_id: '00000000-0000-0000-0000-deadbeef0000',
  });
  expect(isError(bogus), 'fetch_mail for unknown agent should fail');
  expect(
    structured(bogus).error === 'authz_denied',
    'fetch_mail should map AuthzError → authz_denied',
  );

  // ── 11. send_mail happy path ──
  const mail = await callTool('send_mail', {
    agent_id: agentId,
    to_agent_id: recipientId,
    body: 'hi from e2e',
    subject: 'e2e',
  });
  expect(!isError(mail), 'send_mail should succeed');
  expect(
    structured(mail).message?.from_agent_id === agentId,
    'mail should preserve sender id',
  );

  // ── 12. list_peers returns the other agents ──
  const peers = await callTool('list_peers', { agent_id: agentId });
  expect(!isError(peers), 'list_peers should succeed');
  const peerIds = new Set(structured(peers).peers.map((p) => p.id));
  expect(peerIds.has(outsiderId), 'list_peers should include outsider agent');
  expect(peerIds.has(recipientId), 'list_peers should include recipient agent');

  // ── 13. save_knowledge writes a knowledge_entries row ──
  const saved = await callTool('save_knowledge', {
    agent_id: agentId,
    workspace_id: 'default',
    task_id: taskId,
    category: 'pattern',
    title: 'E2E pattern',
    content: 'Learned during the e2e run.',
    tags: ['e2e'],
    confidence: 0.7,
  });
  expect(!isError(saved), `save_knowledge should succeed; got ${JSON.stringify(saved)}`);
  const savedEntry = structured(saved).entry;
  expect(savedEntry?.title === 'E2E pattern', 'save_knowledge should echo the title');
  const knowledgeRow = queryOne(
    `SELECT id, category, title FROM knowledge_entries WHERE id = ?`,
    [savedEntry?.id],
  );
  expect(knowledgeRow?.title === 'E2E pattern', 'knowledge_entries row should exist with the title');

  const deniedKnowledge = await callTool('save_knowledge', {
    agent_id: outsiderId,
    workspace_id: 'default',
    task_id: taskId,
    category: 'pattern',
    title: 'should not land',
    content: 'outsider attempt',
  });
  expect(isError(deniedKnowledge), 'save_knowledge should reject off-task outsider');
  expect(
    structured(deniedKnowledge).error === 'authz_denied',
    `expected authz_denied; got ${JSON.stringify(structured(deniedKnowledge))}`,
  );
} finally {
  launcher.kill('SIGTERM');
  await new Promise((r) => launcher.once('close', r));
  await new Promise((r) => mcServer.close(r));
  try {
    const { closeDb } = await import('../src/lib/db/index.ts');
    closeDb();
  } catch {}
  for (const suffix of ['', '-shm', '-wal']) {
    const p = tmpDbPath + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

if (failures.length) {
  console.error('\n[e2e] FAILED:');
  for (const f of failures) console.error('  -', f);
  process.exit(1);
}
console.log('[e2e] OK — full flow validated (handshake → tools/list → whoami → evidence gate → register → log → transition → authz → send_mail → list_peers → save_knowledge)');
