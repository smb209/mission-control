/**
 * Apply-pass for `create_convoy_under_initiative` (PM convoy mandate slice 2).
 *
 *   - Happy path: a single-slice convoy materializes with parent ACs on
 *     the convoys row and a root subtask ready for dispatch.
 *   - Multi-slice DAG: 3 slices, A → B,C. Topological order respected;
 *     B and C carry depends_on pointing at A's subtask id.
 *   - Initiative placeholder: a `create_child_initiative` + a
 *     `create_convoy_under_initiative` referencing `$0` both materialize.
 *   - Find-or-create parent: a story initiative without an existing
 *     task gets one auto-created and the convoy attaches to it.
 *   - Atomic fail — cycle: apply rejects; no convoy row, no tasks.
 *   - Atomic fail — unknown depends_on: same.
 *   - ACs persisted as JSON-encoded array on `convoys.acceptance_criteria`.
 *
 * Dispatch firing in the apply path is fire-and-forget (loopback fetch
 * that nothing answers in tests); these tests assert state up to the
 * INSERTed rows, not the dispatched HTTP call.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { createInitiative } from './initiatives';
import {
  createProposal,
  acceptProposal,
  PmProposalValidationError,
  type PmDiff,
} from './pm-proposals';

function freshWorkspace(): string {
  const id = `ws-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function seedAgent(opts: { workspace: string; role?: string; name?: string } ): string {
  const id = uuidv4();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_active, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 'standby', datetime('now'), datetime('now'))`,
    [id, opts.name ?? `Agent-${id.slice(0, 4)}`, opts.role ?? 'builder', opts.workspace],
  );
  return id;
}

function baseSlice(over: Partial<{
  id: string;
  role: string;
  slice: string;
  message: string;
  depends_on: string[];
}> = {}) {
  return {
    id: over.id ?? 'builder',
    role: over.role ?? 'builder',
    slice: over.slice ?? 'Build the feature end-to-end.',
    message: over.message ?? 'Please ship the feature; honor the parent ACs.',
    expected_deliverables: [{ title: 'Implementation', kind: 'file' as const }],
    acceptance_criteria: ['Operator can click X and observe Y.'],
    expected_duration_minutes: 60,
    ...(over.depends_on ? { depends_on: over.depends_on } : {}),
  };
}

// ─── Happy path ────────────────────────────────────────────────────

test('create_convoy_under_initiative: single-slice happy path materializes convoy + subtask', () => {
  const ws = freshWorkspace();
  seedAgent({ workspace: ws, role: 'builder' });
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'Ship feature' });

  const proposal = createProposal({
    workspace_id: ws,
    trigger_text: 'decompose this story',
    trigger_kind: 'decompose_story',
    impact_md: '.',
    proposed_changes: [
      {
        kind: 'create_convoy_under_initiative',
        initiative_id: init.id,
        parent_acceptance_criteria: [
          'Operator can click X and observe Y end-to-end.',
        ],
        slices: [baseSlice()],
      },
    ],
  });

  const r = acceptProposal(proposal.id);
  assert.equal(r.changes_applied, 1);
  assert.equal(r.proposal.status, 'accepted');

  // Parent task auto-created (story initiative had no prior task).
  const parent = queryOne<{ id: string; status: string; initiative_id: string }>(
    `SELECT id, status, initiative_id FROM tasks WHERE initiative_id = ? AND COALESCE(is_subtask, 0) = 0`,
    [init.id],
  );
  assert.ok(parent, 'parent task should exist');
  assert.equal(parent!.initiative_id, init.id);
  // spawnDelegationSubtask flips parent into convoy_active on first spawn.
  assert.equal(parent!.status, 'convoy_active');

  // Convoy row carries the ACs as JSON.
  const convoy = queryOne<{ id: string; acceptance_criteria: string | null; total_subtasks: number }>(
    `SELECT id, acceptance_criteria, total_subtasks FROM convoys WHERE parent_task_id = ?`,
    [parent!.id],
  );
  assert.ok(convoy, 'convoy row should exist');
  assert.equal(convoy!.total_subtasks, 1);
  assert.ok(convoy!.acceptance_criteria, 'parent ACs persisted');
  const acs = JSON.parse(convoy!.acceptance_criteria!) as string[];
  assert.deepEqual(acs, ['Operator can click X and observe Y end-to-end.']);

  // Subtask row exists with proper SLO fields.
  const subtasks = queryAll<{ id: string; slice: string; depends_on: string | null }>(
    `SELECT id, slice, depends_on FROM convoy_subtasks WHERE convoy_id = ?`,
    [convoy!.id],
  );
  assert.equal(subtasks.length, 1);
  assert.equal(subtasks[0].depends_on, null, 'root slice has no deps');
});

// ─── Multi-slice DAG ───────────────────────────────────────────────

test('create_convoy_under_initiative: multi-slice DAG resolves depends_on into subtask uuids', () => {
  const ws = freshWorkspace();
  seedAgent({ workspace: ws, role: 'builder' });
  seedAgent({ workspace: ws, role: 'tester' });
  seedAgent({ workspace: ws, role: 'reviewer' });
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'Multi-slice' });

  const proposal = createProposal({
    workspace_id: ws,
    trigger_text: '.',
    trigger_kind: 'decompose_story',
    impact_md: '.',
    proposed_changes: [
      {
        kind: 'create_convoy_under_initiative',
        initiative_id: init.id,
        parent_acceptance_criteria: ['Feature ships green.'],
        slices: [
          baseSlice({ id: 'build', role: 'builder', slice: 'Build slice one.' }),
          baseSlice({ id: 'test', role: 'tester', slice: 'Test the build.', depends_on: ['build'] }),
          baseSlice({ id: 'review', role: 'reviewer', slice: 'Review the build.', depends_on: ['build'] }),
        ],
      },
    ],
  });

  acceptProposal(proposal.id);

  const parent = queryOne<{ id: string }>(
    `SELECT id FROM tasks WHERE initiative_id = ? AND COALESCE(is_subtask, 0) = 0`,
    [init.id],
  )!;
  const convoy = queryOne<{ id: string; total_subtasks: number }>(
    `SELECT id, total_subtasks FROM convoys WHERE parent_task_id = ?`,
    [parent.id],
  )!;
  assert.equal(convoy.total_subtasks, 3);

  const rows = queryAll<{
    id: string;
    slice: string;
    depends_on: string | null;
    sort_order: number;
    task_id: string;
  }>(
    `SELECT id, slice, depends_on, sort_order, task_id FROM convoy_subtasks WHERE convoy_id = ? ORDER BY sort_order`,
    [convoy.id],
  );
  assert.equal(rows.length, 3);

  // The root (build) has no deps; the other two each depend on it.
  const build = rows.find((r) => r.slice.includes('one'))!;
  const test_ = rows.find((r) => r.slice.includes('Test'))!;
  const review = rows.find((r) => r.slice.includes('Review'))!;
  assert.equal(build.depends_on, null);
  const testDeps = JSON.parse(test_.depends_on!) as string[];
  const reviewDeps = JSON.parse(review.depends_on!) as string[];
  assert.deepEqual(testDeps, [build.id]);
  assert.deepEqual(reviewDeps, [build.id]);

  // Dependents stay in inbox until build is done (the dep gate from PR #344).
  const testTaskStatus = queryOne<{ status: string }>(
    `SELECT status FROM tasks WHERE id = ?`,
    [test_.task_id],
  )!;
  assert.equal(testTaskStatus.status, 'inbox');
});

// ─── Initiative placeholder ($N) ───────────────────────────────────

test('create_convoy_under_initiative: resolves $N placeholder against same-proposal create_child_initiative', () => {
  const ws = freshWorkspace();
  seedAgent({ workspace: ws, role: 'builder' });
  const parentInit = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Epic parent' });

  const proposal = createProposal({
    workspace_id: ws,
    trigger_text: '.',
    trigger_kind: 'decompose_initiative',
    impact_md: '.',
    proposed_changes: [
      {
        kind: 'create_child_initiative',
        parent_initiative_id: parentInit.id,
        title: 'Child story',
        child_kind: 'story',
      },
      {
        kind: 'create_convoy_under_initiative',
        initiative_id: '$0',
        parent_acceptance_criteria: ['Child ships.'],
        slices: [baseSlice()],
      },
    ],
  });

  acceptProposal(proposal.id);

  // Child initiative materialized.
  const child = queryOne<{ id: string; title: string }>(
    `SELECT id, title FROM initiatives WHERE parent_initiative_id = ?`,
    [parentInit.id],
  );
  assert.ok(child);
  assert.equal(child!.title, 'Child story');

  // Parent task attached to the new child initiative.
  const parentTask = queryOne<{ id: string; initiative_id: string }>(
    `SELECT id, initiative_id FROM tasks WHERE initiative_id = ? AND COALESCE(is_subtask, 0) = 0`,
    [child!.id],
  );
  assert.ok(parentTask);
  // Convoy attached.
  const convoy = queryOne<{ id: string }>(
    `SELECT id FROM convoys WHERE parent_task_id = ?`,
    [parentTask!.id],
  );
  assert.ok(convoy);
});

// ─── Find-or-create parent task ────────────────────────────────────

test('create_convoy_under_initiative: auto-creates parent task for story initiative without one', () => {
  const ws = freshWorkspace();
  seedAgent({ workspace: ws, role: 'builder' });
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'No task yet' });

  // Sanity: no parent task exists.
  const before = queryAll<{ id: string }>(
    `SELECT id FROM tasks WHERE initiative_id = ?`,
    [init.id],
  );
  assert.equal(before.length, 0);

  const proposal = createProposal({
    workspace_id: ws,
    trigger_text: '.',
    trigger_kind: 'decompose_story',
    impact_md: '.',
    proposed_changes: [
      {
        kind: 'create_convoy_under_initiative',
        initiative_id: init.id,
        parent_acceptance_criteria: ['Done means done.'],
        slices: [baseSlice()],
      },
    ],
  });

  acceptProposal(proposal.id);

  const parent = queryOne<{ id: string; title: string; status: string }>(
    `SELECT id, title, status FROM tasks WHERE initiative_id = ? AND COALESCE(is_subtask, 0) = 0`,
    [init.id],
  );
  assert.ok(parent, 'parent task auto-created from story initiative');
  assert.equal(parent!.title, 'No task yet');
});

// ─── Atomic fail: cycle ────────────────────────────────────────────

test('create_convoy_under_initiative: rejects DAG cycle and leaves DB untouched', () => {
  const ws = freshWorkspace();
  seedAgent({ workspace: ws, role: 'builder' });
  seedAgent({ workspace: ws, role: 'tester' });
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'Cycle' });

  // createProposal's structural validator doesn't catch cycles (it only
  // checks unknown refs); the apply pass surfaces them via
  // validateConvoyDag. Build a 2-slice loop and ensure no writes leak.
  const cycle: Extract<PmDiff, { kind: 'create_convoy_under_initiative' }> = {
    kind: 'create_convoy_under_initiative',
    initiative_id: init.id,
    parent_acceptance_criteria: ['Never reached.'],
    slices: [
      { ...baseSlice({ id: 'a', role: 'builder' }), depends_on: ['b'] },
      { ...baseSlice({ id: 'b', role: 'tester' }), depends_on: ['a'] },
    ],
  };

  const proposal = createProposal({
    workspace_id: ws,
    trigger_text: '.',
    trigger_kind: 'decompose_story',
    impact_md: '.',
    proposed_changes: [cycle],
  });

  assert.throws(() => acceptProposal(proposal.id), PmProposalValidationError);

  // No convoy, no subtasks, no parent task.
  const convoys = queryAll<{ id: string }>(
    `SELECT id FROM convoys WHERE parent_task_id IN (SELECT id FROM tasks WHERE initiative_id = ?)`,
    [init.id],
  );
  assert.equal(convoys.length, 0, 'cycle must roll back convoy insert');
  const tasks = queryAll<{ id: string }>(
    `SELECT id FROM tasks WHERE initiative_id = ?`,
    [init.id],
  );
  assert.equal(tasks.length, 0, 'cycle must roll back parent-task auto-create');
});

// ─── Atomic fail: unknown depends_on ──────────────────────────────

test('create_convoy_under_initiative: rejects unknown depends_on ref at proposal-create time', () => {
  const ws = freshWorkspace();
  seedAgent({ workspace: ws, role: 'builder' });
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'Bad ref' });

  assert.throws(
    () =>
      createProposal({
        workspace_id: ws,
        trigger_text: '.',
        trigger_kind: 'decompose_story',
        impact_md: '.',
        proposed_changes: [
          {
            kind: 'create_convoy_under_initiative',
            initiative_id: init.id,
            parent_acceptance_criteria: ['x'.repeat(15)],
            slices: [
              { ...baseSlice(), depends_on: ['no-such-slice'] },
            ],
          },
        ],
      }),
    PmProposalValidationError,
  );
});

// ─── ACs persisted exactly ─────────────────────────────────────────

test('create_convoy_under_initiative: parent ACs persist as JSON-encoded string array', () => {
  const ws = freshWorkspace();
  seedAgent({ workspace: ws, role: 'builder' });
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'ACs' });

  const acs = [
    'Operator clicks Cancel on any in-flight proposal card and the card disappears.',
    'A late agent reply does not resurrect the cancelled card.',
  ];

  const proposal = createProposal({
    workspace_id: ws,
    trigger_text: '.',
    trigger_kind: 'decompose_story',
    impact_md: '.',
    proposed_changes: [
      {
        kind: 'create_convoy_under_initiative',
        initiative_id: init.id,
        parent_acceptance_criteria: acs,
        slices: [baseSlice()],
      },
    ],
  });

  acceptProposal(proposal.id);

  const convoy = queryOne<{ acceptance_criteria: string | null }>(
    `SELECT c.acceptance_criteria FROM convoys c
       JOIN tasks t ON t.id = c.parent_task_id
      WHERE t.initiative_id = ?`,
    [init.id],
  )!;
  assert.ok(convoy.acceptance_criteria);
  assert.deepEqual(JSON.parse(convoy.acceptance_criteria!), acs);
});
