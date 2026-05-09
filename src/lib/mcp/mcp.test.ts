/**
 * MCP server integration tests.
 *
 * Uses the SDK's InMemoryTransport pair to exercise the full tool stack
 * end-to-end against a real sqlite tmpfile. Covers: tool listing, read-only
 * tools, state-changing tools (happy path + authz violation), evidence-gate
 * integration with update_task_status.
 *
 * The coordinator-delegation tools (`spawn_subtask`, `update_subtask`) that
 * call openclaw's WebSocket gateway are not exercised end-to-end here —
 * the gateway client can't be mocked cleanly in this harness. A pilot-
 * environment smoke exercises the live flow.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { run, queryOne } from '@/lib/db';
import { buildServer } from './server';
import { createInitiative } from '@/lib/db/initiatives';

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
    'save_knowledge',
    'request_knowledge',
    // Coordinator delegation surface (replaces the old `delegate` tool).
    // See specs/coordinator-delegation-via-convoy-spec.md §3.
    'spawn_subtask',
    'list_my_subtasks',
    'update_subtask',
  ]) {
    assert.ok(names.has(expected), `missing tool: ${expected}`);
  }
  assert.ok(!names.has('delegate'), 'delegate tool should be removed');
  // The pre-PR4 trio collapsed into update_subtask — none of the old
  // names should remain.
  for (const removed of ['accept_subtask', 'reject_subtask', 'cancel_subtask']) {
    assert.ok(!names.has(removed), `${removed} should be removed (consolidated into update_subtask)`);
  }
});

// ─── per-group routing ──────────────────────────────────────────────

async function listToolsForGroups(groups: Parameters<typeof buildServer>[0]) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const s = buildServer(groups);
  await s.connect(serverT);
  const c = new Client({ name: 'test', version: '0.0.1' });
  await c.connect(clientT);
  const list = await c.listTools();
  return new Set(list.tools.map((t) => t.name));
}

test('PM-scoped server (core+read+pm) excludes worker + crud tools', async () => {
  const names = await listToolsForGroups(['core', 'read', 'pm']);

  // Core present
  for (const t of ['whoami', 'list_peers', 'log_activity', 'take_note', 'read_notes']) {
    assert.ok(names.has(t), `expected core tool ${t}`);
  }
  // Read present
  for (const t of ['list_initiatives', 'get_initiative_tree', 'get_roadmap_snapshot', 'list_proposals']) {
    assert.ok(names.has(t), `expected read tool ${t}`);
  }
  // PM present
  for (const t of ['propose_changes', 'propose_from_notes', 'refine_proposal', 'preview_derivation', 'add_owner_availability']) {
    assert.ok(names.has(t), `expected pm tool ${t}`);
  }
  // Worker absent
  for (const t of ['register_deliverable', 'submit_evidence', 'update_task_status', 'fail_task',
                   'spawn_subtask', 'update_subtask',
                   'register_subagent_dispatch', 'update_note']) {
    assert.ok(!names.has(t), `pm mount must not expose worker tool ${t}`);
  }
  // The pre-PR5 note lifecycle pair collapsed into update_note —
  // neither old name should appear anywhere.
  for (const removed of ['mark_note_consumed', 'archive_note']) {
    assert.ok(!names.has(removed), `${removed} should be removed (consolidated into update_note)`);
  }
  // CRUD absent
  for (const t of ['create_initiative', 'update_initiative', 'move_initiative', 'convert_initiative']) {
    assert.ok(!names.has(t), `pm mount must not expose crud tool ${t}`);
  }
});

test('CRUD-scoped server (core+read+crud) excludes worker + pm tools', async () => {
  const names = await listToolsForGroups(['core', 'read', 'crud']);

  // CRUD present
  for (const t of ['create_initiative', 'update_initiative', 'move_initiative', 'convert_initiative',
                   'add_initiative_dependency', 'remove_initiative_dependency',
                   'move_task_to_initiative', 'promote_initiative_to_task', 'promote_task_to_inbox']) {
    assert.ok(names.has(t), `expected crud tool ${t}`);
  }
  // PM absent
  for (const t of ['propose_changes', 'propose_from_notes', 'refine_proposal']) {
    assert.ok(!names.has(t), `crud mount must not expose pm tool ${t}`);
  }
  // Worker absent
  for (const t of ['register_deliverable', 'spawn_subtask']) {
    assert.ok(!names.has(t), `crud mount must not expose worker tool ${t}`);
  }
});

test('default server (no groups arg) keeps full union of 45 tools', async () => {
  const names = await listToolsForGroups(undefined);
  // 45 tools after slice-4 of initiative-research-loop adds read_brief.
  // 44 tools post-PR4+PR5: accept/reject/cancel_subtask → update_subtask
  // and mark_note_consumed/archive_note → update_note (47 - 3 + 1 - 2 + 1).
  assert.equal(names.size, 45, `expected 45 tools, got ${names.size}: ${[...names].sort().join(', ')}`);
  assert.ok(names.has('read_brief'), 'read_brief should be present');
  // Make absences explicit so a regression has a clear failure.
  for (const removed of ['accept_subtask', 'reject_subtask', 'cancel_subtask', 'mark_note_consumed', 'archive_note']) {
    assert.ok(!names.has(removed), `${removed} should not be present`);
  }
  for (const present of ['update_subtask', 'update_note']) {
    assert.ok(names.has(present), `${present} should be present`);
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

test('whoami resolves identity by gateway_agent_id (bootstrap path)', async () => {
  const { client } = await makePair();
  const gw = `mc-bootstrap-${crypto.randomUUID().slice(0, 8)}`;
  const me = seedAgent({ role: 'builder', gateway: gw });
  const task = seedTask({ assigned: me, status: 'in_progress' });

  const res = await client.callTool({
    name: 'whoami',
    arguments: { agent_id: gw },
  });
  assert.equal(res.isError, undefined);
  const payload = parseStructured<{
    id: string;
    gateway_agent_id: string;
    assigned_task_ids: string[];
    peers: Record<string, unknown>;
  }>(res);
  assert.equal(payload.id, me, 'returns the MC agent_id, not the gateway id');
  assert.equal(payload.gateway_agent_id, gw);
  assert.ok(payload.assigned_task_ids.includes(task), 'tasks resolved via me.id');
  assert.ok(
    !Object.keys(payload.peers).includes(gw),
    'caller should not appear in their own peer list',
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

// ─── save_knowledge ─────────────────────────────────────────────────

test('save_knowledge happy path writes an entry for a learner agent', async () => {
  const { client } = await makePair();
  const learner = seedAgent({ role: 'learner' });
  const task = seedTask({ assigned: learner });

  const res = await client.callTool({
    name: 'save_knowledge',
    arguments: {
      agent_id: learner,
      workspace_id: 'default',
      task_id: task,
      category: 'failure',
      title: 'Build failed due to missing import',
      content: 'The builder forgot to import foo.',
      tags: ['build', 'imports'],
      confidence: 0.85,
    },
  });
  assert.equal(res.isError, undefined);
  const payload = parseStructured<{
    entry: {
      task_id: string;
      category: string;
      title: string;
      tags: string[];
      confidence: number;
      created_by_agent_id: string;
    };
  }>(res);
  assert.equal(payload.entry.task_id, task);
  assert.equal(payload.entry.category, 'failure');
  assert.equal(payload.entry.created_by_agent_id, learner);
  assert.deepEqual(payload.entry.tags, ['build', 'imports']);
  assert.equal(payload.entry.confidence, 0.85);
});

test('save_knowledge returns authz_denied when agent is not on the task', async () => {
  const { client } = await makePair();
  const outsider = seedAgent({ role: 'learner' });
  const task = seedTask();

  const res = await client.callTool({
    name: 'save_knowledge',
    arguments: {
      agent_id: outsider,
      workspace_id: 'default',
      task_id: task,
      category: 'pattern',
      title: 'nope',
      content: 'should not land',
    },
  });
  assert.equal(res.isError, true);
  const payload = parseStructured<{ error: string; code: string }>(res);
  assert.equal(payload.error, 'authz_denied');
  assert.equal(payload.code, 'agent_not_on_task');
});

test('save_knowledge workspace-only (no task_id) requires only active agent', async () => {
  const { client } = await makePair();
  const learner = seedAgent({ role: 'learner' });

  const res = await client.callTool({
    name: 'save_knowledge',
    arguments: {
      agent_id: learner,
      workspace_id: 'default',
      category: 'pattern',
      title: 'General pattern',
      content: 'Use dependency injection for db handles.',
    },
  });
  assert.equal(res.isError, undefined);
  const payload = parseStructured<{ entry: { task_id?: string; confidence: number } }>(res);
  assert.equal(payload.entry.task_id, undefined);
  assert.equal(payload.entry.confidence, 0.5);
});

// ─── request_knowledge ──────────────────────────────────────────────

test('request_knowledge returns none=true when no entries match', async () => {
  const { client } = await makePair();
  const agent = seedAgent({ role: 'builder' });

  const res = await client.callTool({
    name: 'request_knowledge',
    arguments: { agent_id: agent, workspace_id: 'default', query: 'nothing like this exists' },
  });
  assert.equal(res.isError, undefined);
  const payload = parseStructured<{ matches: unknown[]; none: boolean }>(res);
  assert.equal(payload.none, true);
  assert.equal(payload.matches.length, 0);
});

test('request_knowledge scores title/tag/content hits and filters unrelated entries', async () => {
  const { client } = await makePair();
  const learner = seedAgent({ role: 'learner' });
  const builder = seedAgent({ role: 'builder' });

  // Seed two unrelated + one relevant entry.
  for (const payload of [
    { category: 'pattern', title: 'Foreign entity registration tripwire', content: 'NY requires filing.', tags: ['legal'] },
    { category: 'fix', title: 'PEO beats EOR for small teams', content: 'Justworks is cheaper.', tags: ['hr'] },
    { category: 'checklist', title: 'Docker compose caching tips', content: 'Use BuildKit layer cache for docker images.', tags: ['docker', 'build'] },
  ]) {
    const r = await client.callTool({
      name: 'save_knowledge',
      arguments: { agent_id: learner, workspace_id: 'default', ...payload },
    });
    assert.equal(r.isError, undefined);
  }

  const res = await client.callTool({
    name: 'request_knowledge',
    arguments: { agent_id: builder, workspace_id: 'default', query: 'docker caching for builds' },
  });
  assert.equal(res.isError, undefined);
  const payload = parseStructured<{ matches: { title: string }[]; none: boolean }>(res);
  assert.equal(payload.none, false);
  assert.equal(payload.matches[0].title, 'Docker compose caching tips');
  // Unrelated "Foreign entity" / "PEO" entries should not leak in — the
  // exact regression the old auto-injector produced.
  assert.ok(!payload.matches.some(m => /foreign entity|PEO/i.test(m.title)));
});

// ─── propose_changes (PM) ───────────────────────────────────────────

test('propose_changes accepts decompose_initiative trigger + create_child_initiative diffs', async () => {
  const { client } = await makePair();
  const ws = `ws-${crypto.randomUUID().slice(0, 8)}`;
  run(
    `INSERT INTO workspaces (id, name, slug, icon) VALUES (?, ?, ?, '🧪')`,
    [ws, ws, ws],
  );
  const me = seedAgent({ workspace: ws, role: 'pm' });
  const parent = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Parent epic' });

  const res = await client.callTool({
    name: 'propose_changes',
    arguments: {
      agent_id: me,
      workspace_id: ws,
      trigger_text: 'decompose this epic into child stories',
      trigger_kind: 'decompose_initiative',
      impact_md: '- splits parent into 2 sequential children',
      changes: [
        {
          kind: 'create_child_initiative',
          parent_initiative_id: parent.id,
          title: 'Foundation',
          description: 'Foundation work',
          child_kind: 'story',
          complexity: 'M',
          placeholder_id: '$0',
        },
        {
          kind: 'create_child_initiative',
          parent_initiative_id: parent.id,
          title: 'Build on top',
          child_kind: 'story',
          complexity: 'M',
          depends_on_initiative_ids: ['$0'],
        },
      ],
    },
  });
  assert.equal(res.isError, undefined, 'schema must accept the documented PM decompose payload');
  const proposal = parseStructured<{ id: string; trigger_kind: string; status: string; proposed_changes: unknown[] }>(res);
  assert.equal(proposal.trigger_kind, 'decompose_initiative');
  assert.equal(proposal.status, 'draft', 'apply happens at accept time, not at propose time');
  assert.equal(proposal.proposed_changes.length, 2);
  // Defence-in-depth: row is actually persisted with the right trigger_kind.
  const row = queryOne<{ status: string; trigger_kind: string }>(
    'SELECT status, trigger_kind FROM pm_proposals WHERE id = ?',
    [proposal.id],
  );
  assert.equal(row?.status, 'draft');
  assert.equal(row?.trigger_kind, 'decompose_initiative');
});

test('propose_changes rejects an unknown diff kind', async () => {
  const { client } = await makePair();
  const ws = `ws-${crypto.randomUUID().slice(0, 8)}`;
  run(
    `INSERT INTO workspaces (id, name, slug, icon) VALUES (?, ?, ?, '🧪')`,
    [ws, ws, ws],
  );
  const me = seedAgent({ workspace: ws, role: 'pm' });

  // The discriminated union should reject "nope" as a diff kind. Depending on
  // the SDK transport, that surfaces either as a JSON-RPC rejection or as
  // `isError: true` — accept either, just not silent success.
  let rejected = false;
  let isError = false;
  try {
    const res = await client.callTool({
      name: 'propose_changes',
      arguments: {
        agent_id: me,
        workspace_id: ws,
        trigger_text: 'bad',
        trigger_kind: 'manual',
        impact_md: '-',
        changes: [{ kind: 'nope', initiative_id: 'x' }],
      },
    });
    isError = res.isError === true;
  } catch {
    rejected = true;
  }
  assert.ok(rejected || isError, 'unknown diff kind must not silently pass schema validation');
});

// ─── take_note: cancelled-run guard ─────────────────────────────────
//
// Regression: a worker whose agent_runs row was already cancelled used
// to be able to keep calling take_note (the openclaw worker isn't
// actually killed when status flips to 'cancelled'). That left orphan
// observation notes — see specs/dedupe-investigations.md and the
// May 7 duplicate-audit incident.

test('take_note refuses to write when the owning run is cancelled', async () => {
  // Avoid a circular import at module top; pull from the DAO at call time.
  const { startAgentRun, cancelAgentRun } = await import('@/lib/db/agent-runs');
  const { client } = await makePair();
  const me = seedAgent();
  const groupId = crypto.randomUUID();
  const runId = startAgentRun({
    workspace_id: 'default',
    kind: 'initiative_audit',
    scope_key: 'agent:researcher:cancel-test',
    scope_type: 'initiative_audit',
    role: 'researcher',
    agent_id: me,
    run_group_id: groupId,
  });
  cancelAgentRun(runId);

  const before = (queryOne<{ n: number }>('SELECT COUNT(*) as n FROM agent_notes')?.n) ?? 0;

  const res = await client.callTool({
    name: 'take_note',
    arguments: {
      agent_id: me,
      kind: 'observation',
      body: 'should not land',
      scope_key: 'agent:researcher:cancel-test',
      role: 'researcher',
      run_group_id: groupId,
    },
  });

  assert.equal(res.isError, true, 'take_note must error');
  const payload = parseStructured<{ error: string }>(res);
  assert.equal(payload.error, 'run_cancelled');

  const after = (queryOne<{ n: number }>('SELECT COUNT(*) as n FROM agent_notes')?.n) ?? 0;
  assert.equal(after, before, 'agent_notes row count unchanged');
});

test('take_note succeeds when the owning run is still running', async () => {
  const { startAgentRun } = await import('@/lib/db/agent-runs');
  const { client } = await makePair();
  const me = seedAgent();
  const groupId = crypto.randomUUID();
  startAgentRun({
    workspace_id: 'default',
    kind: 'initiative_audit',
    scope_key: 'agent:researcher:running-test',
    scope_type: 'initiative_audit',
    role: 'researcher',
    agent_id: me,
    run_group_id: groupId,
  });

  const res = await client.callTool({
    name: 'take_note',
    arguments: {
      agent_id: me,
      kind: 'observation',
      body: 'live note',
      scope_key: 'agent:researcher:running-test',
      role: 'researcher',
      run_group_id: groupId,
    },
  });
  assert.equal(res.isError, undefined);
});

test('take_note fails open when run_group_id is unknown (legacy / brief dispatch)', async () => {
  const { client } = await makePair();
  const me = seedAgent();
  const res = await client.callTool({
    name: 'take_note',
    arguments: {
      agent_id: me,
      kind: 'observation',
      body: 'no run row exists for this group',
      scope_key: 'agent:legacy:scope',
      role: 'builder',
      run_group_id: crypto.randomUUID(),
    },
  });
  assert.equal(res.isError, undefined);
});

// ─── take_note: audit-kind body validation ──────────────────────────
//
// Phase 1 of specs/subtree-audit-proposals-spec.md adds three new note
// kinds (audit_manifest, audit_proposal, audit_synthesis) whose bodies
// must JSON-parse and conform to a Zod schema. Validation runs in the
// MCP handler so auditor agents get structured feedback in the same
// dispatch and can recover.

test('take_note rejects audit_proposal with malformed body and returns structured error', async () => {
  const { client } = await makePair();
  const me = seedAgent();
  const res = await client.callTool({
    name: 'take_note',
    arguments: {
      agent_id: me,
      // Missing required fields (proposed_action, repo_evidence, …).
      kind: 'audit_proposal',
      body: JSON.stringify({ version: 1, node_initiative_id: 'n', current_mc_status: 'done' }),
      scope_key: 'agent:auditor:scope',
      role: 'auditor',
      run_group_id: crypto.randomUUID(),
    },
  });
  assert.equal(res.isError, true, 'malformed audit_proposal body must error');
  const payload = parseStructured<{ error: string; message: string; kind: string }>(res);
  assert.equal(payload.error, 'audit_body_invalid');
  assert.equal(payload.kind, 'audit_proposal');
  assert.match(payload.message, /audit_proposal/);
});

test('take_note rejects audit_manifest with non-JSON body', async () => {
  const { client } = await makePair();
  const me = seedAgent();
  const res = await client.callTool({
    name: 'take_note',
    arguments: {
      agent_id: me,
      kind: 'audit_manifest',
      body: 'not even close to JSON',
      scope_key: 'agent:auditor:scope',
      role: 'auditor',
      run_group_id: crypto.randomUUID(),
    },
  });
  assert.equal(res.isError, true);
  const payload = parseStructured<{ error: string; message: string }>(res);
  assert.equal(payload.error, 'audit_body_invalid');
  assert.match(payload.message, /JSON\.parse/);
});

test('take_note rejects audit body that exceeds the orchestrator pre-cap budget', async () => {
  const { client } = await makePair();
  const me = seedAgent();
  // 2950 chars — under the DB cap (3000) but over the audit pre-cap (2900).
  const oversized = 'x'.repeat(2950);
  const res = await client.callTool({
    name: 'take_note',
    arguments: {
      agent_id: me,
      kind: 'audit_synthesis',
      body: oversized,
      scope_key: 'agent:auditor:scope',
      role: 'auditor',
      run_group_id: crypto.randomUUID(),
    },
  });
  assert.equal(res.isError, true);
  const payload = parseStructured<{ error: string; message: string; limit: number }>(res);
  assert.equal(payload.error, 'audit_body_too_large');
  assert.equal(payload.limit, 2900);
  assert.match(payload.message, /Tighten the rationale/);
});

test('take_note accepts a schema-conformant audit_proposal body', async () => {
  const { client } = await makePair();
  const me = seedAgent();
  const validBody = {
    version: 1,
    node_initiative_id: 'init-x',
    current_mc_status: 'done',
    current_mc_target_end: null,
    proposed_action: 'keep',
    proposed_changes: {},
    repo_evidence: [{ kind: 'file', ref: 'src/x.ts:1' }],
    rationale: 'No drift detected.',
    confidence: 'high',
    would_confirm_by: null,
    continuation_note_id: null,
  };
  const res = await client.callTool({
    name: 'take_note',
    arguments: {
      agent_id: me,
      kind: 'audit_proposal',
      body: JSON.stringify(validBody),
      scope_key: 'agent:auditor:scope',
      role: 'auditor',
      run_group_id: crypto.randomUUID(),
    },
  });
  assert.equal(res.isError, undefined, JSON.stringify(res));
});

test('take_note leaves non-audit kinds untouched (no JSON requirement on observation)', async () => {
  const { client } = await makePair();
  const me = seedAgent();
  const res = await client.callTool({
    name: 'take_note',
    arguments: {
      agent_id: me,
      kind: 'observation',
      body: 'a perfectly normal prose observation',
      scope_key: 'agent:researcher:scope',
      role: 'researcher',
      run_group_id: crypto.randomUUID(),
    },
  });
  assert.equal(res.isError, undefined);
});
