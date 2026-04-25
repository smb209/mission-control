/**
 * Proactive PM standup tests (Phase 6).
 *
 * Coverage:
 *   1. No drift → returns null, emits pm_standup_skipped, no proposal.
 *   2. Milestone slipping → proposal with set_initiative_status + shift_initiative_target.
 *   3. Cycle detected → flagged in impact_md without shift diffs for cycle members.
 *   4. Stale in-progress task → update_status_check suggestion.
 *   5. Idempotent within 24h → second call returns the existing proposal.
 *   6. End-to-end via schedule trigger → applyDerivation runs, then standup runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run, getDb } from '@/lib/db';
import { createInitiative, addInitiativeDependency } from '@/lib/db/initiatives';
import { listProposals } from '@/lib/db/pm-proposals';
import { ensurePmAgent } from '@/lib/bootstrap-agents';
import { generateStandup } from './pm-standup';
import { applyDerivation } from '@/lib/roadmap/apply-derivation';

function freshWorkspace(): string {
  const id = `ws-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  ensurePmAgent(id);
  return id;
}

function seedAgent(workspace: string, name: string): string {
  const id = uuidv4();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_active, created_at, updated_at)
     VALUES (?, ?, 'worker', ?, 1, datetime('now'), datetime('now'))`,
    [id, name, workspace],
  );
  return id;
}

// ─── Test 1: no drift → skipped event, no proposal ─────────────────

test('generateStandup: no drift → returns null + emits pm_standup_skipped', () => {
  const ws = freshWorkspace();
  // Healthy workspace: a milestone with committed_end well in the future,
  // no slipping initiatives, no blocked items.
  createInitiative({
    workspace_id: ws,
    kind: 'milestone',
    title: 'Q3 launch',
    committed_end: '2027-01-01',
    target_end: '2027-01-01',
  });

  const before = queryAll(
    `SELECT id FROM events WHERE type IN ('pm_standup_generated','pm_standup_skipped')`,
  ).length;

  const result = generateStandup({ workspace_id: ws, today: '2026-04-24' });
  assert.equal(result.proposal, null);
  assert.equal(result.skipped_reason, 'no_drift');

  const after = queryAll<{ id: string; type: string }>(
    `SELECT id, type FROM events WHERE type IN ('pm_standup_generated','pm_standup_skipped') ORDER BY created_at DESC`,
  );
  assert.equal(after.length - before, 1);
  assert.equal(after[0].type, 'pm_standup_skipped');

  // No proposal created.
  const props = listProposals({ workspace_id: ws });
  assert.equal(props.length, 0);
});

// ─── Test 2: milestone slipping → proposal with shift + at_risk ────

test('generateStandup: milestone slipping past committed_end → proposal created', () => {
  const ws = freshWorkspace();
  const owner = seedAgent(ws, 'Sarah');

  // Milestone committed_end is in the past — it's already late.
  const milestone = createInitiative({
    workspace_id: ws,
    kind: 'milestone',
    title: 'Customer demo',
    committed_end: '2026-04-10',
    target_end: '2026-04-10',
    owner_agent_id: owner,
  });
  // Epic under it with explicit effort — drives derived_end past committed_end.
  createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Build big feature',
    parent_initiative_id: milestone.id,
    owner_agent_id: owner,
    estimated_effort_hours: 200,
    target_start: '2026-04-15',
  });

  const result = generateStandup({ workspace_id: ws, today: '2026-04-24' });
  assert.ok(result.proposal, 'expected a proposal');
  const p = result.proposal!;
  assert.equal(p.trigger_kind, 'scheduled_drift_scan');
  assert.equal(p.status, 'draft');
  assert.match(p.trigger_text, /Daily roadmap standup/);

  // The diff list should include set_initiative_status=at_risk on the
  // milestone and a shift_initiative_target on the same.
  const setStatuses = p.proposed_changes.filter(
    c => c.kind === 'set_initiative_status' && c.initiative_id === milestone.id,
  );
  assert.equal(setStatuses.length, 1);
  assert.equal((setStatuses[0] as { status: string }).status, 'at_risk');

  const shifts = p.proposed_changes.filter(
    c => c.kind === 'shift_initiative_target' && c.initiative_id === milestone.id,
  );
  assert.equal(shifts.length, 1);

  // Event row was emitted.
  const ev = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE type = 'pm_standup_generated'`,
  );
  assert.ok(ev.length >= 1);
});

// ─── Test 3: cycle detected → flagged in md, no shifts for members ─

test('generateStandup: cycle detected → flagged in impact_md without shift diffs for members', () => {
  const ws = freshWorkspace();
  const owner = seedAgent(ws, 'Alex');

  const a = createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Alpha',
    owner_agent_id: owner,
    estimated_effort_hours: 8,
    target_end: '2026-04-30',
  });
  const b = createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Bravo',
    owner_agent_id: owner,
    estimated_effort_hours: 8,
    target_end: '2026-04-30',
  });
  // A→B and B→A is a cycle.
  addInitiativeDependency({ initiative_id: a.id, depends_on_initiative_id: b.id });
  addInitiativeDependency({ initiative_id: b.id, depends_on_initiative_id: a.id });

  const result = generateStandup({ workspace_id: ws, today: '2026-04-24' });
  // A cycle counts as drift, so a proposal IS created (impact_md flags it).
  assert.ok(result.proposal, 'cycle should still produce a proposal');
  const p = result.proposal!;

  // impact_md mentions the cycle.
  assert.match(p.impact_md, /cycle/i);

  // No shift_initiative_target diffs reference the cycle members (engine
  // makes their derived_* NULL inside the cycle).
  for (const c of p.proposed_changes) {
    if (c.kind === 'shift_initiative_target') {
      assert.notEqual(c.initiative_id, a.id);
      assert.notEqual(c.initiative_id, b.id);
    }
  }
});

// ─── Test 4: stale in-progress task → update_status_check ──────────

test('generateStandup: stale in-progress initiative → update_status_check suggestion', () => {
  const ws = freshWorkspace();
  const owner = seedAgent(ws, 'Dana');

  // 14 days ago — past the STALE_TASK_DAYS=7 threshold.
  const fourteenDaysAgo = new Date(Date.UTC(2026, 3, 10)).toISOString(); // 2026-04-10
  const initiativeId = uuidv4();
  run(
    `INSERT INTO initiatives (id, workspace_id, kind, title, status, owner_agent_id, created_at, updated_at)
     VALUES (?, ?, 'epic', 'Stuck thing', 'in_progress', ?, ?, ?)`,
    [initiativeId, ws, owner, fourteenDaysAgo, fourteenDaysAgo],
  );
  // A task on it whose updated_at is the same old timestamp.
  const taskId = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, initiative_id, created_at, updated_at)
     VALUES (?, 'Implement x', 'in_progress', ?, ?, ?, ?)`,
    [taskId, ws, initiativeId, fourteenDaysAgo, fourteenDaysAgo],
  );

  const result = generateStandup({ workspace_id: ws, today: '2026-04-24' });
  assert.ok(result.proposal, 'expected a proposal');
  const p = result.proposal!;

  const checkDiffs = p.proposed_changes.filter(
    c => c.kind === 'update_status_check' && c.initiative_id === initiativeId,
  );
  assert.equal(checkDiffs.length, 1, 'expected one update_status_check diff');
  assert.match(
    (checkDiffs[0] as { status_check_md: string }).status_check_md,
    /no task activity in \d+d/,
  );
});

// ─── Test 5: idempotency within 24h ────────────────────────────────

test('generateStandup: idempotent within UTC day — second call returns existing draft', () => {
  const ws = freshWorkspace();
  const owner = seedAgent(ws, 'Eli');
  const milestone = createInitiative({
    workspace_id: ws,
    kind: 'milestone',
    title: 'Demo',
    committed_end: '2026-04-10',
    owner_agent_id: owner,
  });
  createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Heavy lift',
    parent_initiative_id: milestone.id,
    owner_agent_id: owner,
    estimated_effort_hours: 200,
    target_start: '2026-04-15',
  });

  const first = generateStandup({ workspace_id: ws, today: '2026-04-24' });
  assert.ok(first.proposal);

  const second = generateStandup({ workspace_id: ws, today: '2026-04-24' });
  assert.ok(second.proposal);
  assert.equal(second.proposal!.id, first.proposal!.id, 'should return the same proposal');
  assert.equal(second.skipped_reason, 'already_today');

  // Only one draft proposal exists for this workspace.
  const drafts = listProposals({ workspace_id: ws, status: 'draft' });
  assert.equal(drafts.length, 1);

  // force=true bypasses the idempotency guard — useful for the manual
  // "Run standup now" button.
  const forced = generateStandup({
    workspace_id: ws,
    today: '2026-04-24',
    force: true,
  });
  assert.ok(forced.proposal);
  assert.notEqual(forced.proposal!.id, first.proposal!.id);
});

// ─── Test 6: schedule handler runs derive then standup ─────────────

test('generateStandup: end-to-end via schedule handler — applyDerivation + generateStandup', async () => {
  const ws = freshWorkspace();
  const owner = seedAgent(ws, 'Finn');

  // Slipping milestone — derived_end will exceed committed_end.
  const milestone = createInitiative({
    workspace_id: ws,
    kind: 'milestone',
    title: 'Schedule-handler demo',
    committed_end: '2026-04-12',
    owner_agent_id: owner,
  });
  createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Big lift',
    parent_initiative_id: milestone.id,
    owner_agent_id: owner,
    estimated_effort_hours: 100,
    target_start: '2026-04-15',
  });

  // Mirror what scheduling.ts does for the roadmap_drift_scan branch:
  // (1) applyDerivation, (2) generateStandup.
  const apply = applyDerivation(ws, { today: '2026-04-24' });
  assert.ok(apply.drifts.length > 0, 'derivation should detect drift');

  const before = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE type = 'pm_standup_generated'`,
  ).length;

  const standup = generateStandup({ workspace_id: ws, today: '2026-04-24' });
  assert.ok(standup.proposal, 'standup should produce a proposal');

  const after = queryAll<{ id: string }>(
    `SELECT id FROM events WHERE type = 'pm_standup_generated'`,
  ).length;
  assert.equal(after - before, 1);

  // The proposal references the real milestone id.
  const refsMilestone = standup.proposal!.proposed_changes.some(
    c => 'initiative_id' in c && c.initiative_id === milestone.id,
  );
  assert.ok(refsMilestone, 'standup should reference the slipping milestone');

  // Suppress unused — we only care that the queryOne import resolves.
  void queryOne;
  void getDb;
});
