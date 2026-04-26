/**
 * POST /api/pm/plan-initiative route test (Polish B).
 *
 * Verifies the wrapper accepts a draft, persists an advisory proposal,
 * and returns the structured suggestions. Refinement chain is exercised
 * separately because that route is the existing /refine endpoint.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { POST as refinePOST } from '../proposals/[id]/refine/route';
import { queryAll, run } from '@/lib/db';
import { ensurePmAgent } from '@/lib/bootstrap-agents';
import { getProposal } from '@/lib/db/pm-proposals';

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

test('POST /api/pm/plan-initiative: missing workspace_id → 400', async () => {
  const res = await POST(postJson('/api/pm/plan-initiative', { draft: { title: 'x' } }));
  assert.equal(res.status, 400);
});

test('POST /api/pm/plan-initiative: missing title → 400', async () => {
  const ws = freshWorkspace();
  const res = await POST(postJson('/api/pm/plan-initiative', { workspace_id: ws, draft: {} }));
  assert.equal(res.status, 400);
});

test('POST /api/pm/plan-initiative: returns proposal_id + suggestions', async () => {
  const ws = freshWorkspace();
  const res = await POST(
    postJson('/api/pm/plan-initiative', {
      workspace_id: ws,
      draft: { title: 'Add invoicing', description: 'A new invoicing flow' },
    }),
  );
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.ok(data.proposal_id);
  assert.ok(data.proposal);
  assert.equal(data.proposal.trigger_kind, 'plan_initiative');
  assert.equal(data.proposal.status, 'draft');
  assert.ok(data.suggestions);
  assert.ok(['S', 'M', 'L', 'XL'].includes(data.suggestions.complexity));
  assert.ok(data.suggestions.target_end);

  // Proposal is recorded in DB.
  const stored = getProposal(data.proposal_id);
  assert.ok(stored);
  assert.equal(stored!.trigger_kind, 'plan_initiative');
});

test('POST /api/pm/plan-initiative: chat echo posts the PROPOSAL impact_md (not synth-only)', async () => {
  const ws = freshWorkspace();
  const res = await POST(
    postJson('/api/pm/plan-initiative', {
      workspace_id: ws,
      draft: { title: 'Add invoicing' },
    }),
  );
  const data = await res.json();
  const expectedImpact = data.proposal.impact_md as string;

  // The assistant chat row must mirror the persisted proposal's
  // impact_md. The named-agent path can return a richer impact_md than
  // synth — using `proposal.impact_md` keeps the echo aligned regardless
  // of which path produced the proposal (PR follow-up to #55).
  const messages = queryAll<{ role: string; content: string; metadata: string | null }>(
    `SELECT role, content, metadata FROM agent_chat_messages
     WHERE agent_id = (SELECT id FROM agents WHERE workspace_id = ? AND role = 'pm')
     ORDER BY created_at ASC`,
    [ws],
  );
  const assistant = messages.find(m => m.role === 'assistant');
  assert.ok(assistant);
  assert.equal(assistant!.content, expectedImpact);
});

test('POST /api/pm/plan-initiative + refine: refine returns a child proposal with parent_proposal_id set', async () => {
  const ws = freshWorkspace();
  const planRes = await POST(
    postJson('/api/pm/plan-initiative', {
      workspace_id: ws,
      draft: { title: 'Add invoicing' },
    }),
  );
  const planData = await planRes.json();
  const parentId = planData.proposal_id;

  // Now refine via the existing endpoint.
  const refineReq = new NextRequest(
    `http://localhost/api/pm/proposals/${parentId}/refine`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ additional_constraint: 'force complexity to L' }),
    },
  );
  const refineRes = await refinePOST(refineReq, { params: Promise.resolve({ id: parentId }) });
  assert.equal(refineRes.status, 201);
  const refineData = await refineRes.json();
  assert.ok(refineData.proposal);
  assert.equal(refineData.proposal.parent_proposal_id, parentId);
  assert.equal(refineData.proposal.trigger_kind, 'plan_initiative');
});
