/**
 * MCP server integration tests.
 *
 * Uses the SDK's InMemoryTransport pair to exercise the full tool stack
 * end-to-end against a real sqlite tmpfile. Covers: tool listing, read-only
 * tools, state-changing tools (happy path + authz violation), evidence-gate
 * integration with update_task_status.
 *
 * The `delegate` tool is skipped here — it calls openclaw's WebSocket
 * gateway for sessions.send, which can't be mocked cleanly in this harness.
 * A pilot-environment smoke will exercise it live.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { run } from '@/lib/db';
import { buildServer } from './server';

async function makePair() {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0.0.1' });
  await client.connect(clientT);
  return { client, server };
}

function seedAgent(opts: { id?: string; role?: string; workspace?: string; gateway?: string } = {}): string {
  const id = opts.id ?? crypto.randomUUID();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_active, gateway_agent_id, created_at, updated_at)
     VALUES (?, 'A', ?, ?, 1, ?, datetime('now'), datetime('now'))`,
    [id, opts.role ?? 'builder', opts.workspace ?? 'default', opts.gateway ?? null],
  );
  return id;
}

function seedTask(opts: { id?: string; assigned?: string; status?: string; workspace?: string } = {}): string {
  const id = opts.id ?? crypto.randomUUID();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at)
     VALUES (?, 'T', ?, 'normal', ?, 'default', ?, datetime('now'), datetime('now'))`,
    [id, opts.status ?? 'in_progress', opts.workspace ?? 'default', opts.assigned ?? null],
  );
  return id;
}

// The SDK returns a union of CallToolResult shapes (the modern
// `structuredContent` variant and a legacy `toolResult` variant). Both
// branches have `structuredContent` at runtime for our server since we
// always populate it. Cast to unknown to shed the union before indexing.
function parseStructured<T = unknown>(result: unknown): T {
  return (result as { structuredContent?: unknown }).structuredContent as T;
}

// ─── listing ────────────────────────────────────────────────────────

test('tools/list returns the full sc-mission-control tool surface', async () => {
  const { client } = await makePair();
  const list = await client.listTools();
  const names = new Set(list.tools.map((t) => t.name));
  for (const expected of [
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
    assert.ok(names.has(expected), `missing tool: ${expected}`);
  }
});

// ─── whoami ─────────────────────────────────────────────────────────

test('whoami returns identity, assigned tasks, and peer roster', async () => {
  const { client } = await makePair();
  const me = seedAgent({ role: 'builder', gateway: 'mc-builder-test' });
  seedAgent({ role: 'tester', gateway: 'mc-tester-test' });
  const task = seedTask({ assigned: me, status: 'in_progress' });

  const res = await client.callTool({ name: 'whoami', arguments: { agent_id: me } });
  assert.equal(res.isError, undefined);
  const payload = parseStructured<{ assigned_task_ids: string[]; peers: Record<string, unknown> }>(res);
  assert.ok(payload.assigned_task_ids.includes(task), 'should list the assigned task');
  assert.ok(
    Object.keys(payload.peers).includes('mc-tester-test'),
    'should list the tester peer by gateway id',
  );
});

test('whoami returns an error for an unknown agent_id', async () => {
  const { client } = await makePair();
  const res = await client.callTool({
    name: 'whoami',
    arguments: { agent_id: crypto.randomUUID() },
  });
  assert.equal(res.isError, true);
});

// ─── register_deliverable ───────────────────────────────────────────

test('register_deliverable happy path for assigned agent', async () => {
  const { client } = await makePair();
  const me = seedAgent();
  const task = seedTask({ assigned: me });

  const res = await client.callTool({
    name: 'register_deliverable',
    arguments: {
      agent_id: me,
      task_id: task,
      deliverable_type: 'artifact',
      title: 'thing',
    },
  });
  assert.equal(res.isError, undefined);
  const payload = parseStructured<{ deliverable: { task_id: string; title: string } }>(res);
  assert.equal(payload.deliverable.task_id, task);
  assert.equal(payload.deliverable.title, 'thing');
});

test('register_deliverable returns authz_denied for outside agent', async () => {
  const { client } = await makePair();
  const outsider = seedAgent();
  const task = seedTask();

  const res = await client.callTool({
    name: 'register_deliverable',
    arguments: {
      agent_id: outsider,
      task_id: task,
      deliverable_type: 'artifact',
      title: 'nope',
    },
  });
  assert.equal(res.isError, true);
  const payload = parseStructured<{ error: string; code: string }>(res);
  assert.equal(payload.error, 'authz_denied');
  assert.equal(payload.code, 'agent_not_on_task');
});

// ─── log_activity ───────────────────────────────────────────────────

test('log_activity records a row for an on-task agent', async () => {
  const { client } = await makePair();
  const me = seedAgent();
  const task = seedTask({ assigned: me });

  const res = await client.callTool({
    name: 'log_activity',
    arguments: {
      agent_id: me,
      task_id: task,
      activity_type: 'completed',
      message: 'done',
    },
  });
  assert.equal(res.isError, undefined);
});

// ─── update_task_status ─────────────────────────────────────────────

test('update_task_status rejects with evidence_gate when no deliverable/activity exists', async () => {
  const { client } = await makePair();
  const me = seedAgent();
  const task = seedTask({ assigned: me, status: 'in_progress' });

  const res = await client.callTool({
    name: 'update_task_status',
    arguments: { agent_id: me, task_id: task, status: 'review' },
  });
  assert.equal(res.isError, true);
  const payload = parseStructured<{ error: string }>(res);
  assert.equal(payload.error, 'evidence_gate');
});

test('update_task_status succeeds after deliverable + activity are logged', async () => {
  const { client } = await makePair();
  const me = seedAgent();
  const task = seedTask({ assigned: me, status: 'in_progress' });

  await client.callTool({
    name: 'register_deliverable',
    arguments: {
      agent_id: me,
      task_id: task,
      deliverable_type: 'artifact',
      title: 'x',
    },
  });
  await client.callTool({
    name: 'log_activity',
    arguments: {
      agent_id: me,
      task_id: task,
      activity_type: 'completed',
      message: 'built',
    },
  });

  const res = await client.callTool({
    name: 'update_task_status',
    arguments: { agent_id: me, task_id: task, status: 'review' },
  });
  assert.equal(res.isError, undefined);
  const payload = parseStructured<{ task: { status: string }; previous_status: string }>(res);
  assert.equal(payload.task.status, 'review');
  assert.equal(payload.previous_status, 'in_progress');
});

// ─── send_mail ──────────────────────────────────────────────────────

test('send_mail happy path writes and matches sender + recipient', async () => {
  const { client } = await makePair();
  const sender = seedAgent();
  const recipient = seedAgent();

  const res = await client.callTool({
    name: 'send_mail',
    arguments: {
      agent_id: sender,
      to_agent_id: recipient,
      body: 'hi',
      subject: 'hello',
    },
  });
  assert.equal(res.isError, undefined);
  const payload = parseStructured<{ message: { from_agent_id: string; to_agent_id: string } }>(res);
  assert.equal(payload.message.from_agent_id, sender);
  assert.equal(payload.message.to_agent_id, recipient);
});

test('send_mail with task_id rejects an off-task sender', async () => {
  const { client } = await makePair();
  const outsider = seedAgent();
  const recipient = seedAgent();
  const task = seedTask();

  const res = await client.callTool({
    name: 'send_mail',
    arguments: {
      agent_id: outsider,
      to_agent_id: recipient,
      body: 'hi',
      task_id: task,
    },
  });
  assert.equal(res.isError, true);
  const payload = parseStructured<{ error: string; code: string }>(res);
  assert.equal(payload.error, 'authz_denied');
});
