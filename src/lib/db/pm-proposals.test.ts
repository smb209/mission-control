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
  tryAdoptOrphanedPlaceholder,
  sweepOrphanedPlaceholders,
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

test('acceptProposal: set_initiative_status accepts done and cancelled end-to-end', () => {
  // Policy as of feat(pm) allow done/cancelled: the PM may propose any of
  // the 6 InitiativeStatus values; the operator's accept click is the
  // gate, not the validator. See docs/archive/initiative-investigate.md.
  const ws = freshWorkspace();
  const initDone = createInitiative({ workspace_id: ws, kind: 'story', title: 'D' });
  const initCancelled = createInitiative({ workspace_id: ws, kind: 'story', title: 'C' });

  const pDone = createProposal({
    workspace_id: ws,
    trigger_text: '.',
    impact_md: '.',
    proposed_changes: [
      { kind: 'set_initiative_status', initiative_id: initDone.id, status: 'done' },
    ],
  });
  acceptProposal(pDone.id);
  const afterDone = queryOne<{ status: string }>(
    'SELECT status FROM initiatives WHERE id = ?',
    [initDone.id],
  );
  assert.equal(afterDone?.status, 'done');

  const pCancelled = createProposal({
    workspace_id: ws,
    trigger_text: '.',
    impact_md: '.',
    proposed_changes: [
      { kind: 'set_initiative_status', initiative_id: initCancelled.id, status: 'cancelled' },
    ],
  });
  acceptProposal(pCancelled.id);
  const afterCancelled = queryOne<{ status: string }>(
    'SELECT status FROM initiatives WHERE id = ?',
    [initCancelled.id],
  );
  assert.equal(afterCancelled?.status, 'cancelled');
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

// ─── Slice 1: capture-at-apply pattern (revertable proposals) ───────

test('apply captures prev_status on set_initiative_status', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Capture me' });
  const p = createProposal({
    workspace_id: ws,
    trigger_text: 't',
    impact_md: 'm',
    proposed_changes: [
      { kind: 'set_initiative_status', initiative_id: init.id, status: 'at_risk' },
    ],
  });
  acceptProposal(p.id);
  const updated = getProposal(p.id)!;
  const diff = updated.proposed_changes[0];
  assert.equal(diff.kind, 'set_initiative_status');
  // initial status defaults to 'planned' from createInitiative
  assert.equal((diff as { prev_status?: string }).prev_status, 'planned');
});

test('apply captures prev_target_start/end on shift_initiative_target', () => {
  const ws = freshWorkspace();
  const init = createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Shifty',
    target_start: '2026-01-01',
    target_end: '2026-02-01',
  });
  const p = createProposal({
    workspace_id: ws,
    trigger_text: 't',
    impact_md: 'm',
    proposed_changes: [
      {
        kind: 'shift_initiative_target',
        initiative_id: init.id,
        target_start: '2026-03-01',
        target_end: '2026-04-01',
      },
    ],
  });
  acceptProposal(p.id);
  const diff = getProposal(p.id)!.proposed_changes[0] as {
    prev_target_start?: string | null;
    prev_target_end?: string | null;
  };
  assert.equal(diff.prev_target_start?.slice(0, 10), '2026-01-01');
  assert.equal(diff.prev_target_end?.slice(0, 10), '2026-02-01');
});

test('apply captures created_dependency_id on add_dependency', () => {
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
  acceptProposal(p.id);
  const diff = getProposal(p.id)!.proposed_changes[0] as { created_dependency_id?: string };
  assert.ok(diff.created_dependency_id, 'capture should record the new edge id');
  const row = queryOne<{ id: string }>(
    `SELECT id FROM initiative_dependencies WHERE id = ?`,
    [diff.created_dependency_id],
  );
  assert.ok(row, 'captured id must reference a real edge');
});

test('apply captures removed_dependency_row on remove_dependency', () => {
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
  acceptProposal(p.id);
  const diff = getProposal(p.id)!.proposed_changes[0] as {
    removed_dependency_row?: { id: string; initiative_id: string; depends_on_initiative_id: string };
  };
  assert.ok(diff.removed_dependency_row);
  assert.equal(diff.removed_dependency_row!.id, dep.id);
  assert.equal(diff.removed_dependency_row!.initiative_id, a.id);
  assert.equal(diff.removed_dependency_row!.depends_on_initiative_id, b.id);
});

