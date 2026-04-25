/**
 * End-to-end derivation test (Phase 4).
 *
 * Seeds a realistic roadmap (milestone → 2 epics → 4 stories with various
 * effort/complexity, two cross-initiative deps, one owner availability
 * window, four completed tasks for owner X to give a 0.8 velocity ratio),
 * runs `applyDerivation`, and asserts the database state.
 *
 * Doesn't go through the API — exercises the helper directly so we can
 * inspect rows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { applyDerivation } from './apply-derivation';
import { createOwnerAvailability } from '@/lib/db/owner-availability';

function seedAgent(id: string, name: string): void {
  run(
    `INSERT INTO agents (id, name, role, workspace_id, created_at, updated_at)
     VALUES (?, ?, 'worker', 'default', datetime('now'), datetime('now'))`,
    [id, name],
  );
}

function seedInitiative(opts: {
  id?: string;
  workspace_id?: string;
  parent?: string | null;
  kind: 'milestone' | 'epic' | 'story' | 'theme';
  title: string;
  owner_agent_id?: string | null;
  estimated_effort_hours?: number | null;
  complexity?: 'S' | 'M' | 'L' | 'XL' | null;
  committed_end?: string | null;
  target_end?: string | null;
  status?: string;
}): string {
  const id = opts.id ?? uuidv4();
  run(
    `INSERT INTO initiatives (id, workspace_id, parent_initiative_id, kind, title,
        status, owner_agent_id, estimated_effort_hours, complexity,
        target_end, committed_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      id,
      opts.workspace_id ?? 'default',
      opts.parent ?? null,
      opts.kind,
      opts.title,
      opts.status ?? 'planned',
      opts.owner_agent_id ?? null,
      opts.estimated_effort_hours ?? null,
      opts.complexity ?? null,
      opts.target_end ?? null,
      opts.committed_end ?? null,
    ],
  );
  return id;
}

function seedDoneTask(opts: {
  agent_id: string;
  estimated_cost_usd: number;
  actual_cost_usd: number;
  workspace_id?: string;
}): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id,
        assigned_agent_id, estimated_cost_usd, actual_cost_usd,
        created_at, updated_at)
     VALUES (?, 'historical', 'done', 'normal', ?, 'default', ?, ?, ?,
       datetime('now', '-30 days'), datetime('now'))`,
    [id, opts.workspace_id ?? 'default', opts.agent_id, opts.estimated_cost_usd, opts.actual_cost_usd],
  );
  return id;
}

test('e2e: applyDerivation populates derived_*, flips milestone to at_risk, emits event', async () => {
  const workspace = 'phase4-e2e-' + Math.random().toString(36).slice(2, 8);
  // Workspace must exist as a row (FK target).
  run(
    `INSERT INTO workspaces (id, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    [workspace, workspace, workspace],
  );

  // Seed an owner agent who is "slow" (velocity ratio ~ 0.8).
  const owner = `owner-${workspace}`;
  seedAgent(owner, 'Sarah');
  // 4 done tasks: estimated 100, actual 125 → ratio 0.8 each → average 0.8.
  for (let i = 0; i < 4; i++) {
    seedDoneTask({ agent_id: owner, estimated_cost_usd: 100, actual_cost_usd: 125 });
  }

  // Seed roadmap: a milestone with committed_end May 30, two epics under
  // it, four stories with effort.
  const milestone = seedInitiative({
    workspace_id: workspace,
    kind: 'milestone',
    title: 'Launch May 30',
    committed_end: '2026-05-30',
    owner_agent_id: owner,
    status: 'planned',
  });
  const epic1 = seedInitiative({
    workspace_id: workspace,
    kind: 'epic',
    title: 'Epic 1',
    parent: milestone,
    owner_agent_id: owner,
  });
  const epic2 = seedInitiative({
    workspace_id: workspace,
    kind: 'epic',
    title: 'Epic 2',
    parent: milestone,
    owner_agent_id: owner,
  });
  const s1 = seedInitiative({
    workspace_id: workspace,
    kind: 'story',
    title: 'Story 1',
    parent: epic1,
    owner_agent_id: owner,
    estimated_effort_hours: 60,
  });
  const s2 = seedInitiative({
    workspace_id: workspace,
    kind: 'story',
    title: 'Story 2',
    parent: epic1,
    owner_agent_id: owner,
    complexity: 'L', // 40h
  });
  const s3 = seedInitiative({
    workspace_id: workspace,
    kind: 'story',
    title: 'Story 3',
    parent: epic2,
    owner_agent_id: owner,
    complexity: 'M', // 12h
  });
  const s4 = seedInitiative({
    workspace_id: workspace,
    kind: 'story',
    title: 'Story 4',
    parent: epic2,
    owner_agent_id: owner,
    estimated_effort_hours: 80,
  });

  // Two cross-initiative deps: s2 → s1, s3 → s2 (chain across stories).
  run(
    `INSERT INTO initiative_dependencies (id, initiative_id, depends_on_initiative_id, kind, created_at)
     VALUES (?, ?, ?, 'finish_to_start', datetime('now'))`,
    [uuidv4(), s2, s1],
  );
  run(
    `INSERT INTO initiative_dependencies (id, initiative_id, depends_on_initiative_id, kind, created_at)
     VALUES (?, ?, ?, 'finish_to_start', datetime('now'))`,
    [uuidv4(), s3, s2],
  );

  // One owner availability window (2 weeks of vacation).
  createOwnerAvailability({
    agent_id: owner,
    unavailable_start: '2026-04-20',
    unavailable_end: '2026-05-01',
    reason: 'PTO',
  });

  // Run derivation. Use a fixed today so the test is deterministic.
  const result = applyDerivation(workspace, { today: '2026-04-13' });

  // Assertions:
  // 1. Every initiative now has non-NULL derived_*.
  const rows = queryAll<{ id: string; derived_start: string | null; derived_end: string | null; status: string }>(
    'SELECT id, derived_start, derived_end, status FROM initiatives WHERE workspace_id = ?',
    [workspace],
  );
  assert.equal(rows.length, 7);
  for (const r of rows) {
    assert.ok(r.derived_start != null, `derived_start NULL on ${r.id}`);
    assert.ok(r.derived_end != null, `derived_end NULL on ${r.id}`);
  }

  // 2. The milestone's derived_end is past committed_end (slow team + chain
  //    dependency means the May 30 commitment slips).
  const m = queryOne<{ derived_end: string; committed_end: string; status: string }>(
    'SELECT derived_end, committed_end, status FROM initiatives WHERE id = ?',
    [milestone],
  )!;
  assert.ok(
    m.derived_end > m.committed_end,
    `Expected derived_end (${m.derived_end}) > committed_end (${m.committed_end})`,
  );
  // 3. Status flipped to at_risk (was planned).
  assert.equal(m.status, 'at_risk');

  // 4. Drift event row exists.
  const events = queryAll<{ metadata: string }>(
    `SELECT metadata FROM events
     WHERE type = 'roadmap_drift_scan'
     ORDER BY created_at DESC LIMIT 1`,
  );
  assert.ok(events.length > 0);
  const meta = JSON.parse(events[0].metadata);
  assert.equal(meta.workspace_id, workspace);
  assert.ok(Array.isArray(meta.drifts));
  // At least one milestone_at_risk drift mentioning our milestone.
  const milestoneEvent = meta.drifts.find(
    (d: { kind: string; initiative_id?: string }) =>
      d.kind === 'milestone_at_risk' && d.initiative_id === milestone,
  );
  assert.ok(milestoneEvent, 'milestone drift event not found');

  // 5. Idempotency: re-run produces the same dates and writes nothing.
  const before = queryAll<{ id: string; derived_start: string; derived_end: string }>(
    'SELECT id, derived_start, derived_end FROM initiatives WHERE workspace_id = ? ORDER BY id',
    [workspace],
  );
  const second = applyDerivation(workspace, { today: '2026-04-13' });
  assert.equal(second.initiatives_updated, 0, 'Re-run should update nothing');
  const after = queryAll<{ id: string; derived_start: string; derived_end: string }>(
    'SELECT id, derived_start, derived_end FROM initiatives WHERE workspace_id = ? ORDER BY id',
    [workspace],
  );
  assert.deepEqual(after, before);

  // Silence unused
  void s4;
});
