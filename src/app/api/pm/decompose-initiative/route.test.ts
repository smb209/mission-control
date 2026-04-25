/**
 * POST /api/pm/decompose-initiative route test (Polish B).
 *
 * Verifies the wrapper requires initiative_id, only accepts epic/milestone
 * parents, returns a draft proposal, and that accepting that proposal
 * actually creates the children with audit rows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { POST as acceptPOST } from '../proposals/[id]/accept/route';
import { run } from '@/lib/db';
import { ensurePmAgent } from '@/lib/bootstrap-agents';
import { createInitiative } from '@/lib/db/initiatives';
import { queryAll } from '@/lib/db';

function freshWorkspace(): string {
  const id = `ws-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  ensurePmAgent(id);
  return id;
}

function postJson(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST /api/pm/decompose-initiative: missing initiative_id → 400', async () => {
  const res = await POST(postJson('/api/pm/decompose-initiative', {}));
  assert.equal(res.status, 400);
});

test('POST /api/pm/decompose-initiative: rejects story-kind parent', async () => {
  const ws = freshWorkspace();
  const story = createInitiative({ workspace_id: ws, kind: 'story', title: 'A story' });
  const res = await POST(
    postJson('/api/pm/decompose-initiative', { initiative_id: story.id }),
  );
  assert.equal(res.status, 400);
});

test('POST /api/pm/decompose-initiative: returns draft proposal for an epic', async () => {
  const ws = freshWorkspace();
  const epic = createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Build something',
  });

  const res = await POST(
    postJson('/api/pm/decompose-initiative', { initiative_id: epic.id }),
  );
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.ok(data.proposal);
  assert.equal(data.proposal.trigger_kind, 'decompose_initiative');
  assert.equal(data.proposal.status, 'draft');
  assert.ok(Array.isArray(data.proposal.proposed_changes));
  assert.ok(data.proposal.proposed_changes.length >= 3);
  for (const c of data.proposal.proposed_changes) {
    assert.equal(c.kind, 'create_child_initiative');
    assert.equal(c.parent_initiative_id, epic.id);
  }
});

test('POST /api/pm/decompose-initiative + accept: children are created', async () => {
  const ws = freshWorkspace();
  const epic = createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Build feature X',
  });

  const decRes = await POST(
    postJson('/api/pm/decompose-initiative', { initiative_id: epic.id }),
  );
  const decData = await decRes.json();
  const proposalId = decData.proposal.id;

  const acceptRes = await acceptPOST(
    postJson(`/api/pm/proposals/${proposalId}/accept`, {}),
    { params: Promise.resolve({ id: proposalId }) },
  );
  assert.equal(acceptRes.status, 200);
  const acceptData = await acceptRes.json();
  assert.ok(acceptData.changes_applied >= 3);

  // Children inserted.
  const children = queryAll<{ id: string; title: string }>(
    `SELECT id, title FROM initiatives WHERE parent_initiative_id = ?`,
    [epic.id],
  );
  assert.ok(children.length >= 3);

  // Audit rows present.
  for (const c of children) {
    const audit = queryAll<{ to_parent_id: string }>(
      `SELECT to_parent_id FROM initiative_parent_history WHERE initiative_id = ?`,
      [c.id],
    );
    assert.equal(audit.length, 1);
    assert.equal(audit[0].to_parent_id, epic.id);
  }
});
