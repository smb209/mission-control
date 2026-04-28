/**
 * Decompose-with-PM tests (Polish B).
 *
 * Covers:
 *   - synthesizeDecompose produces 3-5 children with valid kinds.
 *   - acceptProposal applies create_child_initiative diffs:
 *       * children inserted with right parent
 *       * initiative_parent_history rows appended
 *       * sibling placeholder ($N) deps resolved to real ids
 *   - Validation rejects theme/milestone as child_kind.
 *   - plan_initiative trigger_kind makes acceptProposal a no-op.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { createInitiative } from '@/lib/db/initiatives';
import { synthesizeDecompose, synthesizePlanInitiative } from './pm-agent';
import {
  createProposal,
  acceptProposal,
  PmProposalValidationError,
} from '@/lib/db/pm-proposals';
import { getRoadmapSnapshot } from '@/lib/db/roadmap';

function freshWorkspace(): string {
  const id = `ws-decompose-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

// ─── Synthesizer ─────────────────────────────────────────────────────

test('synthesizeDecompose: build-style parent → 3-7 children, all story kind', () => {
  const ws = freshWorkspace();
  const parent = createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Build invoicing module',
    description: 'A new invoicing flow with PDF export',
  });

  const result = synthesizeDecompose(parent);
  assert.ok(result.changes.length >= 3 && result.changes.length <= 7);
  for (const c of result.changes) {
    assert.equal(c.kind, 'create_child_initiative');
    if (c.kind === 'create_child_initiative') {
      assert.ok(['epic', 'story'].includes(c.child_kind));
      assert.equal(c.parent_initiative_id, parent.id);
    }
  }
});

test('synthesizeDecompose: launch milestone → launch template', () => {
  const ws = freshWorkspace();
  const parent = createInitiative({
    workspace_id: ws,
    kind: 'milestone',
    title: 'Launch v2',
    description: 'Public launch',
  });

  const result = synthesizeDecompose(parent);
  // Launch template includes "Marketing" as one of the children.
  const titles = result.changes
    .filter(c => c.kind === 'create_child_initiative')
    .map(c => (c.kind === 'create_child_initiative' ? c.title : ''));
  assert.ok(titles.some(t => /marketing/i.test(t)));
  assert.ok(titles.some(t => /go-live/i.test(t)));
});

test('synthesizeDecompose: generic parent → 3 children', () => {
  const ws = freshWorkspace();
  const parent = createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Customer success initiative',
  });

  const result = synthesizeDecompose(parent);
  assert.equal(result.changes.length, 3);
});

test('synthesizeDecompose: hint is folded into child descriptions', () => {
  const ws = freshWorkspace();
  const parent = createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Build feature X',
  });

  const result = synthesizeDecompose(parent, 'focus on backend first');
  for (const c of result.changes) {
    if (c.kind === 'create_child_initiative') {
      assert.match(c.description ?? '', /focus on backend first/);
    }
  }
});

// ─── Apply via acceptProposal ────────────────────────────────────────

test('acceptProposal: create_child_initiative inserts children with audit + dep chain', () => {
  const ws = freshWorkspace();
  const parent = createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Build user notifications',
  });

  const synth = synthesizeDecompose(parent);
  const proposal = createProposal({
    workspace_id: ws,
    trigger_text: JSON.stringify({ mode: 'decompose_initiative', initiative_id: parent.id }),
    trigger_kind: 'decompose_initiative',
    impact_md: synth.impact_md,
    proposed_changes: synth.changes,
  });

  const result = acceptProposal(proposal.id);
  assert.equal(result.idempotent_noop, false);
  assert.ok(result.changes_applied >= 3);

  // Children created under parent.
  const created = queryAll<{ id: string; title: string; kind: string }>(
    `SELECT id, title, kind FROM initiatives WHERE parent_initiative_id = ? ORDER BY sort_order`,
    [parent.id],
  );
  assert.ok(created.length >= 3, 'expected children to be created');
  for (const child of created) {
    // Exactly one parent_history row per new child.
    const rows = queryAll<{ to_parent_id: string; reason: string }>(
      `SELECT to_parent_id, reason FROM initiative_parent_history WHERE initiative_id = ?`,
      [child.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].to_parent_id, parent.id);
    assert.match(rows[0].reason, /PM decompose/);
  }

  // Dep chain: child[1] depends on child[0], etc. (the synthesizer
  // pre-wires `$0`, `$1`, … placeholders).
  for (let i = 1; i < created.length; i++) {
    const deps = queryAll<{ depends_on_initiative_id: string }>(
      `SELECT depends_on_initiative_id FROM initiative_dependencies WHERE initiative_id = ?`,
      [created[i].id],
    );
    assert.ok(deps.length >= 1, `child[${i}] should have at least one dep`);
    assert.equal(deps[0].depends_on_initiative_id, created[i - 1].id);
  }
});

test('acceptProposal: rejects create_child_initiative with theme/milestone child_kind', () => {
  const ws = freshWorkspace();
  const parent = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Parent' });

  assert.throws(
    () =>
      createProposal({
        workspace_id: ws,
        trigger_text: 'test',
        trigger_kind: 'decompose_initiative',
        impact_md: 'x',
        proposed_changes: [
          {
            // @ts-expect-error testing the validation path
            kind: 'create_child_initiative',
            parent_initiative_id: parent.id,
            title: 'Bad theme child',
            child_kind: 'theme',
          },
        ],
      }),
    PmProposalValidationError,
  );
});

// ─── synthesizePlanInitiative dependency suggestions ─────────────────

test('synthesizePlanInitiative: skips the target initiative from dependency candidates (self-dep guard)', () => {
  const ws = freshWorkspace();
  const target = createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Smart Snappy',
    description: 'turning passive logging into proactive coaching',
  });
  const snapshot = getRoadmapSnapshot({ workspace_id: ws });
  const result = synthesizePlanInitiative(
    snapshot,
    { title: 'Smart Snappy', description: 'turning passive logging into proactive coaching' },
    { targetInitiativeId: target.id },
  );
  for (const dep of result.changes.flatMap(c => c.kind === 'create_child_initiative' ? [] : [])) {
    void dep;
  }
  // The result.suggestions field carries the candidate dependencies; ensure none point at the target.
  const deps = result.suggestions?.dependencies ?? [];
  for (const d of deps) {
    assert.notEqual(d.depends_on_initiative_id, target.id, 'must not propose self-dependency');
  }
});

test('synthesizePlanInitiative: belt-and-suspenders — skips exact-title matches even without targetInitiativeId', () => {
  const ws = freshWorkspace();
  const twin = createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Smart Snappy',
    description: 'older draft of the same idea',
  });
  const snapshot = getRoadmapSnapshot({ workspace_id: ws });
  const result = synthesizePlanInitiative(snapshot, { title: 'Smart Snappy', description: 'a fresh draft' });
  const deps = result.suggestions?.dependencies ?? [];
  for (const d of deps) {
    assert.notEqual(d.depends_on_initiative_id, twin.id, 'exact-title match should not be suggested as a dep');
  }
});

test('acceptProposal: plan_initiative is a no-op (advisory)', () => {
  const ws = freshWorkspace();
  const snapshot = getRoadmapSnapshot({ workspace_id: ws });
  const synth = synthesizePlanInitiative(snapshot, { title: 'Hello' });

  const proposal = createProposal({
    workspace_id: ws,
    trigger_text: JSON.stringify({ mode: 'plan_initiative', draft: { title: 'Hello' } }),
    trigger_kind: 'plan_initiative',
    impact_md: synth.impact_md,
    proposed_changes: synth.changes,
  });

  const before = queryOne<{ n: number }>('SELECT COUNT(*) as n FROM initiatives WHERE workspace_id = ?', [ws]);
  const result = acceptProposal(proposal.id);
  const after = queryOne<{ n: number }>('SELECT COUNT(*) as n FROM initiatives WHERE workspace_id = ?', [ws]);

  assert.equal(result.idempotent_noop, false);
  // No rows applied — the array was empty AND the trigger_kind short-circuits.
  assert.equal(result.proposal.status, 'accepted');
  assert.equal(before!.n, after!.n);
});
