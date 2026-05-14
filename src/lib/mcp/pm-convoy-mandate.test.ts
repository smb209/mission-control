/**
 * PM convoy mandate — schema-level rejection of
 * `create_task_under_initiative` in decompose-flow proposals.
 *
 * The mandate is unconditional as of 2026-05-14 (the
 * `MC_PM_CONVOY_MANDATE` feature flag was removed once slices 1–7
 * shipped and verified end-to-end).
 *
 * Asserts the trigger_kind ↔ allowed-diff-kinds matrix from
 * docs/reference/pm-convoy-mandate.md (the "Carve-outs" table). DAG
 * structural validity is covered by diff-schema.test.ts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import {
  validateProposedChanges,
  type PmDiff,
} from '@/lib/db/pm-proposals';
import { createInitiative } from '@/lib/db/initiatives';

function freshWorkspace(): string {
  const id = `ws-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function makeFlatTaskDiff(initiativeId: string): PmDiff {
  return {
    kind: 'create_task_under_initiative',
    initiative_id: initiativeId,
    title: 'Wire up the cancel endpoint',
  } as PmDiff;
}

function makeConvoyDiff(initiativeId: string): PmDiff {
  return {
    kind: 'create_convoy_under_initiative',
    initiative_id: initiativeId,
    parent_acceptance_criteria: [
      'Operator clicks Cancel on any in-flight proposal card and the card disappears.',
    ],
    slices: [
      {
        id: 'slice_a',
        role: 'builder',
        slice: 'Build the cancel endpoint and wire it through.',
        message: 'Implement and ship the cancel endpoint per the AC list.',
        expected_deliverables: [{ title: 'cancel route handler', kind: 'file' }],
        acceptance_criteria: ['Endpoint returns 200 on a valid cancel request body.'],
        expected_duration_minutes: 60,
      },
    ],
  } as PmDiff;
}

// ─── decompose flows: flat-task diffs rejected ─────────────────────

test('flat-task diff under decompose_story is REJECTED', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Cancel feature' });
  const errors = validateProposedChanges(ws, [makeFlatTaskDiff(init.id)], {
    trigger_kind: 'decompose_story',
  });
  assert.ok(errors.length > 0, 'expected at least one error');
  assert.ok(
    errors.some((e) => e.includes('pm-convoy-mandate') && e.includes('create_task_under_initiative')),
    `expected mandate violation, got: ${errors.join(' | ')}`,
  );
});

test('flat-task diff under decompose_initiative is REJECTED', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'X' });
  const errors = validateProposedChanges(ws, [makeFlatTaskDiff(init.id)], {
    trigger_kind: 'decompose_initiative',
  });
  assert.ok(errors.some((e) => e.includes('pm-convoy-mandate')));
});

test('flat-task diff under plan_initiative is REJECTED', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'X' });
  const errors = validateProposedChanges(ws, [makeFlatTaskDiff(init.id)], {
    trigger_kind: 'plan_initiative',
  });
  assert.ok(errors.some((e) => e.includes('pm-convoy-mandate')));
});

// ─── carve-outs preserved ──────────────────────────────────────────

test('flat-task diff under notes_intake is ALLOWED (carve-out)', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'X' });
  const errors = validateProposedChanges(ws, [makeFlatTaskDiff(init.id)], {
    trigger_kind: 'notes_intake',
  });
  assert.deepEqual(errors, []);
});

test('flat-task diff under manual is ALLOWED (carve-out)', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'X' });
  const errors = validateProposedChanges(ws, [makeFlatTaskDiff(init.id)], {
    trigger_kind: 'manual',
  });
  assert.deepEqual(errors, []);
});

// ─── convoy diffs accepted ─────────────────────────────────────────

test('decompose_story with only convoy diffs is ALLOWED', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Cancel feature' });
  const errors = validateProposedChanges(ws, [makeConvoyDiff(init.id)], {
    trigger_kind: 'decompose_story',
  });
  assert.deepEqual(errors, [], `expected no errors, got: ${errors.join(' | ')}`);
});

test('decompose_story with convoy + child-initiative is ALLOWED', () => {
  const ws = freshWorkspace();
  const parent = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Parent' });
  const errors = validateProposedChanges(
    ws,
    [
      {
        kind: 'create_child_initiative',
        parent_initiative_id: parent.id,
        title: 'Child story',
        child_kind: 'story',
      } as PmDiff,
      makeConvoyDiff('$0'),
    ],
    { trigger_kind: 'decompose_story' },
  );
  assert.deepEqual(errors, [], `expected no errors, got: ${errors.join(' | ')}`);
});

test('decompose_story with ZERO task-creating diffs is ALLOWED (no task → no convoy required)', () => {
  // Purely structural decompositions (status-only, child-initiative-only)
  // bypass the convoy requirement. The mandate only fires when a flat
  // create_task_under_initiative diff is present.
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'X' });
  const errors = validateProposedChanges(
    ws,
    [
      {
        kind: 'set_initiative_status',
        initiative_id: init.id,
        status: 'at_risk',
      } as PmDiff,
    ],
    { trigger_kind: 'decompose_story' },
  );
  assert.deepEqual(errors, [], `expected no errors for non-task-creating decompose, got: ${errors.join(' | ')}`);
});

test('decompose_initiative with only create_child_initiative diffs is ALLOWED (initiative-tree decomposition)', () => {
  // Mirrors the synthesizeDecompose fallback path: PM (or synth) emits
  // child-initiative stubs to structure the roadmap. No tasks → no convoy
  // required. The mandate is about task-level work granularity.
  const ws = freshWorkspace();
  const parent = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Parent epic' });
  const errors = validateProposedChanges(
    ws,
    [
      {
        kind: 'create_child_initiative',
        parent_initiative_id: parent.id,
        title: 'Foundation',
        child_kind: 'story',
      } as PmDiff,
      {
        kind: 'create_child_initiative',
        parent_initiative_id: parent.id,
        title: 'Build on top',
        child_kind: 'story',
      } as PmDiff,
    ],
    { trigger_kind: 'decompose_initiative' },
  );
  assert.deepEqual(errors, [], `expected no errors for child-initiative-only decompose, got: ${errors.join(' | ')}`);
});
