/**
 * Full revert semantics for `create_convoy_under_initiative`.
 *
 * Scenarios:
 *   - Happy path: accept a convoy proposal, drive 0 subtasks to done,
 *     revert → convoy 'failed', inbox subtasks deleted, in_progress
 *     subtasks → 'cancelled', parent task left in place, acks deleted.
 *   - Refuse path: any subtask 'done' → cancel_convoy throws
 *     PmProposalValidationError on apply, nothing changes (transaction
 *     rolls back).
 *   - Mid-state: one done + two inbox → refuse; verify inbox tasks were
 *     NOT deleted.
 *   - Back-compat: revert succeeds when the parent task has no acks
 *     recorded (slice-5 surface was skipped).
 *   - Idempotent: revert when convoy is already 'failed' → succeeds,
 *     no-op on the convoy row.
 *   - Schema: cancel_convoy is rejected on non-revert proposals.
 *
 * Mirrors the in-memory DB setup used by `apply-convoy-diff.test.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { createInitiative } from '@/lib/db/initiatives';
import {
  acceptProposal,
  createProposal,
  PmProposalValidationError,
  type PmDiff,
} from '@/lib/db/pm-proposals';
import { invertProposalDiffs } from '@/lib/pm/invertDiff';

function freshWorkspace(): string {
  const id = `ws-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function seedAgent(opts: { workspace: string; role?: string }): string {
  const id = uuidv4();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_active, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 'standby', datetime('now'), datetime('now'))`,
    [id, `Agent-${id.slice(0, 4)}`, opts.role ?? 'builder', opts.workspace],
  );
  return id;
}

function baseSlice(over: Partial<{
  id: string;
  role: string;
  slice: string;
  depends_on: string[];
}> = {}) {
  return {
    id: over.id ?? 'builder',
    role: over.role ?? 'builder',
    slice: over.slice ?? 'Ship the feature end-to-end.',
    message: 'Please honor the parent ACs.',
    expected_deliverables: [{ title: 'Implementation', kind: 'file' as const }],
    acceptance_criteria: ['Operator can click X and observe Y.'],
    expected_duration_minutes: 60,
    ...(over.depends_on ? { depends_on: over.depends_on } : {}),
  };
}

/** Spawn a 3-slice convoy and return everything the tests need to drive
 *  subtask state. Build → Test, Build → Review. */
function acceptThreeSliceConvoy(opts: { ws: string; initId: string }) {
  seedAgent({ workspace: opts.ws, role: 'builder' });
  seedAgent({ workspace: opts.ws, role: 'tester' });
  seedAgent({ workspace: opts.ws, role: 'reviewer' });

  const proposal = createProposal({
    workspace_id: opts.ws,
    trigger_text: '.',
    trigger_kind: 'decompose_story',
    impact_md: '.',
    proposed_changes: [
      {
        kind: 'create_convoy_under_initiative',
        initiative_id: opts.initId,
        parent_acceptance_criteria: [
          'Operator clicks Cancel on any in-flight card → card disappears.',
          'Late agent reply does not resurrect the cancelled card.',
        ],
        slices: [
          baseSlice({ id: 'build', role: 'builder', slice: 'Build slice one.' }),
          baseSlice({ id: 'test', role: 'tester', slice: 'Test the build.', depends_on: ['build'] }),
          baseSlice({ id: 'review', role: 'reviewer', slice: 'Review the build.', depends_on: ['build'] }),
        ],
      },
    ],
  });
  const accepted = acceptProposal(proposal.id);
  return { proposalId: accepted.proposal.id };
}

function getAcceptedProposal(id: string) {
  // Re-load the post-apply diff list (capture state populated).
  const proposal = queryOne<{ proposed_changes: string }>(
    `SELECT proposed_changes FROM pm_proposals WHERE id = ?`,
    [id],
  )!;
  return JSON.parse(proposal.proposed_changes) as PmDiff[];
}

function getChildTaskIds(initiativeId: string): string[] {
  // Subtasks live under parent; their child task rows share the same
  // initiative_id through inheritance. Easiest filter: is_subtask=1.
  const rows = queryAll<{ id: string }>(
    `SELECT t.id FROM tasks t
       JOIN convoy_subtasks cs ON cs.task_id = t.id
       JOIN convoys c ON c.id = cs.convoy_id
       JOIN tasks pt ON pt.id = c.parent_task_id
      WHERE pt.initiative_id = ?
      ORDER BY cs.sort_order`,
    [initiativeId],
  );
  return rows.map((r) => r.id);
}

// ─── Happy path ────────────────────────────────────────────────────

