/**
 * GET /api/initiatives/:id/pm-chat — direct + note-bridged anchor cases.
 * See docs/proposals/pm-chat-context-strip.md §"Test plan".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { run, queryOne } from '@/lib/db';
import { createNote } from '@/lib/db/agent-notes';
import { ensurePmAgent } from '@/lib/bootstrap-agents';
import { postPmChatMessage } from '@/lib/agents/pm-dispatch';

function freshWorkspace(): string {
  const id = `ws-pmchat-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function freshInitiative(workspaceId: string): string {
  const id = `init-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO initiatives (id, workspace_id, title, status, kind, created_at, updated_at)
     VALUES (?, ?, ?, 'planned', 'epic', datetime('now'), datetime('now'))`,
    [id, workspaceId, `seed ${id}`],
  );
  return id;
}

function call(initId: string, query?: Record<string, string>) {
  const qs = new URLSearchParams(query ?? {});
  const url = new URL(
    `http://localhost/api/initiatives/${initId}/pm-chat${qs.toString() ? '?' + qs : ''}`,
  );
  return GET(
    new NextRequest(url, { method: 'GET' }),
    { params: Promise.resolve({ id: initId }) },
  );
}

test('GET: missing initiative → 404', async () => {
  const res = await call('does-not-exist');
  assert.equal(res.status, 404);
});

test('GET: direct target_initiative_id anchor matches', async () => {
  const ws = freshWorkspace();
  const init = freshInitiative(ws);
  ensurePmAgent(ws);

  postPmChatMessage({
    workspace_id: ws,
    content: 'a direct anchor',
    role: 'assistant',
    context: {
      trigger_kind: 'plan_initiative',
      target_initiative_id: init,
      origin: 'pm_dispatch',
    },
  });

  const res = await call(init);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { messages: Array<{ content: string }> };
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].content, 'a direct anchor');
});

test('GET: note-bridged anchor matches via source_note_ids', async () => {
  const ws = freshWorkspace();
  const init = freshInitiative(ws);
  ensurePmAgent(ws);
  const note = createNote({
    workspace_id: ws,
    agent_id: null,
    initiative_id: init,
    scope_key: `scope-${uuidv4()}`,
    role: 'researcher',
    run_group_id: `rg-${uuidv4()}`,
    kind: 'observation',
    body: 'audit observation',
  });

  postPmChatMessage({
    workspace_id: ws,
    content: 'note-bridged',
    role: 'user',
    context: {
      trigger_kind: 'notes_intake',
      source_note_ids: [note.id],
      // Deliberately omit target_initiative_id — the bridge should
      // still link through the note's initiative.
      origin: 'ask_pm_from_notes',
    },
  });

  const res = await call(init);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { messages: Array<{ content: string }> };
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].content, 'note-bridged');
});

test('GET: only PM-agent rows are returned, not worker rows with same metadata', async () => {
  const ws = freshWorkspace();
  const init = freshInitiative(ws);
  ensurePmAgent(ws);
  // Seed a worker agent and insert a chat row directly with the same
  // metadata. The endpoint should ignore it — the rail only cares
  // about the workspace's PM conversation.
  const workerId = `worker-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_active, created_at, updated_at)
     VALUES (?, 'WorkerA', 'worker', ?, 1, datetime('now'), datetime('now'))`,
    [workerId, ws],
  );
  run(
    `INSERT INTO agent_chat_messages (id, agent_id, role, content, status, metadata)
     VALUES (?, ?, 'assistant', 'worker chatter', 'delivered', ?)`,
    [
      uuidv4(),
      workerId,
      JSON.stringify({ target_initiative_id: init, trigger_kind: 'manual' }),
    ],
  );
  // And a real PM-agent row.
  postPmChatMessage({
    workspace_id: ws,
    content: 'pm row',
    role: 'assistant',
    context: { target_initiative_id: init, origin: 'pm_dispatch', trigger_kind: 'manual' },
  });

  const res = await call(init);
  const body = (await res.json()) as { messages: Array<{ content: string }> };
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].content, 'pm row');
});

test('GET: limit clamps result count and orders newest-first', async () => {
  const ws = freshWorkspace();
  const init = freshInitiative(ws);
  ensurePmAgent(ws);

  for (let i = 0; i < 5; i++) {
    postPmChatMessage({
      workspace_id: ws,
      content: `row ${i}`,
      role: 'assistant',
      context: { target_initiative_id: init, origin: 'pm_dispatch', trigger_kind: 'manual' },
    });
    // Bump created_at so ordering is deterministic.
    run(
      `UPDATE agent_chat_messages SET created_at = datetime('now', '+' || ? || ' seconds')
        WHERE content = ? AND agent_id IN (SELECT id FROM agents WHERE workspace_id = ? AND role = 'pm')`,
      [i, `row ${i}`, ws],
    );
  }

  const res = await call(init, { limit: '3' });
  const body = (await res.json()) as { messages: Array<{ content: string }> };
  assert.equal(body.messages.length, 3);
  assert.equal(body.messages[0].content, 'row 4'); // newest first
  assert.equal(body.messages[2].content, 'row 2');
});

test('GET: ignores agent_chat_messages on initiatives in other workspaces', async () => {
  const wsA = freshWorkspace();
  const wsB = freshWorkspace();
  const initB = freshInitiative(wsB);
  ensurePmAgent(wsA);
  ensurePmAgent(wsB);

  // Workspace A's PM posts a row anchored to wsB's initiative id —
  // this is a malformed input shape (target_initiative_id from another
  // workspace) and the endpoint should drop it on the workspace gate.
  postPmChatMessage({
    workspace_id: wsA,
    content: 'cross-workspace anchor',
    role: 'assistant',
    context: { target_initiative_id: initB, origin: 'pm_dispatch', trigger_kind: 'manual' },
  });

  const res = await call(initB);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { messages: Array<{ content: string }> };
  // initB belongs to wsB; query joins agents on wsB's PM. wsA row excluded.
  assert.equal(body.messages.length, 0);
  // Sanity: wsA can see its own row when asked about an initiative in wsA.
  const initA = freshInitiative(wsA);
  // Re-post with the correct anchor for the sanity check.
  postPmChatMessage({
    workspace_id: wsA,
    content: 'within-workspace anchor',
    role: 'assistant',
    context: { target_initiative_id: initA, origin: 'pm_dispatch', trigger_kind: 'manual' },
  });
  const resA = await call(initA);
  const bodyA = (await resA.json()) as { messages: Array<{ content: string }> };
  assert.equal(bodyA.messages.length, 1);
  assert.ok(queryOne(`SELECT 1 FROM agents WHERE workspace_id = ?`, [wsA]));
});
