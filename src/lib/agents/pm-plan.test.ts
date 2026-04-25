/**
 * Plan-with-PM synthesizer tests (Polish B).
 *
 * Covers the deterministic v1 of `synthesizePlanInitiative`:
 *   - Returns a SynthesizePlanResult with the right shape.
 *   - Suggests a target_end when the draft has no dates.
 *   - Heuristics are stable for fixed inputs.
 *   - Description-keyword complexity inference works.
 *   - Overlap-based dependency suggestion picks workspace siblings.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import { createInitiative } from '@/lib/db/initiatives';
import { getRoadmapSnapshot } from '@/lib/db/roadmap';
import { synthesizePlanInitiative } from './pm-agent';

function freshWorkspace(): string {
  const id = `ws-plan-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

test('synthesizePlanInitiative: returns valid shape with title-only draft', () => {
  const ws = freshWorkspace();
  const snapshot = getRoadmapSnapshot({ workspace_id: ws });
  const result = synthesizePlanInitiative(snapshot, { title: 'Build invoicing' });

  assert.equal(typeof result.impact_md, 'string');
  assert.ok(result.impact_md.length > 0);
  assert.ok(result.suggestions);
  assert.ok(result.suggestions.refined_description.length > 0);
  assert.ok(['S', 'M', 'L', 'XL'].includes(result.suggestions.complexity));
  assert.ok(result.suggestions.target_end);
  assert.ok(Array.isArray(result.suggestions.dependencies));
  assert.ok(result.suggestions.status_check_md.includes('Status check'));
  // Plan-initiative is advisory — proposed_changes stays empty.
  assert.equal(result.changes.length, 0);
});

test('synthesizePlanInitiative: suggests target_end when draft has no dates', () => {
  const ws = freshWorkspace();
  const snapshot = getRoadmapSnapshot({ workspace_id: ws });
  const result = synthesizePlanInitiative(snapshot, { title: 'Add login' });
  assert.ok(result.suggestions.target_end);
  // target_start defaults to today (when not provided).
  assert.ok(result.suggestions.target_start);
  assert.ok(result.suggestions.target_end > result.suggestions.target_start!);
});

test('synthesizePlanInitiative: heuristic — "platform rebuild" → XL', () => {
  const ws = freshWorkspace();
  const snapshot = getRoadmapSnapshot({ workspace_id: ws });
  const result = synthesizePlanInitiative(snapshot, {
    title: 'Platform rebuild',
    description: 'Migrate the legacy system to a new platform',
  });
  assert.equal(result.suggestions.complexity, 'XL');
});

test('synthesizePlanInitiative: heuristic — "fix typo" → S', () => {
  const ws = freshWorkspace();
  const snapshot = getRoadmapSnapshot({ workspace_id: ws });
  const result = synthesizePlanInitiative(snapshot, {
    title: 'Fix typo on homepage',
    description: 'Change copy on the welcome banner',
  });
  assert.equal(result.suggestions.complexity, 'S');
});

test('synthesizePlanInitiative: respects operator-set complexity', () => {
  const ws = freshWorkspace();
  const snapshot = getRoadmapSnapshot({ workspace_id: ws });
  const result = synthesizePlanInitiative(snapshot, {
    title: 'Platform rebuild',
    description: 'Migrate the legacy system',
    complexity: 'M',
  });
  // Should NOT override the operator's choice.
  assert.equal(result.suggestions.complexity, 'M');
});

test('synthesizePlanInitiative: deterministic for same input', () => {
  const ws = freshWorkspace();
  const snapshot = getRoadmapSnapshot({ workspace_id: ws });
  const draft = {
    title: 'Add invoicing module',
    description: 'A new invoicing system',
    target_start: '2026-05-01',
  };
  const a = synthesizePlanInitiative(snapshot, draft);
  const b = synthesizePlanInitiative(snapshot, draft);
  assert.equal(a.suggestions.complexity, b.suggestions.complexity);
  assert.equal(a.suggestions.target_end, b.suggestions.target_end);
  assert.equal(a.suggestions.refined_description, b.suggestions.refined_description);
});

test('synthesizePlanInitiative: noun-overlap picks workspace siblings as candidate deps', () => {
  const ws = freshWorkspace();
  // A sibling that shares "invoicing" with the draft title.
  const sibling = createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Invoicing data model',
  });
  // A sibling that shares no nouns.
  createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Marketing automation',
  });

  const snapshot = getRoadmapSnapshot({ workspace_id: ws });
  const result = synthesizePlanInitiative(snapshot, {
    title: 'Build invoicing UI',
  });

  const dep = result.suggestions.dependencies.find(
    d => d.depends_on_initiative_id === sibling.id,
  );
  assert.ok(dep, 'expected the invoicing-related sibling to be a candidate dep');
  assert.equal(dep!.kind, 'informational');
});

test('synthesizePlanInitiative: target_end uses operator-supplied target_start', () => {
  const ws = freshWorkspace();
  const snapshot = getRoadmapSnapshot({ workspace_id: ws });
  const result = synthesizePlanInitiative(snapshot, {
    title: 'New page',
    target_start: '2026-06-01',
    complexity: 'M',
  });
  assert.equal(result.suggestions.target_start, '2026-06-01');
  // M = 14d offset → 2026-06-15.
  assert.equal(result.suggestions.target_end, '2026-06-15');
});