test('cancel_convoy: revert with no done subtasks cancels convoy, deletes inbox children, leaves parent', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'Revertable' });
  const { proposalId } = acceptThreeSliceConvoy({ ws, initId: init.id });

  const parent = queryOne<{ id: string; status: string }>(
    `SELECT id, status FROM tasks WHERE initiative_id = ? AND COALESCE(is_subtask,0)=0`,
    [init.id],
  )!;
  const childIds = getChildTaskIds(init.id);
  assert.equal(childIds.length, 3);

  // Mark build (root) in_progress; leave test + review in inbox.
  // Build is dispatched as the only root; the other two stay inbox via
  // the dep gate.
  run(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`, [childIds[0]]);

  // Drop a fake ack row to verify deletion.
  run(
    `INSERT INTO task_ac_acknowledgements (task_id, ac_index, ac_text, rationale, acknowledged_by, acknowledged_at)
     VALUES (?, 0, 'AC #1', 'lgtm', 'operator', datetime('now'))`,
    [parent.id],
  );
  assert.equal(
    queryAll<{ id: number }>(`SELECT id FROM task_ac_acknowledgements WHERE task_id = ?`, [parent.id]).length,
    1,
  );

  // Build the inverse and apply it through a revert proposal.
  const forward = getAcceptedProposal(proposalId);
  const { diffs, notes } = invertProposalDiffs(forward);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].kind, 'cancel_convoy');
  // Sanity: the inverse note is 'inverted', not 'limited'.
  assert.equal(notes[0].status, 'inverted');

  const revert = createProposal({
    workspace_id: ws,
    trigger_text: 'revert',
    trigger_kind: 'revert',
    impact_md: '.',
    proposed_changes: diffs,
    reverts_proposal_id: proposalId,
  });
  acceptProposal(revert.id);

  // Convoy → 'failed'.
  const convoy = queryOne<{ id: string; status: string }>(
    `SELECT id, status FROM convoys WHERE parent_task_id = ?`,
    [parent.id],
  )!;
  assert.equal(convoy.status, 'failed');

  // Build (in_progress) → 'cancelled'. Test + Review (inbox) → DELETED.
  const buildTask = queryOne<{ id: string; status: string }>(
    `SELECT id, status FROM tasks WHERE id = ?`,
    [childIds[0]],
  );
  assert.ok(buildTask);
  assert.equal(buildTask!.status, 'cancelled');
  for (const inboxId of [childIds[1], childIds[2]]) {
    const t = queryOne<{ id: string }>(`SELECT id FROM tasks WHERE id = ?`, [inboxId]);
    assert.equal(t, undefined, `inbox subtask ${inboxId} should be deleted`);
  }

  // Parent task survives.
  const parentAfter = queryOne<{ id: string; status: string }>(
    `SELECT id, status FROM tasks WHERE id = ?`,
    [parent.id],
  );
  assert.ok(parentAfter, 'parent task must NOT be deleted on revert');

  // Acks gone.
  assert.equal(
    queryAll<{ id: number }>(`SELECT id FROM task_ac_acknowledgements WHERE task_id = ?`, [parent.id]).length,
    0,
  );
});

// ─── Refuse: any done subtask ──────────────────────────────────────

test('cancel_convoy: refuses revert when any subtask is done; transaction rolls back', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'Has-done' });
  const { proposalId } = acceptThreeSliceConvoy({ ws, initId: init.id });

  const childIds = getChildTaskIds(init.id);
  // Flip build to 'done'; leave the other two in inbox.
  run(`UPDATE tasks SET status = 'done' WHERE id = ?`, [childIds[0]]);

  const forward = getAcceptedProposal(proposalId);
  const { diffs } = invertProposalDiffs(forward);
  const revert = createProposal({
    workspace_id: ws,
    trigger_text: 'revert',
    trigger_kind: 'revert',
    impact_md: '.',
    proposed_changes: diffs,
    reverts_proposal_id: proposalId,
  });

  assert.throws(
    () => acceptProposal(revert.id),
    (e: unknown) => {
      assert.ok(e instanceof PmProposalValidationError);
      assert.match((e as Error).message, /already reached 'done'/);
      return true;
    },
  );

  // Nothing changed: convoy still 'active', inbox tasks NOT deleted.
  const convoy = queryOne<{ id: string; status: string }>(
    `SELECT id, status FROM convoys WHERE parent_task_id IN (SELECT id FROM tasks WHERE initiative_id = ?)`,
    [init.id],
  )!;
  assert.equal(convoy.status, 'active');
  for (const inboxId of [childIds[1], childIds[2]]) {
    const t = queryOne<{ id: string; status: string }>(
      `SELECT id, status FROM tasks WHERE id = ?`,
      [inboxId],
    );
    assert.ok(t, `inbox subtask ${inboxId} should still exist after refused revert`);
    assert.equal(t!.status, 'inbox');
  }
});

test('cancel_convoy: refuses even when only one of N subtasks is done', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'Partial done' });
  const { proposalId } = acceptThreeSliceConvoy({ ws, initId: init.id });

  const childIds = getChildTaskIds(init.id);
  // Build done, test in_progress, review inbox — mixed state.
  run(`UPDATE tasks SET status = 'done' WHERE id = ?`, [childIds[0]]);
  run(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`, [childIds[1]]);

  const forward = getAcceptedProposal(proposalId);
  const { diffs } = invertProposalDiffs(forward);
  const revert = createProposal({
    workspace_id: ws,
    trigger_text: 'revert',
    trigger_kind: 'revert',
    impact_md: '.',
    proposed_changes: diffs,
    reverts_proposal_id: proposalId,
  });

  assert.throws(() => acceptProposal(revert.id), PmProposalValidationError);

  // The in_progress + inbox tasks must still exist (transaction rolled back).
  const inProg = queryOne<{ status: string }>(
    `SELECT status FROM tasks WHERE id = ?`,
    [childIds[1]],
  );
  assert.equal(inProg?.status, 'in_progress');
  const review = queryOne<{ status: string }>(
    `SELECT status FROM tasks WHERE id = ?`,
    [childIds[2]],
  );
  assert.equal(review?.status, 'inbox');
});

