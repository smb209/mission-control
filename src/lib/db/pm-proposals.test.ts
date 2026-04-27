/**
 * PM proposal DB-helper tests (Phase 5).
 *
 * Coverage:
 *   - Create + get + list with filters.
 *   - acceptProposal applies all 7 diff kinds correctly.
 *   - Validation rejects bad references without partial writes.
 *   - Refine creates a child + supersedes parent.
 *   - Reject is idempotent and leaves the DB untouched.
 *   - Idempotency: re-accepting an already-accepted proposal is a no-op.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import {
  createProposal,
  getProposal,
  listProposals,
  acceptProposal,
  rejectProposal,
  refineProposal,
  validateProposedChanges,
  PmProposalValidationError,
  type PmDiff,
} from './pm-proposals';
import { createInitiative, addInitiativeDependency } from './initiatives';

function seedAgent(workspace: string = 'default'): string {
  const id = uuidv4();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_active, created_at, updated_at)
     VALUES (?, 'A', 'worker', ?, 1, datetime('now'), datetime('now'))`,
    [id, workspace],
  );
  return id;
}

function freshWorkspace(): string {
  const id = `ws-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

// ─── createProposal / getProposal / listProposals ──────────────────

test('createProposal stores impact_md + parses changes round-trip', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Build X' });
  const p = createProposal({
    workspace_id: ws,
    trigger_text: 'Sarah out next week',
    impact_md: '### Headline\n\n- thing',
    proposed_changes: [
      { kind: 'set_initiative_status', initiative_id: init.id, status: 'at_risk' },
    ],
  });
  assert.equal(p.workspace_id, ws);
  assert.equal(p.status, 'draft');
  assert.equal(p.proposed_changes.length, 1);
  assert.equal(p.proposed_changes[0].kind, 'set_initiative_status');
});

test('createProposal rejects diffs that reference unknown initiatives', () => {
  const ws = freshWorkspace();
  assert.throws(
    () =>
      createProposal({
        workspace_id: ws,
        trigger_text: 't',
        impact_md: 'i',
        proposed_changes: [
          { kind: 'set_initiative_status', initiative_id: 'does-not-exist', status: 'blocked' },
        ],
      }),
    PmProposalValidationError,
  );
});

test('listProposals filters by workspace + status', () => {
  const wsA = freshWorkspace();
  const wsB = freshWorkspace();
  createProposal({ workspace_id: wsA, trigger_text: 'a', impact_md: '.', proposed_changes: [] });
  const pB = createProposal({ workspace_id: wsB, trigger_text: 'b', impact_md: '.', proposed_changes: [] });
  rejectProposal(pB.id);

  const drafts = listProposals({ workspace_id: wsA, status: 'draft' });
  assert.ok(drafts.every(p => p.workspace_id === wsA && p.status === 'draft'));
  assert.equal(drafts.length, 1);

  const rejected = listProposals({ workspace_id: wsB, status: 'rejected' });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].id, pB.id);
});

// ─── acceptProposal: each diff kind applies correctly ──────────────

test('acceptProposal: shift_initiative_target updates target_start/target_end', () => {
  const ws = freshWorkspace();
  const init = createInitiative({
    workspace_id: ws,
    kind: 'milestone',
    title: 'Launch',
    target_end: '2026-05-01',
  });
  const p = createProposal({
    workspace_id: ws,
    trigger_text: '...',
    impact_md: '.',
    proposed_changes: [
      { kind: 'shift_initiative_target', initiative_id: init.id, target_end: '2026-05-15' },
    ],
  });
  const result = acceptProposal(p.id);
  assert.equal(result.changes_applied, 1);
  const after = queryOne<{ target_end: string }>(
    'SELECT target_end FROM initiatives WHERE id = ?',
    [init.id],
  );
  assert.equal(after?.target_end, '2026-05-15');
  // Status flipped to accepted with timestamp.
  assert.equal(result.proposal.status, 'accepted');
  assert.ok(result.proposal.applied_at);
});

test('acceptProposal: add_availability inserts an owner_availability row', () => {
  const ws = freshWorkspace();
  const ag = seedAgent(ws);
  const p = createProposal({
    workspace_id: ws,
    trigger_text: '...',
    impact_md: '.',
    proposed_changes: [
      { kind: 'add_availability', agent_id: ag, start: '2026-05-01', end: '2026-05-05' },
    ],
  });
  acceptProposal(p.id);
  const rows = queryAll<{ id: string; agent_id: string }>(
    'SELECT id, agent_id FROM owner_availability WHERE agent_id = ?',
    [ag],
  );
  assert.equal(rows.length, 1);
});

test('acceptProposal: set_initiative_status flips status', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'S' });
  const p = createProposal({
    workspace_id: ws,
    trigger_text: '...',
    impact_md: '.',
    proposed_changes: [{ kind: 'set_initiative_status', initiative_id: init.id, status: 'at_risk' }],
  });
  acceptProposal(p.id);
  const after = queryOne<{ status: string }>('SELECT status FROM initiatives WHERE id = ?', [init.id]);
  assert.equal(after?.status, 'at_risk');
});

test('acceptProposal rejects done/cancelled status (PM never marks done)', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'S' });
  assert.throws(
    () => createProposal({
      workspace_id: ws,
      trigger_text: '.',
      impact_md: '.',
      // done is not in the PM-allowed enum at the type level — cast for the test.
      proposed_changes: [
        { kind: 'set_initiative_status', initiative_id: init.id, status: 'done' as never },
      ],
    }),
    PmProposalValidationError,
  );
});

test('acceptProposal: add_dependency inserts row, dup is idempotent', () => {
  const ws = freshWorkspace();
  const a = createInitiative({ workspace_id: ws, kind: 'epic', title: 'A' });
  const b = createInitiative({ workspace_id: ws, kind: 'epic', title: 'B' });
  const p = createProposal({
    workspace_id: ws,
    trigger_text: '.',
    impact_md: '.',
    proposed_changes: [
      { kind: 'add_dependency', initiative_id: a.id, depends_on_initiative_id: b.id, note: 'x' },
    ],
  });
  acceptProposal(p.id);
  const rows = queryAll(
    'SELECT id FROM initiative_dependencies WHERE initiative_id = ? AND depends_on_initiative_id = ?',
    [a.id, b.id],
  );
  assert.equal(rows.length, 1);

  // Apply a duplicate via a fresh proposal — the add should swallow the
  // UNIQUE violation and the count stays 1.
  const p2 = createProposal({
    workspace_id: ws,
    trigger_text: '.',
    impact_md: '.',
    proposed_changes: [
      { kind: 'add_dependency', initiative_id: a.id, depends_on_initiative_id: b.id },
    ],
  });
  const r2 = acceptProposal(p2.id);
  assert.equal(r2.changes_applied, 1);
  const rows2 = queryAll(
    'SELECT id FROM initiative_dependencies WHERE initiative_id = ? AND depends_on_initiative_id = ?',
    [a.id, b.id],
  );
  assert.equal(rows2.length, 1);
});

test('acceptProposal: remove_dependency deletes the row', () => {
  const ws = freshWorkspace();
  const a = createInitiative({ workspace_id: ws, kind: 'epic', title: 'A' });
  const b = createInitiative({ workspace_id: ws, kind: 'epic', title: 'B' });
  const dep = addInitiativeDependency({
    initiative_id: a.id,
    depends_on_initiative_id: b.id,
  });
  const p = createProposal({
    workspace_id: ws,
    trigger_text: '.',
    impact_md: '.',
    proposed_changes: [{ kind: 'remove_dependency', dependency_id: dep.id }],
  });
  acceptProposal(p.id);
  const exists = queryOne('SELECT id FROM initiative_dependencies WHERE id = ?', [dep.id]);
  assert.equal(exists, undefined);
});

test('acceptProposal: reorder_initiatives sets sort_order in array order', () => {
  const ws = freshWorkspace();
  const parent = createInitiative({ workspace_id: ws, kind: 'epic', title: 'P' });
  const c1 = createInitiative({ workspace_id: ws, kind: 'story', title: 'C1', parent_initiative_id: parent.id });
  const c2 = createInitiative({ workspace_id: ws, kind: 'story', title: 'C2', parent_initiative_id: parent.id });
  const c3 = createInitiative({ workspace_id: ws, kind: 'story', title: 'C3', parent_initiative_id: parent.id });
  const p = createProposal({
    workspace_id: ws,
    trigger_text: '.',
    impact_md: '.',
    proposed_changes: [
      { kind: 'reorder_initiatives', parent_id: parent.id, child_ids_in_order: [c3.id, c1.id, c2.id] },
    ],
  });
  acceptProposal(p.id);
  const orders = new Map<string, number>();
  for (const r of queryAll<{ id: string; sort_order: number }>(
    'SELECT id, sort_order FROM initiatives WHERE id IN (?, ?, ?)',
    [c1.id, c2.id, c3.id],
  )) {
    orders.set(r.id, r.sort_order);
  }
  assert.equal(orders.get(c3.id), 0);
  assert.equal(orders.get(c1.id), 1);
  assert.equal(orders.get(c2.id), 2);
});

test('acceptProposal: update_status_check updates the markdown field', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'S' });
  const p = createProposal({
    workspace_id: ws,
    trigger_text: '.',
    impact_md: '.',
    proposed_changes: [
      { kind: 'update_status_check', initiative_id: init.id, status_check_md: 'Awaiting reply by Apr 30' },
    ],
  });
  acceptProposal(p.id);
  const after = queryOne<{ status_check_md: string | null }>(
    'SELECT status_check_md FROM initiatives WHERE id = ?',
    [init.id],
  );
  assert.equal(after?.status_check_md, 'Awaiting reply by Apr 30');
});

// ─── Validation: bad references mean no partial write ─────────────

test('acceptProposal validates again at apply-time and throws on bad refs', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'S' });
  const ag = seedAgent(ws);
  const p = createProposal({
    workspace_id: ws,
    trigger_text: '.',
    impact_md: '.',
    proposed_changes: [
      { kind: 'add_availability', agent_id: ag, start: '2026-05-01', end: '2026-05-05' },
      { kind: 'set_initiative_status', initiative_id: init.id, status: 'blocked' },
    ],
  });

  // Now delete the initiative behind the proposal's back; accept must
  // refuse without writing the availability row.
  run('DELETE FROM initiatives WHERE id = ?', [init.id]);

  const beforeAvail = queryAll('SELECT id FROM owner_availability WHERE agent_id = ?', [ag]).length;
  assert.throws(() => acceptProposal(p.id), PmProposalValidationError);
  const afterAvail = queryAll('SELECT id FROM owner_availability WHERE agent_id = ?', [ag]).length;
  assert.equal(beforeAvail, afterAvail);

  // Proposal stays in draft so the operator can refine it.
  const fresh = getProposal(p.id);
  assert.equal(fresh?.status, 'draft');
});

test('validateProposedChanges flags every problem in one pass', () => {
  const ws = freshWorkspace();
  const errs = validateProposedChanges(ws, [
    { kind: 'set_initiative_status', initiative_id: 'nope', status: 'at_risk' },
    { kind: 'add_availability', agent_id: 'nope', start: 'bad', end: 'bad' },
  ] as PmDiff[]);
  assert.ok(errs.length >= 3, `expected ≥3 errors, got ${errs.length}`);
});

// ─── Refine ────────────────────────────────────────────────────────

test('refineProposal supersedes parent + creates child with parent_proposal_id', () => {
  const ws = freshWorkspace();
  const parent = createProposal({ workspace_id: ws, trigger_text: 'orig', impact_md: '.', proposed_changes: [] });
  const { child, parent: refreshedParent } = refineProposal(parent.id, 'add a constraint');
  assert.equal(refreshedParent.status, 'superseded');
  assert.equal(child.parent_proposal_id, parent.id);
  assert.equal(child.status, 'draft');
});

test('refineProposal refuses to refine an already-accepted proposal', () => {
  const ws = freshWorkspace();
  const p = createProposal({ workspace_id: ws, trigger_text: '.', impact_md: '.', proposed_changes: [] });
  acceptProposal(p.id);
  assert.throws(() => refineProposal(p.id, 'x'), PmProposalValidationError);
});

// ─── Reject + idempotency ──────────────────────────────────────────

test('rejectProposal flips status without applying changes', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'S' });
  const p = createProposal({
    workspace_id: ws,
    trigger_text: '.',
    impact_md: '.',
    proposed_changes: [{ kind: 'set_initiative_status', initiative_id: init.id, status: 'blocked' }],
  });
  rejectProposal(p.id);
  const after = queryOne<{ status: string }>('SELECT status FROM initiatives WHERE id = ?', [init.id]);
  assert.equal(after?.status, 'planned'); // unchanged
  const refreshed = getProposal(p.id);
  assert.equal(refreshed?.status, 'rejected');
});

test('acceptProposal is idempotent — second accept is a no-op', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'S' });
  const p = createProposal({
    workspace_id: ws,
    trigger_text: '.',
    impact_md: '.',
    proposed_changes: [{ kind: 'set_initiative_status', initiative_id: init.id, status: 'at_risk' }],
  });
  const r1 = acceptProposal(p.id);
  assert.equal(r1.changes_applied, 1);
  assert.equal(r1.idempotent_noop, false);

  const r2 = acceptProposal(p.id);
  assert.equal(r2.idempotent_noop, true);
  assert.equal(r2.changes_applied, 0);
});

// ─── create_task_under_initiative diff kind ─────────────────────────

test('create_task_under_initiative: validates initiative exists in workspace', () => {
  const ws = freshWorkspace();
  assert.throws(
    () =>
      createProposal({
        workspace_id: ws,
        trigger_text: 'notes',
        trigger_kind: 'notes_intake',
        impact_md: '.',
        proposed_changes: [
          {
            kind: 'create_task_under_initiative',
            initiative_id: 'does-not-exist',
            title: 'A task',
          },
        ],
      }),
    PmProposalValidationError,
  );
});

test('create_task_under_initiative: requires title', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'Parent' });
  assert.throws(
    () =>
      createProposal({
        workspace_id: ws,
        trigger_text: '.',
        trigger_kind: 'notes_intake',
        impact_md: '.',
        proposed_changes: [
          { kind: 'create_task_under_initiative', initiative_id: init.id, title: '' },
        ],
      }),
    PmProposalValidationError,
  );
});

test('create_task_under_initiative: rejects placeholder that does not match any earlier diff', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Real parent' });
  assert.throws(
    () =>
      createProposal({
        workspace_id: ws,
        trigger_text: '.',
        trigger_kind: 'notes_intake',
        impact_md: '.',
        proposed_changes: [
          // No create_child_initiative ahead of this diff to back the placeholder.
          { kind: 'create_task_under_initiative', initiative_id: '$0', title: 'Task' },
          {
            kind: 'create_child_initiative',
            parent_initiative_id: init.id,
            title: 'Child',
            child_kind: 'story',
          },
        ],
      }),
    PmProposalValidationError,
  );
});

test('create_task_under_initiative: applies under existing initiative', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'Existing' });
  const p = createProposal({
    workspace_id: ws,
    trigger_text: 'meeting notes',
    trigger_kind: 'notes_intake',
    impact_md: '### Tasks',
    proposed_changes: [
      {
        kind: 'create_task_under_initiative',
        initiative_id: init.id,
        title: 'Wire up the export',
        description: 'add csv export to settings',
        priority: 'high',
      },
    ],
  });
  const result = acceptProposal(p.id);
  assert.equal(result.changes_applied, 1);
  const tasks = queryAll<{ id: string; title: string; initiative_id: string; priority: string; status: string }>(
    `SELECT id, title, initiative_id, priority, status FROM tasks WHERE initiative_id = ?`,
    [init.id],
  );
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'Wire up the export');
  assert.equal(tasks[0].priority, 'high');
  assert.equal(tasks[0].status, 'draft');
  // Audit row written.
  const hist = queryAll<{ from_initiative_id: string | null; to_initiative_id: string }>(
    `SELECT from_initiative_id, to_initiative_id FROM task_initiative_history WHERE task_id = ?`,
    [tasks[0].id],
  );
  assert.equal(hist.length, 1);
  assert.equal(hist[0].from_initiative_id, null);
  assert.equal(hist[0].to_initiative_id, init.id);
});

test('create_task_under_initiative: placeholder resolves to a same-proposal create_child_initiative', () => {
  const ws = freshWorkspace();
  const parent = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Parent epic' });
  const p = createProposal({
    workspace_id: ws,
    trigger_text: 'notes',
    trigger_kind: 'notes_intake',
    impact_md: '.',
    proposed_changes: [
      {
        kind: 'create_child_initiative',
        parent_initiative_id: parent.id,
        title: 'New onboarding story',
        child_kind: 'story',
        placeholder_id: 'onboarding-story',
      },
      {
        kind: 'create_task_under_initiative',
        initiative_id: 'onboarding-story',
        title: 'Draft onboarding copy',
      },
      {
        kind: 'create_task_under_initiative',
        initiative_id: '$0',
        title: 'Build onboarding step 1',
      },
    ],
  });
  const result = acceptProposal(p.id);
  assert.equal(result.changes_applied, 3);

  const child = queryOne<{ id: string; title: string }>(
    `SELECT id, title FROM initiatives WHERE parent_initiative_id = ? LIMIT 1`,
    [parent.id],
  );
  assert.ok(child);
  const tasks = queryAll<{ title: string; initiative_id: string }>(
    `SELECT title, initiative_id FROM tasks WHERE initiative_id = ?`,
    [child!.id],
  );
  assert.equal(tasks.length, 2);
  assert.ok(tasks.some(t => t.title === 'Draft onboarding copy'));
  assert.ok(tasks.some(t => t.title === 'Build onboarding step 1'));
});

test('create_task_under_initiative: bad assigned_agent_id rolls back the whole proposal', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'Anchor' });
  assert.throws(
    () =>
      createProposal({
        workspace_id: ws,
        trigger_text: '.',
        trigger_kind: 'notes_intake',
        impact_md: '.',
        proposed_changes: [
          {
            kind: 'create_task_under_initiative',
            initiative_id: init.id,
            title: 'A task',
            assigned_agent_id: 'no-such-agent',
          },
        ],
      }),
    PmProposalValidationError,
  );
});

test('acceptProposal emits a pm_proposal_accepted event row', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'S' });
  const p = createProposal({
    workspace_id: ws,
    trigger_text: '.',
    impact_md: '.',
    proposed_changes: [{ kind: 'set_initiative_status', initiative_id: init.id, status: 'at_risk' }],
  });
  acceptProposal(p.id);
  const ev = queryAll<{ id: string; metadata: string }>(
    `SELECT id, metadata FROM events WHERE type = 'pm_proposal_accepted' ORDER BY created_at DESC LIMIT 5`,
  );
  // At least one event row, and the latest references our proposal id.
  assert.ok(ev.length >= 1);
  const latest = ev.find(e => {
    try { return (JSON.parse(e.metadata) as { proposal_id?: string }).proposal_id === p.id; }
    catch { return false; }
  });
  assert.ok(latest, 'event metadata.proposal_id should match');
});