test('apply captures prev_child_ids_in_order on reorder_initiatives', () => {
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
  acceptProposal(p.id);
  const diff = getProposal(p.id)!.proposed_changes[0] as { prev_child_ids_in_order?: string[] };
  // c1, c2, c3 were inserted in creation order, so the captured prior
  // arrangement should match that ordering.
  assert.deepEqual(diff.prev_child_ids_in_order, [c1.id, c2.id, c3.id]);
});

test('apply captures prev_status_check_md on update_status_check', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'I' });
  // Seed an initial status_check_md so capture is non-null.
  run(
    `UPDATE initiatives SET status_check_md = ? WHERE id = ?`,
    ['previous-md', init.id],
  );
  const p = createProposal({
    workspace_id: ws,
    trigger_text: 't',
    impact_md: 'm',
    proposed_changes: [
      { kind: 'update_status_check', initiative_id: init.id, status_check_md: 'new-md' },
    ],
  });
  acceptProposal(p.id);
  const diff = getProposal(p.id)!.proposed_changes[0] as { prev_status_check_md?: string | null };
  assert.equal(diff.prev_status_check_md, 'previous-md');
});

test('apply captures created_initiative_id on create_child_initiative', () => {
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
        title: 'Child',
        child_kind: 'epic',
      },
    ],
  });
  acceptProposal(p.id);
  const diff = getProposal(p.id)!.proposed_changes[0] as { created_initiative_id?: string };
  assert.ok(diff.created_initiative_id);
  const row = queryOne<{ id: string }>(
    `SELECT id FROM initiatives WHERE id = ?`,
    [diff.created_initiative_id],
  );
  assert.ok(row);
});

test('createProposal accepts reverts_proposal_id and rowToProposal surfaces it', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'X' });
  const original = createProposal({
    workspace_id: ws,
    trigger_text: 't',
    impact_md: 'm',
    proposed_changes: [{ kind: 'set_initiative_status', initiative_id: init.id, status: 'at_risk' }],
  });
  const revert = createProposal({
    workspace_id: ws,
    trigger_text: 't-revert',
    trigger_kind: 'revert',
    impact_md: 'undo it',
    proposed_changes: [],
    reverts_proposal_id: original.id,
  });
  assert.equal(revert.reverts_proposal_id, original.id);
  assert.equal(revert.trigger_kind, 'revert');
});

// ─── partial accept (per-diff selection) ───────────────────────────

test('acceptProposal: accepted_indexes filter applies only listed diffs', () => {
  const ws = freshWorkspace();
  const a = createInitiative({ workspace_id: ws, kind: 'story', title: 'A' });
  const b = createInitiative({ workspace_id: ws, kind: 'story', title: 'B' });
  const c = createInitiative({ workspace_id: ws, kind: 'story', title: 'C' });
  const p = createProposal({
    workspace_id: ws,
    trigger_text: 't',
    impact_md: 'm',
    proposed_changes: [
      { kind: 'set_initiative_status', initiative_id: a.id, status: 'in_progress' },
      { kind: 'set_initiative_status', initiative_id: b.id, status: 'in_progress' },
      { kind: 'set_initiative_status', initiative_id: c.id, status: 'in_progress' },
    ],
  });
  // Accept only index 0 and 2 — skip B.
  const result = acceptProposal(p.id, null, { accepted_indexes: [0, 2] });
  assert.equal(result.changes_applied, 2);
  assert.deepEqual(result.rejected_indexes, [1]);

  const after = (id: string) =>
    queryOne<{ status: string }>('SELECT status FROM initiatives WHERE id = ?', [id])?.status;
  assert.equal(after(a.id), 'in_progress', 'A accepted');
  assert.equal(after(b.id), 'planned', 'B skipped — still planned');
  assert.equal(after(c.id), 'in_progress', 'C accepted');
});

test('acceptProposal: empty accepted_indexes applies nothing', () => {
  const ws = freshWorkspace();
  const a = createInitiative({ workspace_id: ws, kind: 'story', title: 'A' });
  const p = createProposal({
    workspace_id: ws,
    trigger_text: 't',
    impact_md: 'm',
    proposed_changes: [
      { kind: 'set_initiative_status', initiative_id: a.id, status: 'in_progress' },
    ],
  });
  const result = acceptProposal(p.id, null, { accepted_indexes: [] });
  assert.equal(result.changes_applied, 0);
  assert.deepEqual(result.rejected_indexes, [0]);
  // Status unchanged.
  const after = queryOne<{ status: string }>(
    'SELECT status FROM initiatives WHERE id = ?',
    [a.id],
  );
  assert.equal(after?.status, 'planned');
});

