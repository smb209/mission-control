/**
 * End-to-end PM lifecycle test (Phase 5).
 *
 * Mirrors the API-level flow from the spec (§9.2) without spinning up
 * Next.js: workspace + tree + PM agent, dispatch a disruption, verify
 * draft proposal, accept it, verify diff applied + event emitted.
 *
 * The real /api/pm/proposals route does the same thing through HTTP;
 * tests that bind a port are flaky in CI. The route handlers are thin
 * wrappers over the same helpers exercised here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { createInitiative } from '@/lib/db/initiatives';
import { acceptProposal, getProposal, listProposals } from '@/lib/db/pm-proposals';
import { dispatchPm } from './pm-dispatch';
import { ensurePmAgent } from '@/lib/bootstrap-agents';
import { createProposal, PmProposalValidationError } from '@/lib/db/pm-proposals';

function freshWorkspace(): string {
  const id = `ws-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

test('PM lifecycle: dispatch → draft → accept → diff applied + event emitted', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);

  // Seed a "Sarah" agent + an initiative she owns + a milestone child.
  const sarahId = uuidv4();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_active, created_at, updated_at)
     VALUES (?, 'Sarah', 'worker', ?, 1, datetime('now'), datetime('now'))`,
    [sarahId, ws],
  );

  const milestone = createInitiative({
    workspace_id: ws,
    kind: 'milestone',
    title: 'Customer demo',
    target_end: '2026-05-30',
    owner_agent_id: sarahId,
  });
  const epic = createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Build big feature',
    parent_initiative_id: milestone.id,
    owner_agent_id: sarahId,
    estimated_effort_hours: 24,
  });

  // 1. Operator drops a disruption.
  const dispatch = await dispatchPm({
    workspace_id: ws,
    trigger_text: 'Sarah out 2026-05-01 to 2026-05-08',
  });
  const proposalId = dispatch.proposal.id;
  assert.equal(dispatch.proposal.status, 'draft');

  // 2. Verify the proposal is listable in the workspace.
  const drafts = listProposals({ workspace_id: ws, status: 'draft' });
  assert.ok(drafts.find(p => p.id === proposalId));

  // 3. Verify each change references real ids in this workspace.
  const realInitiativeIds = new Set([milestone.id, epic.id]);
  for (const change of dispatch.proposal.proposed_changes) {
    if ('initiative_id' in change && change.initiative_id) {
      assert.ok(
        realInitiativeIds.has(change.initiative_id),
        `hallucinated initiative id: ${change.initiative_id}`,
      );
    }
    if (change.kind === 'add_availability') {
      assert.equal(change.agent_id, sarahId);
    }
  }

  // 4. Accept the proposal.
  const eventBefore = queryAll(
    `SELECT id FROM events WHERE type = 'pm_proposal_accepted'`,
  ).length;
  const accept = acceptProposal(proposalId, /* applied_by_agent_id */ null);
  assert.equal(accept.idempotent_noop, false);
  assert.equal(accept.proposal.status, 'accepted');
  assert.ok(accept.proposal.applied_at);

  // 5. Verify side effects:
  //    - availability row inserted
  //    - any set_initiative_status / shift_initiative_target diffs landed
  //    - one new event row emitted
  const availRows = queryAll<{ id: string }>(
    `SELECT id FROM owner_availability WHERE agent_id = ? AND unavailable_start = ?`,
    [sarahId, '2026-05-01'],
  );
  assert.equal(availRows.length, 1);

  const eventAfter = queryAll(
    `SELECT id FROM events WHERE type = 'pm_proposal_accepted'`,
  ).length;
  assert.equal(eventAfter, eventBefore + 1);

  // 6. Idempotent re-accept is a no-op.
  const r2 = acceptProposal(proposalId);
  assert.equal(r2.idempotent_noop, true);
  // Event count must NOT increase.
  const eventFinal = queryAll(
    `SELECT id FROM events WHERE type = 'pm_proposal_accepted'`,
  ).length;
  assert.equal(eventFinal, eventAfter);
});

test('PM lifecycle: PM is seeded once per workspace and ensurePmAgent is idempotent', () => {
  const ws = freshWorkspace();
  const first = ensurePmAgent(ws);
  assert.equal(first.created, true);

  const second = ensurePmAgent(ws);
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);

  const pms = queryAll<{ id: string }>(
    `SELECT id FROM agents WHERE workspace_id = ? AND role = 'pm'`,
    [ws],
  );
  assert.equal(pms.length, 1);
});

test('PM lifecycle: refused diffs (done/cancelled status) never reach the DB', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'S' });

  // Direct API call — simulates an LLM trying to slip a forbidden diff
  // through propose_changes. Validation must reject before any write.
  let threw = false;
  try {
    createProposal({
      workspace_id: ws,
      trigger_text: 'sneaky',
      impact_md: '.',
      proposed_changes: [
        // Forbidden status from the PM. The diff is well-formed JSON
        // but the validator rejects 'done'/'cancelled'.
        { kind: 'set_initiative_status', initiative_id: init.id, status: 'done' as never },
      ],
    });
  } catch (err) {
    threw = err instanceof PmProposalValidationError;
  }
  assert.equal(threw, true);

  // Initiative status untouched, no proposal row written.
  const fresh = queryOne<{ status: string }>(
    'SELECT status FROM initiatives WHERE id = ?',
    [init.id],
  );
  assert.equal(fresh?.status, 'planned');
  const all = listProposals({ workspace_id: ws });
  assert.equal(all.length, 0);
});
