/**
 * Round-trip tests for invertDiff.
 *
 * For each diff kind: apply forward → invert → apply inverse, then
 * assert the DB is back to its initial state. This is the load-bearing
 * guarantee of the revert feature: the inverse must be a pure function
 * of the captured diff, executable without any extra "modified since"
 * accommodation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import {
  createProposal,
  getProposal,
  acceptProposal,
} from '@/lib/db/pm-proposals';
import {
  createInitiative,
  addInitiativeDependency,
  type Initiative,
} from '@/lib/db/initiatives';
import { invertProposalDiffs } from './invertDiff';

function freshWorkspace(): string {
  const id = `ws-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

/**
 * Helper: accept the forward proposal, then synthesize + accept its
 * inverse via createProposal+acceptProposal (the same flow the real
 * endpoint uses minus the HTTP shell).
 */
function applyAndRevert(workspaceId: string, forwardProposalId: string): void {
  acceptProposal(forwardProposalId);
  const accepted = getProposal(forwardProposalId)!;
  const { diffs } = invertProposalDiffs(accepted.proposed_changes);
  if (diffs.length === 0) throw new Error('No invertible diffs');
  const revert = createProposal({
    workspace_id: workspaceId,
    trigger_text: 'revert-test',
    trigger_kind: 'revert',
    impact_md: 'revert',
    proposed_changes: diffs,
    reverts_proposal_id: forwardProposalId,
  });
  acceptProposal(revert.id);
}

// ─── Per-kind round-trip ────────────────────────────────────────────

test('round-trip: set_initiative_status restores prior status', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'X' });
  const before = init.status;

  const p = createProposal({
    workspace_id: ws,
    trigger_text: 't',
    impact_md: 'm',
    proposed_changes: [
      { kind: 'set_initiative_status', initiative_id: init.id, status: 'at_risk' },
    ],
  });
  applyAndRevert(ws, p.id);

  const after = queryOne<{ status: string }>(
    'SELECT status FROM initiatives WHERE id = ?',
    [init.id],
  );
  assert.equal(after?.status, before);
});

test('round-trip: shift_initiative_target restores prior targets', () => {
  const ws = freshWorkspace();
  const init = createInitiative({
    workspace_id: ws,
    kind: 'milestone',
    title: 'Launch',
    target_start: '2026-04-01',
    target_end: '2026-05-01',
  });

  const p = createProposal({
    workspace_id: ws,
    trigger_text: 't',
    impact_md: 'm',
    proposed_changes: [
      {
        kind: 'shift_initiative_target',
        initiative_id: init.id,
        target_start: '2026-06-01',
        target_end: '2026-07-01',
      },
    ],
  });
  applyAndRevert(ws, p.id);

  const after = queryOne<{ target_start: string | null; target_end: string | null }>(
    'SELECT target_start, target_end FROM initiatives WHERE id = ?',
    [init.id],
  );
  assert.equal(after?.target_start?.slice(0, 10), '2026-04-01');
  assert.equal(after?.target_end?.slice(0, 10), '2026-05-01');
});

test('round-trip: update_status_check restores prior markdown', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'X' });
  run(`UPDATE initiatives SET status_check_md = ? WHERE id = ?`, ['original', init.id]);

  const p = createProposal({
    workspace_id: ws,
    trigger_text: 't',
    impact_md: 'm',
    proposed_changes: [
      { kind: 'update_status_check', initiative_id: init.id, status_check_md: 'updated' },
    ],
  });
  applyAndRevert(ws, p.id);

  const after = queryOne<{ status_check_md: string | null }>(
    'SELECT status_check_md FROM initiatives WHERE id = ?',
    [init.id],
  );
  assert.equal(after?.status_check_md, 'original');
});

test('round-trip: add_dependency removes the created edge', () => {
  const ws = freshWorkspace();
  const a = createInitiative({ workspace_id: ws, kind: 'epic', title: 'A' });
  const b = createInitiative({ workspace_id: ws, kind: 'epic', title: 'B' });

  const p = createProposal({
    workspace_id: ws,
    trigger_text: 't',
    impact_md: 'm',
    proposed_changes: [
      { kind: 'add_dependency', initiative_id: a.id, depends_on_initiative_id: b.id },
    ],
  });
  applyAndRevert(ws, p.id);

  const rows = queryAll(
    `SELECT id FROM initiative_dependencies WHERE initiative_id = ? AND depends_on_initiative_id = ?`,
    [a.id, b.id],
  );
  assert.equal(rows.length, 0);
});