test('acceptProposal: rejects partial-accept when create_task_under_initiative references unselected placeholder', () => {
  const ws = freshWorkspace();
  const parent = createInitiative({ workspace_id: ws, kind: 'milestone', title: 'P' });
  const p = createProposal({
    workspace_id: ws,
    trigger_text: 't',
    impact_md: 'm',
    proposed_changes: [
      // index 0: creates the placeholder $0
      {
        kind: 'create_child_initiative',
        parent_initiative_id: parent.id,
        title: 'Child',
        child_kind: 'epic',
      },
      // index 1: task hung off $0 — depends on index 0 being selected
      {
        kind: 'create_task_under_initiative',
        initiative_id: '$0',
        title: 'Task on the new child',
      },
    ],
  });
  // Selecting only the task without its placeholder owner is invalid.
  assert.throws(
    () => acceptProposal(p.id, null, { accepted_indexes: [1] }),
    /create_child_initiative at index 0 is not in the accepted set/,
  );
  // Selecting both is fine.
  const ok = acceptProposal(p.id, null, { accepted_indexes: [0, 1] });
  assert.equal(ok.changes_applied, 2);
});

test('acceptProposal: omitting accepted_indexes is back-compat (full accept)', () => {
  const ws = freshWorkspace();
  const a = createInitiative({ workspace_id: ws, kind: 'story', title: 'A' });
  const p = createProposal({
    workspace_id: ws,
    trigger_text: 't',
    impact_md: 'm',
    proposed_changes: [
      { kind: 'set_initiative_status', initiative_id: a.id, status: 'blocked' },
    ],
  });
  const result = acceptProposal(p.id);
  assert.equal(result.changes_applied, 1);
  assert.deepEqual(result.rejected_indexes, []);
});

// ─── confirm_task_done diff kind ───────────────────────────────────

