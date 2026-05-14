/**
 * PM convoy mandate (slice 6/7) — schema-level rejection of
 * `create_task_under_initiative` in decompose-flow proposals when
 * `MC_PM_CONVOY_MANDATE=1`.
 *
 * Asserts only the trigger_kind ↔ allowed-diff-kinds matrix from
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

function withMandate<T>(on: boolean, fn: () => T): T {
  const prev = process.env.MC_PM_CONVOY_MANDATE;
  if (on) process.env.MC_PM_CONVOY_MANDATE = '1';
  else delete process.env.MC_PM_CONVOY_MANDATE;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.MC_PM_CONVOY_MANDATE;
    else process.env.MC_PM_CONVOY_MANDATE = prev;
  }
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

// ─── mandate OFF: back-compat baseline ─────────────────────────────

test('mandate OFF: flat-task diff under decompose_story is allowed', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Cancel feature' });
  const errors = withMandate(false, () =>
    validateProposedChanges(ws, [makeFlatTaskDiff(init.id)], {
      trigger_kind: 'decompose_story',
    }),
  );
  assert.deepEqual(errors, [], 'back-compat: mandate OFF must permit flat-task decompose output');
});

// ─── mandate ON: decompose flows rejected ──────────────────────────

test('mandate ON: flat-task diff under decompose_story is REJECTED', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Cancel feature' });
  const errors = withMandate(true, () =>
    validateProposedChanges(ws, [makeFlatTaskDiff(init.id)], {
      trigger_kind: 'decompose_story',
    }),
  );
  assert.ok(errors.length > 0, 'expected at least one error');
  assert.ok(
    errors.some((e) => e.includes('MC_PM_CONVOY_MANDATE') && e.includes('create_task_under_initiative')),
    `expected mandate violation, got: ${errors.join(' | ')}`,
  );
});

test('mandate ON: flat-task diff under decompose_initiative is REJECTED', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'X' });
  const errors = withMandate(true, () =>
    validateProposedChanges(ws, [makeFlatTaskDiff(init.id)], {
      trigger_kind: 'decompose_initiative',
    }),
  );
  assert.ok(errors.some((e) => e.includes('MC_PM_CONVOY_MANDATE')));
});

test('mandate ON: flat-task diff under plan_initiative is REJECTED', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'X' });
  const errors = withMandate(true, () =>
    validateProposedChanges(ws, [makeFlatTaskDiff(init.id)], {
      trigger_kind: 'plan_initiative',
    }),
  );
  assert.ok(errors.some((e) => e.includes('MC_PM_CONVOY_MANDATE')));
});

// ─── mandate ON: carve-outs preserved ──────────────────────────────

test('mandate ON: flat-task diff under notes_intake is ALLOWED (carve-out)', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'X' });
  const errors = withMandate(true, () =>
    validateProposedChanges(ws, [makeFlatTaskDiff(init.id)], {
      trigger_kind: 'notes_intake',
    }),
  );
  assert.deepEqual(errors, []);
});

test('mandate ON: flat-task diff under manual is ALLOWED (carve-out)', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'X' });
  const errors = withMandate(true, () =>
    validateProposedChanges(ws, [makeFlatTaskDiff(init.id)], {
      trigger_kind: 'manual',
    }),
  );
  assert.deepEqual(errors, []);
});

// ─── mandate ON: convoy diffs accepted ─────────────────────────────

test('mandate ON: decompose_story with only convoy diffs is ALLOWED', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Cancel feature' });
  const errors = withMandate(true, () =>
    validateProposedChanges(ws, [makeConvoyDiff(init.id)], {
      trigger_kind: 'decompose_story',
    }),
  );
  assert.deepEqual(errors, [], `expected no errors, got: ${errors.join(' | ')}`);
});

test('mandate ON: decompose_story with convoy + child-initiative is ALLOWED', () => {
  const ws = freshWorkspace();
  const parent = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Parent' });
  const errors = withMandate(true, () =>
    validateProposedChanges(
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
    ),
  );
  assert.deepEqual(errors, [], `expected no errors, got: ${errors.join(' | ')}`);
});

test('mandate ON: decompose_story with ZERO convoy diffs is REJECTED', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'X' });
  const errors = withMandate(true, () =>
    validateProposedChanges(
      ws,
      [
        {
          kind: 'set_initiative_status',
          initiative_id: init.id,
          status: 'at_risk',
        } as PmDiff,
      ],
      { trigger_kind: 'decompose_story' },
    ),
  );
  assert.ok(
    errors.some((e) => e.includes('MC_PM_CONVOY_MANDATE') && e.includes('at least one')),
    `expected missing-convoy error, got: ${errors.join(' | ')}`,
  );
});