test('round-trip: remove_dependency restores the deleted edge', () => {
  const ws = freshWorkspace();
  const a = createInitiative({ workspace_id: ws, kind: 'epic', title: 'A' });
  const b = createInitiative({ workspace_id: ws, kind: 'epic', title: 'B' });
  const dep = addInitiativeDependency({
    initiative_id: a.id,
    depends_on_initiative_id: b.id,
  });

  const p = createProposal({
    workspace_id: ws,
    trigger_text: 't',
    impact_md: 'm',
    proposed_changes: [{ kind: 'remove_dependency', dependency_id: dep.id }],
  });
  applyAndRevert(ws, p.id);

  const rows = queryAll<{ id: string }>(
    `SELECT id FROM initiative_dependencies
      WHERE initiative_id = ? AND depends_on_initiative_id = ?`,
    [a.id, b.id],
  );
  // The revert re-inserts an edge with the same (init, depends_on) pair.
  // The actual id may be new (we don't reuse the original id today —
  // applyDiff(add_dependency) generates a fresh uuid). The semantic
  // restore is what matters.
  assert.equal(rows.length, 1);
});

test('round-trip: reorder_initiatives restores prior order', () => {
  const ws = freshWorkspace();
  const parent = createInitiative({ workspace_id: ws, kind: 'milestone', title: 'P' });
  const c1 = createInitiative({ workspace_id: ws, kind: 'epic', title: 'C1', parent_initiative_id: parent.id, sort_order: 0 });
  const c2 = createInitiative({ workspace_id: ws, kind: 'epic', title: 'C2', parent_initiative_id: parent.id, sort_order: 1 });
  const c3 = createInitiative({ workspace_id: ws, kind: 'epic', title: 'C3', parent_initiative_id: parent.id, sort_order: 2 });

  const reversed = [c3.id, c2.id, c1.id];
  const p = createProposal({
    workspace_id: ws,
    trigger_text: 't',
    impact_md: 'm',
    proposed_changes: [
      { kind: 'reorder_initiatives', parent_id: parent.id, child_ids_in_order: reversed },
    ],
  });
  applyAndRevert(ws, p.id);

  const after = queryAll<{ id: string; sort_order: number }>(
    `SELECT id, sort_order FROM initiatives WHERE parent_initiative_id = ? ORDER BY sort_order ASC`,
    [parent.id],
  );
  assert.deepEqual(
    after.map(r => r.id),
    [c1.id, c2.id, c3.id],
  );
});

test('round-trip: create_child_initiative tombstones the created row as cancelled', () => {
  const ws = freshWorkspace();
  const parent = createInitiative({ workspace_id: ws, kind: 'milestone', title: 'P' });

  const p = createProposal({
    workspace_id: ws,
    trigger_text: 't',
    impact_md: 'm',
    proposed_changes: [
      {
        kind: 'create_child_initiative',
        parent_initiative_id: parent.id,
        title: 'New child',
        child_kind: 'epic',
      },
    ],
  });
  applyAndRevert(ws, p.id);

  // The row still exists but is now cancelled (PM never hard-deletes).
  const accepted = getProposal(p.id)!;
  const createdId = (
    accepted.proposed_changes[0] as { created_initiative_id?: string }
  ).created_initiative_id;
  assert.ok(createdId);
  const row = queryOne<{ status: string }>(
    'SELECT status FROM initiatives WHERE id = ?',
    [createdId],
  );
  assert.equal(row?.status, 'cancelled');
});

test('round-trip: create_task_under_initiative cancels the created task', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'I' });

  const p = createProposal({
    workspace_id: ws,
    trigger_text: 't',
    impact_md: 'm',
    proposed_changes: [
      {
        kind: 'create_task_under_initiative',
        initiative_id: init.id,
        title: 'A task',
      },
    ],
  });
  applyAndRevert(ws, p.id);

  const accepted = getProposal(p.id)!;
  const taskId = (accepted.proposed_changes[0] as { created_task_id?: string }).created_task_id;
  assert.ok(taskId);
  const row = queryOne<{ status: string }>(
    'SELECT status FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(row?.status, 'cancelled');
});

// ─── Limited / edge cases ───────────────────────────────────────────

test('invertProposalDiffs marks pre-capture diffs as limited', () => {
  // Synthesize a forward diff WITHOUT capture fields — simulates a
  // proposal accepted before Slice 1's capture pattern landed.
  const result = invertProposalDiffs([
    {
      kind: 'set_initiative_status',
      initiative_id: 'fake-id',
      status: 'at_risk',
    },
  ]);
  assert.equal(result.diffs.length, 0);
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0].status, 'limited');
});