function seedTaskInWorkspace(opts: {
  workspace: string;
  initiativeId?: string;
  status?: string;
}): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, initiative_id, created_at, updated_at)
     VALUES (?, 'T', ?, 'normal', ?, ?, ?, datetime('now'), datetime('now'))`,
    [id, opts.status ?? 'review', opts.workspace, opts.workspace, opts.initiativeId ?? null],
  );
  return id;
}

function seedDoneEvidence(taskId: string): void {
  // Minimum viable evidence to satisfy whyCannotBeDone's legacy bar:
  // one role='output' deliverable + one 'completed' activity row.
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, role, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'file', 'out.txt', 'output', datetime('now'))`,
    [taskId],
  );
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'completed', 'work done', datetime('now'))`,
    [taskId],
  );
}

test('confirm_task_done: rejects task in inbox (must be late-stage)', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'S' });
  const taskId = seedTaskInWorkspace({ workspace: ws, initiativeId: init.id, status: 'inbox' });
  assert.throws(
    () =>
      createProposal({
        workspace_id: ws,
        trigger_text: 'audit confirms',
        impact_md: '.',
        proposed_changes: [
          {
            kind: 'confirm_task_done',
            task_id: taskId,
            evidence_md: 'Audit confirms shipped — see commit 1234abc.',
            commit_sha: '1234abc',
          },
        ],
      }),
    PmProposalValidationError,
  );
});

test('confirm_task_done: rejects when no structured evidence pointer is provided', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'S' });
  const taskId = seedTaskInWorkspace({ workspace: ws, initiativeId: init.id, status: 'review' });
  assert.throws(
    () =>
      createProposal({
        workspace_id: ws,
        trigger_text: 'audit confirms',
        impact_md: '.',
        proposed_changes: [
          {
            kind: 'confirm_task_done',
            task_id: taskId,
            evidence_md: 'Looked at it, looks done. No specific pointer.',
          },
        ],
      }),
    PmProposalValidationError,
  );
});

test('confirm_task_done: rejects evidence_md shorter than 20 chars', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'S' });
  const taskId = seedTaskInWorkspace({ workspace: ws, initiativeId: init.id, status: 'review' });
  assert.throws(
    () =>
      createProposal({
        workspace_id: ws,
        trigger_text: 'audit confirms',
        impact_md: '.',
        proposed_changes: [
          {
            kind: 'confirm_task_done',
            task_id: taskId,
            evidence_md: 'shipped',
            commit_sha: '1234abc',
          },
        ],
      }),
    PmProposalValidationError,
  );
});

test('confirm_task_done: rejects audit_proposal_id pointing at a draft proposal', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'S' });
  const taskId = seedTaskInWorkspace({ workspace: ws, initiativeId: init.id, status: 'review' });
  // Create a draft (not accepted) proposal in the same workspace.
  const draftAudit = createProposal({
    workspace_id: ws,
    trigger_text: 'audit',
    impact_md: '.',
    proposed_changes: [],
  });
  assert.equal(draftAudit.status, 'draft');
  assert.throws(
    () =>
      createProposal({
        workspace_id: ws,
        trigger_text: 'audit confirms',
        impact_md: '.',
        proposed_changes: [
          {
            kind: 'confirm_task_done',
            task_id: taskId,
            evidence_md: 'Pointing at the audit proposal that confirmed completion.',
            audit_proposal_id: draftAudit.id,
          },
        ],
      }),
    PmProposalValidationError,
  );
});

test('confirm_task_done: happy path transitions task to done + emits attestation event', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'S' });
  const taskId = seedTaskInWorkspace({ workspace: ws, initiativeId: init.id, status: 'review' });
  seedDoneEvidence(taskId);

  const p = createProposal({
    workspace_id: ws,
    trigger_text: 'audit confirms',
    impact_md: '.',
    proposed_changes: [
      {
        kind: 'confirm_task_done',
        task_id: taskId,
        evidence_md: 'Audit verified all alert() replacements landed in commit 483d5de.',
        commit_sha: '483d5de',
      },
    ],
  });
  const result = acceptProposal(p.id);
  assert.equal(result.changes_applied, 1);
  const after = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  assert.equal(after?.status, 'done');

  const events = queryAll<{ type: string }>(
    `SELECT type FROM events WHERE task_id = ? AND type = 'task_status_attested_done'`,
    [taskId],
  );
  assert.equal(events.length, 1);
});

test('confirm_task_done: revert restores prev_status', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'S' });
  const taskId = seedTaskInWorkspace({ workspace: ws, initiativeId: init.id, status: 'review' });
  seedDoneEvidence(taskId);

  const p = createProposal({
    workspace_id: ws,
    trigger_text: 'audit confirms',
    impact_md: '.',
    proposed_changes: [
      {
        kind: 'confirm_task_done',
        task_id: taskId,
        evidence_md: 'Audit verified all alert() replacements landed in commit 483d5de.',
        commit_sha: '483d5de',
      },
    ],
  });
  acceptProposal(p.id);

  // Re-read the proposal so prev_status capture is visible on the diff.
  const accepted = getProposal(p.id);
  assert.ok(accepted);
  const diff = accepted!.proposed_changes[0];
  assert.equal((diff as { prev_task_status?: string }).prev_task_status, 'review');

  // Build a revert proposal that restores prev_status, then accept it.
  const revert = createProposal({
    workspace_id: ws,
    trigger_text: `revert ${p.id}`,
    trigger_kind: 'revert',
    impact_md: '.',
    proposed_changes: [
      {
        kind: 'set_task_status',
        task_id: taskId,
        status: 'review',
      },
    ],
  });
  acceptProposal(revert.id);

  const after = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  assert.equal(after?.status, 'review');
});

test('set_task_status: forward proposal still rejects status != cancelled', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'story', title: 'S' });
  const taskId = seedTaskInWorkspace({ workspace: ws, initiativeId: init.id, status: 'review' });
  assert.throws(
    () =>
      createProposal({
        workspace_id: ws,
        trigger_text: '.',
        impact_md: '.',
        proposed_changes: [
          {
            kind: 'set_task_status',
            task_id: taskId,
            status: 'in_progress',
          },
        ],
      }),
    PmProposalValidationError,
  );
});

// ─── Orphan-placeholder retroactive adoption ───────────────────────

function seedSynthPlaceholder(ws: string, triggerKind: string = "notes_intake") {
  const p = createProposal({
    workspace_id: ws,
    trigger_text: "operator notes about scrubbing localhost:4000",
    trigger_kind: triggerKind as Parameters<typeof createProposal>[0]["trigger_kind"],
    impact_md: "### No structured changes inferred yet",
    proposed_changes: [],
    dispatch_state: "synth_only",
  });
  return p;
}

function seedAgentRow(ws: string, triggerKind: string = "notes_intake") {
  const init = createInitiative({ workspace_id: ws, kind: "story", title: "X" });
  const p = createProposal({
    workspace_id: ws,
    trigger_text: "agent freeform trigger",
    trigger_kind: triggerKind as Parameters<typeof createProposal>[0]["trigger_kind"],
    impact_md: "### Real agent analysis",
    proposed_changes: [
      { kind: "set_initiative_status", initiative_id: init.id, status: "blocked" },
    ],
    // createProposal default is agent_complete — matches MCP propose_changes path
  });
  return p;
}

test("tryAdoptOrphanedPlaceholder links matching orphan", () => {
  const ws = freshWorkspace();
  const placeholder = seedSynthPlaceholder(ws);
  const agentRow = seedAgentRow(ws);

  const adoptedId = tryAdoptOrphanedPlaceholder(agentRow.id);
  assert.equal(adoptedId, placeholder.id);

  const refreshedPlaceholder = getProposal(placeholder.id);
  const refreshedAgent = getProposal(agentRow.id);
  assert.equal(refreshedPlaceholder?.status, "superseded");
  assert.equal(refreshedAgent?.parent_proposal_id, placeholder.id);
  assert.equal(refreshedAgent?.dispatch_state, "agent_complete");
});

test("tryAdoptOrphanedPlaceholder ignores other workspaces", () => {
  const wsA = freshWorkspace();
  const wsB = freshWorkspace();
  seedSynthPlaceholder(wsA); // orphan in workspace A
  const agentRow = seedAgentRow(wsB); // agent row in workspace B
  const adoptedId = tryAdoptOrphanedPlaceholder(agentRow.id);
  assert.equal(adoptedId, null);
});

test("tryAdoptOrphanedPlaceholder ignores mismatched trigger_kind", () => {
  const ws = freshWorkspace();
  seedSynthPlaceholder(ws, "notes_intake");
  const agentRow = seedAgentRow(ws, "disruption_event");
  const adoptedId = tryAdoptOrphanedPlaceholder(agentRow.id);
  assert.equal(adoptedId, null);
});

test("tryAdoptOrphanedPlaceholder is a no-op when placeholder is already linked", () => {
  const ws = freshWorkspace();
  const placeholder = seedSynthPlaceholder(ws);
  // Pre-link via direct UPDATE to simulate the in-flight reconciler having won.
  run(
    `UPDATE pm_proposals SET status = ? WHERE id = ?`,
    ["superseded", placeholder.id],
  );
  const agentRow = seedAgentRow(ws);
  const adoptedId = tryAdoptOrphanedPlaceholder(agentRow.id);
  assert.equal(adoptedId, null);
  const refreshedAgent = getProposal(agentRow.id);
  assert.equal(refreshedAgent?.parent_proposal_id, null);
});

test("tryAdoptOrphanedPlaceholder skips placeholders outside the time window", () => {
  const ws = freshWorkspace();
  const placeholder = seedSynthPlaceholder(ws);
  // Backdate the placeholder by 1 hour.
  run(
    `UPDATE pm_proposals SET created_at = ? WHERE id = ?`,
    [new Date(Date.now() - 60 * 60 * 1000).toISOString(), placeholder.id],
  );
  const agentRow = seedAgentRow(ws);
  // Default window is 10 minutes.
  const adoptedId = tryAdoptOrphanedPlaceholder(agentRow.id);
  assert.equal(adoptedId, null);
  // A wider window finds it.
  const widerAdoptedId = tryAdoptOrphanedPlaceholder(agentRow.id, 2 * 60 * 60 * 1000);
  assert.equal(widerAdoptedId, placeholder.id);
});

test("sweepOrphanedPlaceholders links eligible pairs in bulk", () => {
  const wsA = freshWorkspace();
  const wsB = freshWorkspace();
  const phA = seedSynthPlaceholder(wsA);
  const phB = seedSynthPlaceholder(wsB);
  const agentA = seedAgentRow(wsA);
  const agentB = seedAgentRow(wsB);
  // wsC has only a placeholder, no agent row — should remain orphaned.
  const wsC = freshWorkspace();
  const phC = seedSynthPlaceholder(wsC);

  const linked = sweepOrphanedPlaceholders();
  assert.ok(linked >= 2, `expected ≥2 links, got ${linked}`);

  assert.equal(getProposal(phA.id)?.status, "superseded");
  assert.equal(getProposal(phB.id)?.status, "superseded");
  assert.equal(getProposal(phC.id)?.status, "draft");
  assert.equal(getProposal(agentA.id)?.parent_proposal_id, phA.id);
  assert.equal(getProposal(agentB.id)?.parent_proposal_id, phB.id);
});
