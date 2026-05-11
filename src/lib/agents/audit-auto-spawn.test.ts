/**
 * Tests for the audit → PM auto-spawn bridge.
 *
 * Covers the gate (verdict + workspace setting) and the bookkeeping
 * side-effects (consumed_by_stages, pm_proposal_ids) when the gate
 * fires. The PM dispatch itself goes through the synth-fallback path
 * (no gateway in tests) — we don't assert on the proposal body, only
 * that a row was created and linked back to the verdict note.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, run } from '@/lib/db';
import { createNote, getNote } from '@/lib/db/agent-notes';
import { createInitiative } from '@/lib/db/initiatives';
import { setAuditAutoSpawn } from '@/lib/db/workspaces';
import { ensurePmAgent } from '@/lib/bootstrap-agents';
import {
  maybeAutoSpawnPmFromVerdict,
  verdictWarrantsAutoSpawn,
} from './audit-auto-spawn';

function freshWorkspace(): string {
  const id = `ws-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function seedAgent(workspaceId: string): string {
  const id = uuidv4();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_active, created_at, updated_at)
     VALUES (?, 'A', 'researcher', ?, 1, datetime('now'), datetime('now'))`,
    [id, workspaceId],
  );
  return id;
}

function seedNotePair(
  workspaceId: string,
  initiativeId: string,
  agentId: string,
  verdictBody: object,
) {
  const runGroup = uuidv4();
  const scopeKey = `initiative-${initiativeId}:audit:1`;
  const observation = createNote({
    workspace_id: workspaceId,
    agent_id: agentId,
    initiative_id: initiativeId,
    scope_key: scopeKey,
    role: 'researcher',
    run_group_id: runGroup,
    kind: 'observation',
    audience: 'pm',
    body: 'Audit body prose — found that the story is never built.',
    importance: 2,
  });
  const verdict = createNote({
    workspace_id: workspaceId,
    agent_id: agentId,
    initiative_id: initiativeId,
    scope_key: scopeKey,
    role: 'researcher',
    run_group_id: runGroup,
    kind: 'audit_verdict',
    audience: 'pm',
    body: JSON.stringify({
      ...verdictBody,
      observation_note_id: observation.id,
    }),
    importance: 1,
  });
  return { observation, verdict };
}

// ─── verdictWarrantsAutoSpawn (pure) ───────────────────────────────

test('verdictWarrantsAutoSpawn: action_recommended=true → true', () => {
  assert.equal(
    verdictWarrantsAutoSpawn({
      version: 1,
      observation_note_id: 'o',
      verdict: 'never_built',
      action_recommended: true,
      short_rationale: 'twenty chars or more rationale',
    } as any),
    true,
  );
});

test('verdictWarrantsAutoSpawn: action_recommended=false on non-failure → false', () => {
  assert.equal(
    verdictWarrantsAutoSpawn({
      version: 1,
      observation_note_id: 'o',
      verdict: 'on_track',
      action_recommended: false,
      short_rationale: 'twenty chars or more rationale',
    } as any),
    false,
  );
});

test('verdictWarrantsAutoSpawn: audit_failed always warrants spawn', () => {
  assert.equal(
    verdictWarrantsAutoSpawn({
      version: 1,
      observation_note_id: 'o',
      verdict: 'audit_failed',
      action_recommended: false,
      short_rationale: 'twenty chars or more rationale',
    } as any),
    true,
  );
});

// ─── maybeAutoSpawnPmFromVerdict ───────────────────────────────────

test('auto-spawn: workspace setting OFF → no dispatch, no bookkeeping', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  const agentId = seedAgent(ws);
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'S' });

  // Setting defaults to OFF; no setAuditAutoSpawn call.
  const { verdict, observation } = seedNotePair(ws, init.id, agentId, {
    version: 1,
    verdict: 'never_built',
    action_recommended: true,
    short_rationale: 'Twenty chars or more of justification text.',
  });

  const proposalsBefore = queryAll(
    `SELECT id FROM pm_proposals WHERE workspace_id = ?`,
    [ws],
  ).length;
  await maybeAutoSpawnPmFromVerdict(verdict);
  const proposalsAfter = queryAll(
    `SELECT id FROM pm_proposals WHERE workspace_id = ?`,
    [ws],
  ).length;
  assert.equal(proposalsAfter, proposalsBefore, 'no PM proposal should be created');

  const verdictAfter = getNote(verdict.id);
  assert.equal(verdictAfter?.pm_proposal_ids, null);
  const observationAfter = getNote(observation.id);
  assert.equal(observationAfter?.consumed_by_stages, null);
});

test('auto-spawn: action_recommended=false → no dispatch (setting ON)', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  setAuditAutoSpawn(ws, true);
  const agentId = seedAgent(ws);
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'S' });

  const { verdict } = seedNotePair(ws, init.id, agentId, {
    version: 1,
    verdict: 'on_track',
    action_recommended: false,
    short_rationale: 'Initiative is on track per the evidence collected.',
  });

  const proposalsBefore = queryAll(
    `SELECT id FROM pm_proposals WHERE workspace_id = ?`,
    [ws],
  ).length;
  await maybeAutoSpawnPmFromVerdict(verdict);
  const proposalsAfter = queryAll(
    `SELECT id FROM pm_proposals WHERE workspace_id = ?`,
    [ws],
  ).length;
  assert.equal(proposalsAfter, proposalsBefore);
});

test('auto-spawn: gate fires → PM proposal created + both notes linked + consumed', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  setAuditAutoSpawn(ws, true);
  const agentId = seedAgent(ws);
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'S' });

  const { verdict, observation } = seedNotePair(ws, init.id, agentId, {
    version: 1,
    verdict: 'never_built',
    action_recommended: true,
    recommended_action_hint: 'cancel',
    short_rationale: 'Story has zero tasks and no source files in the workspace.',
  });

  const proposalsBefore = queryAll<{ id: string }>(
    `SELECT id FROM pm_proposals WHERE workspace_id = ?`,
    [ws],
  ).length;
  await maybeAutoSpawnPmFromVerdict(verdict);

  const proposalsAfter = queryAll<{ id: string }>(
    `SELECT id FROM pm_proposals WHERE workspace_id = ?`,
    [ws],
  );
  assert.equal(
    proposalsAfter.length,
    proposalsBefore + 1,
    'expected one new PM proposal',
  );

  const newProposalId = proposalsAfter[proposalsAfter.length - 1].id;

  const verdictAfter = getNote(verdict.id);
  assert.ok(verdictAfter?.pm_proposal_ids?.includes(newProposalId));
  assert.ok(verdictAfter?.consumed_by_stages?.includes('pm_proposal'));

  const observationAfter = getNote(observation.id);
  assert.ok(observationAfter?.pm_proposal_ids?.includes(newProposalId));
  assert.ok(observationAfter?.consumed_by_stages?.includes('pm_proposal'));
});

test('auto-spawn: malformed body is logged + skipped, no throw', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  setAuditAutoSpawn(ws, true);
  const agentId = seedAgent(ws);
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'S' });

  // createNote bypasses take_note's validateAuditNoteBody, so we can
  // simulate the "auditor wrote past the validator" defensive branch.
  const malformed = createNote({
    workspace_id: ws,
    agent_id: agentId,
    initiative_id: init.id,
    scope_key: `initiative-${init.id}:audit:1`,
    role: 'researcher',
    run_group_id: uuidv4(),
    kind: 'audit_verdict',
    audience: 'pm',
    body: '{"this": "is not the verdict shape"}',
    importance: 1,
  });

  await assert.doesNotReject(() => maybeAutoSpawnPmFromVerdict(malformed));
});