test('invertProposalDiffs reverses order so dependent diffs flip correctly', () => {
  // create_child + create_task_under_initiative referencing the child
  // by placeholder. The inverse should cancel the TASK first, then the
  // CHILD INITIATIVE — otherwise cancelling the parent first would
  // orphan the task in the inversed apply pass.
  const captured: Parameters<typeof invertProposalDiffs>[0] = [
    {
      kind: 'create_child_initiative',
      parent_initiative_id: 'p',
      title: 'child',
      child_kind: 'epic',
      created_initiative_id: 'child-real-id',
    },
    {
      kind: 'create_task_under_initiative',
      initiative_id: 'child-real-id',
      title: 'task',
      created_task_id: 'task-real-id',
    },
  ];
  const { diffs } = invertProposalDiffs(captured);
  assert.equal(diffs.length, 2);
  assert.equal(diffs[0].kind, 'set_task_status');
  assert.equal(diffs[1].kind, 'set_initiative_status');
});

test('round-trip-of-revert: accepting a revert of a revert is supported', () => {
  // Spec: "If the proposal being reverted is itself a revert, that's
  // fine — it just produces another inverse." We exercise the full chain
  // for a kind whose revert is itself fully invertible.
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'X' });

  // Forward.
  const fwd = createProposal({
    workspace_id: ws,
    trigger_text: 't',
    impact_md: 'm',
    proposed_changes: [
      { kind: 'set_initiative_status', initiative_id: init.id, status: 'at_risk' },
    ],
  });
  acceptProposal(fwd.id);
  // Status now at_risk.

  // First revert (back to planned).
  const acceptedFwd = getProposal(fwd.id)!;
  const inv1 = invertProposalDiffs(acceptedFwd.proposed_changes).diffs;
  const rev1 = createProposal({
    workspace_id: ws,
    trigger_text: 'rev',
    trigger_kind: 'revert',
    impact_md: 'rev',
    proposed_changes: inv1,
    reverts_proposal_id: fwd.id,
  });
  acceptProposal(rev1.id);

  const r1State = queryOne<{ status: string }>(
    'SELECT status FROM initiatives WHERE id = ?',
    [init.id],
  );
  assert.equal(r1State?.status, 'planned');

  // Revert the revert (should land us back at at_risk).
  const acceptedRev1 = getProposal(rev1.id)!;
  const inv2 = invertProposalDiffs(acceptedRev1.proposed_changes).diffs;
  const rev2 = createProposal({
    workspace_id: ws,
    trigger_text: 'rev2',
    trigger_kind: 'revert',
    impact_md: 'rev2',
    proposed_changes: inv2,
    reverts_proposal_id: rev1.id,
  });
  acceptProposal(rev2.id);

  const r2State = queryOne<{ status: string }>(
    'SELECT status FROM initiatives WHERE id = ?',
    [init.id],
  );
  assert.equal(r2State?.status, 'at_risk');
});

// ─── Endpoint smoke (createProposal + invert path matches the route) ──

test('createProposal+revert flow is what the endpoint does', () => {
  // We exercise the same code path as the route handler (without HTTP)
  // to lock in the contract: source must be accepted, response carries
  // the new draft + notes.
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'X' });
  const p = createProposal({
    workspace_id: ws,
    trigger_text: 't',
    impact_md: 'm',
    proposed_changes: [
      { kind: 'set_initiative_status', initiative_id: init.id, status: 'at_risk' },
    ],
  });
  acceptProposal(p.id);

  const accepted = getProposal(p.id)!;
  const { diffs, notes } = invertProposalDiffs(accepted.proposed_changes);
  assert.equal(diffs.length, 1);
  assert.equal(notes[0].status, 'inverted');

  const revert = createProposal({
    workspace_id: ws,
    trigger_text: JSON.stringify({ mode: 'revert', source_proposal_id: p.id }),
    trigger_kind: 'revert',
    impact_md: 'r',
    proposed_changes: diffs,
    reverts_proposal_id: p.id,
  });
  assert.equal(revert.status, 'draft');
  assert.equal(revert.trigger_kind, 'revert');
  assert.equal(revert.reverts_proposal_id, p.id);
});

// ─── Type assertion to silence unused import warning if Initiative
// isn't referenced directly above. ──────────────────────────────────
const _initType: Initiative | null = null;
void _initType;