// ─── Back-compat: no acks recorded ────────────────────────────────

test('cancel_convoy: succeeds when parent task has no AC acknowledgements recorded', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'No-acks' });
  const { proposalId } = acceptThreeSliceConvoy({ ws, initId: init.id });

  const parent = queryOne<{ id: string }>(
    `SELECT id FROM tasks WHERE initiative_id = ? AND COALESCE(is_subtask,0)=0`,
    [init.id],
  )!;

  // No insert into task_ac_acknowledgements at all.
  assert.equal(
    queryAll<{ id: number }>(`SELECT id FROM task_ac_acknowledgements WHERE task_id = ?`, [parent.id]).length,
    0,
  );

  const forward = getAcceptedProposal(proposalId);
  const { diffs } = invertProposalDiffs(forward);
  const revert = createProposal({
    workspace_id: ws,
    trigger_text: 'revert',
    trigger_kind: 'revert',
    impact_md: '.',
    proposed_changes: diffs,
    reverts_proposal_id: proposalId,
  });
  // Should not throw.
  acceptProposal(revert.id);

  const convoy = queryOne<{ status: string }>(
    `SELECT status FROM convoys WHERE parent_task_id = ?`,
    [parent.id],
  )!;
  assert.equal(convoy.status, 'failed');
});

// ─── Idempotent: convoy already cancelled ─────────────────────────

test('cancel_convoy: idempotent when convoy already failed', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'Already failed' });
  const { proposalId } = acceptThreeSliceConvoy({ ws, initId: init.id });

  const parent = queryOne<{ id: string }>(
    `SELECT id FROM tasks WHERE initiative_id = ? AND COALESCE(is_subtask,0)=0`,
    [init.id],
  )!;
  // Pre-cancel the convoy via another path.
  run(`UPDATE convoys SET status = 'failed' WHERE parent_task_id = ?`, [parent.id]);

  const forward = getAcceptedProposal(proposalId);
  const { diffs } = invertProposalDiffs(forward);
  const revert = createProposal({
    workspace_id: ws,
    trigger_text: 'revert',
    trigger_kind: 'revert',
    impact_md: '.',
    proposed_changes: diffs,
    reverts_proposal_id: proposalId,
  });
  acceptProposal(revert.id); // no throw

  const convoy = queryOne<{ status: string }>(
    `SELECT status FROM convoys WHERE parent_task_id = ?`,
    [parent.id],
  )!;
  assert.equal(convoy.status, 'failed');
});

// ─── Schema: cancel_convoy is revert-only ─────────────────────────

test('cancel_convoy: rejected by validator on non-revert proposals', () => {
  const ws = freshWorkspace();
  // Need at least a valid convoy_id / parent_task_id in the diff
  // shape, but the validator should reject on trigger_kind alone before
  // looking at the refs.
  assert.throws(
    () =>
      createProposal({
        workspace_id: ws,
        trigger_text: '.',
        trigger_kind: 'manual',
        impact_md: '.',
        proposed_changes: [
          {
            kind: 'cancel_convoy',
            convoy_id: 'nonexistent',
            parent_task_id: 'nonexistent',
            subtask_child_task_ids: [],
          },
        ],
      }),
    (e: unknown) => {
      assert.ok(e instanceof PmProposalValidationError);
      assert.match((e as Error).message, /Invalid proposed_changes/);
      return true;
    },
  );
});

// ─── Pre-capture: missing convoy_id surfaces as 'limited' ─────────

test('invertProposalDiffs: returns limited when capture state is missing', () => {
  // Simulate a pre-capture / partial-apply proposal where the create
  // diff didn't record created_convoy_id.
  const forward: PmDiff[] = [
    {
      kind: 'create_convoy_under_initiative',
      initiative_id: 'init-x',
      parent_acceptance_criteria: ['x'.repeat(15)],
      slices: [],
      // no created_convoy_id / created_parent_task_id
    } as unknown as PmDiff,
  ];
  const { diffs, notes } = invertProposalDiffs(forward);
  assert.equal(diffs.length, 0);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].status, 'limited');
  assert.match(notes[0].reason ?? '', /pre-capture/);
});
