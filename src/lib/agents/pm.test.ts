/**
 * PM agent (synthesize) + dispatch tests (Phase 5).
 *
 * Coverage:
 *   - Empty triggers don't throw and produce a "no changes" proposal.
 *   - Owner-out-of-office text → add_availability with the right window.
 *   - Generated changes only reference real ids in the snapshot.
 *   - dispatchPm posts a chat message with metadata.proposal_id and
 *     persists a draft proposal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { createInitiative } from '@/lib/db/initiatives';
import { getRoadmapSnapshot } from '@/lib/db/roadmap';
import { synthesizeImpactAnalysis, dispatchPm } from './pm-dispatch';
import { ensurePmAgent } from '@/lib/bootstrap-agents';

function freshWorkspace(): string {
  const id = `ws-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function seedNamedAgent(workspace: string, name: string): string {
  const id = uuidv4();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_active, created_at, updated_at)
     VALUES (?, ?, 'worker', ?, 1, datetime('now'), datetime('now'))`,
    [id, name, workspace],
  );
  return id;
}

// ─── Synthesize ────────────────────────────────────────────────────

test('synthesizeImpactAnalysis: empty trigger yields no changes', () => {
  const ws = freshWorkspace();
  const snap = getRoadmapSnapshot({ workspace_id: ws });
  const result = synthesizeImpactAnalysis(snap, '');
  assert.equal(result.changes.length, 0);
  assert.match(result.impact_md, /could not extract|No structured changes/);
});

test('synthesizeImpactAnalysis: "Sarah out next week" → add_availability for Sarah', () => {
  const ws = freshWorkspace();
  const sarahId = seedNamedAgent(ws, 'Sarah');
  const snap = getRoadmapSnapshot({ workspace_id: ws });

  const result = synthesizeImpactAnalysis(snap, 'Sarah out next week');
  const avail = result.changes.find(c => c.kind === 'add_availability');
  assert.ok(avail, 'expected an add_availability diff');
  assert.equal(avail!.kind, 'add_availability');
  if (avail.kind === 'add_availability') {
    assert.equal(avail.agent_id, sarahId);
    // 7-day window inferred from "next week".
    assert.ok(avail.start && avail.end);
    assert.ok(avail.end > avail.start);
  }
});

test('synthesizeImpactAnalysis: never references unknown initiative_ids', () => {
  const ws = freshWorkspace();
  const initA = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Build big feature' });
  const snap = getRoadmapSnapshot({ workspace_id: ws });

  const result = synthesizeImpactAnalysis(snap, 'Build big feature is delayed');
  // Every initiative_id reference must be in the snapshot.
  const allIds = new Set(snap.initiatives.map(i => i.id));
  for (const c of result.changes) {
    if ('initiative_id' in c && c.initiative_id) {
      assert.ok(allIds.has(c.initiative_id), `hallucinated id: ${c.initiative_id}`);
    }
  }
  // The epic should appear in the parsed initiative matches.
  assert.ok(result.parsed.initiative_matches.some(m => m.initiative_id === initA.id));
});

test('synthesizeImpactAnalysis: ISO date range parsed into a date_window', () => {
  const ws = freshWorkspace();
  seedNamedAgent(ws, 'Sarah');
  const snap = getRoadmapSnapshot({ workspace_id: ws });
  const result = synthesizeImpactAnalysis(snap, 'Sarah out 2026-05-01 to 2026-05-05');
  const window = result.parsed.date_windows[0];
  assert.ok(window);
  assert.equal(window.start, '2026-05-01');
  assert.equal(window.end, '2026-05-05');
});

test('synthesizeImpactAnalysis: explicit date + delay verb → shift_initiative_target', () => {
  const ws = freshWorkspace();
  const init = createInitiative({ workspace_id: ws, kind: 'milestone', title: 'Customer demo' });
  const snap = getRoadmapSnapshot({ workspace_id: ws });
  const result = synthesizeImpactAnalysis(snap, 'Customer demo delayed until 2026-06-15');
  const shift = result.changes.find(c => c.kind === 'shift_initiative_target');
  assert.ok(shift);
  if (shift?.kind === 'shift_initiative_target') {
    assert.equal(shift.initiative_id, init.id);
    assert.equal(shift.target_end, '2026-06-15');
  }
});

// ─── dispatchPm ────────────────────────────────────────────────────

test('dispatchPm: persists a draft proposal AND posts to PM chat with metadata', () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  const sarahId = seedNamedAgent(ws, 'Sarah');

  const result = dispatchPm({
    workspace_id: ws,
    trigger_text: 'Sarah out 2026-05-01 to 2026-05-05',
  });
  assert.equal(result.used_synthesize_fallback, true);
  assert.equal(result.proposal.workspace_id, ws);
  assert.equal(result.proposal.status, 'draft');

  // Chat message with metadata.proposal_id present.
  const pm = queryOne<{ id: string }>(
    `SELECT id FROM agents WHERE workspace_id = ? AND role = 'pm'`,
    [ws],
  );
  assert.ok(pm);
  const messages = queryAll<{ role: string; metadata: string | null; content: string }>(
    `SELECT role, metadata, content FROM agent_chat_messages WHERE agent_id = ? ORDER BY created_at`,
    [pm!.id],
  );
  assert.ok(messages.length >= 2, 'expected user + assistant messages');
  const assistant = messages.find(m => m.role === 'assistant');
  assert.ok(assistant);
  assert.ok(assistant!.metadata);
  const meta = JSON.parse(assistant!.metadata!) as { proposal_id?: string };
  assert.equal(meta.proposal_id, result.proposal.id);

  // Generated availability is for Sarah specifically.
  const avail = result.proposal.proposed_changes.find(c => c.kind === 'add_availability');
  if (avail?.kind === 'add_availability') {
    assert.equal(avail.agent_id, sarahId);
  } else {
    assert.fail('expected an add_availability diff');
  }
});

test('dispatchPm: returns a usable proposal even when nothing is parsed', () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  const result = dispatchPm({ workspace_id: ws, trigger_text: 'qqq xyz' });
  assert.equal(result.proposal.status, 'draft');
  assert.equal(result.proposal.proposed_changes.length, 0);
  assert.match(result.proposal.impact_md, /could not extract|No structured changes/);
});
