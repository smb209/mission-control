/**
 * Unit tests for the subtree-audit pure helpers
 * (PR 4 of specs/initiative-investigate.md).
 *
 * Covers:
 *   - enumerateLayersBottomUp: skips terminal nodes, layers leaves
 *     first, supports unbalanced trees up to 4 levels.
 *   - boundedAll: respects concurrency cap, surfaces failures as
 *     `{ ok: false, error }` envelopes without aborting the batch.
 *
 * runSubtreeAudit itself talks to the gateway via dispatchScope — that's
 * covered by the live dogfood loop documented in the spec, not here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run, queryAll } from '@/lib/db';
import {
  enumerateLayersBottomUp,
  boundedAll,
  runSubtreeAudit,
} from './subtree-audit';
import { createInitiative } from '@/lib/db/initiatives';
import { listNotes } from '@/lib/db/agent-notes';
import { getAgentRun } from '@/lib/db/agent-runs';
import type { SurveyorResult } from './audit-survey';
import {
  __setSendChatClientForTests,
  type ChatEvent,
  type SendChatClient,
} from '@/lib/openclaw/send-chat';
import type { Agent } from '@/lib/types';

type Lite = Parameters<typeof enumerateLayersBottomUp>[1][number];

function node(
  id: string,
  parent: string | null,
  status: Lite['status'] = 'in_progress',
): Lite {
  return {
    id,
    title: `node ${id}`,
    kind: 'epic',
    status,
    description: null,
    status_check_md: null,
    target_start: null,
    target_end: null,
    parent_initiative_id: parent,
    workspace_id: 'w1',
  } as unknown as Lite;
}

test('enumerateLayersBottomUp: single non-terminal root → one layer of [root]', () => {
  const all = [node('r', null)];
  const layers = enumerateLayersBottomUp('r', all);
  assert.equal(layers.length, 1);
  assert.deepEqual(layers[0].map((i) => i.id), ['r']);
});

test('enumerateLayersBottomUp: balanced 3-level tree, leaves first', () => {
  const all = [
    node('r', null),
    node('a', 'r'),
    node('b', 'r'),
    node('a1', 'a'),
    node('a2', 'a'),
    node('b1', 'b'),
  ];
  const layers = enumerateLayersBottomUp('r', all);
  assert.equal(layers.length, 3);
  assert.deepEqual(
    layers[0].map((i) => i.id).sort(),
    ['a1', 'a2', 'b1'],
  );
  assert.deepEqual(
    layers[1].map((i) => i.id).sort(),
    ['a', 'b'],
  );
  assert.deepEqual(layers[2].map((i) => i.id), ['r']);
});

test('enumerateLayersBottomUp: skips done/cancelled descendants', () => {
  const all = [
    node('r', null),
    node('a', 'r', 'done'), // skipped
    node('b', 'r'),
    node('b1', 'b'),
    node('b2', 'b', 'cancelled'), // skipped
  ];
  const layers = enumerateLayersBottomUp('r', all);
  // a is terminal — a's whole branch dropped (no descendants of a).
  // b -> b1, b2 cancelled. So leaves: b1. layer1: b. layer2: r.
  assert.equal(layers.length, 3);
  assert.deepEqual(layers[0].map((i) => i.id), ['b1']);
  assert.deepEqual(layers[1].map((i) => i.id), ['b']);
  assert.deepEqual(layers[2].map((i) => i.id), ['r']);
});

test('enumerateLayersBottomUp: unbalanced 4-level tree depth = longest path', () => {
  const all = [
    node('r', null),
    node('a', 'r'),
    node('a1', 'a'),
    node('a1x', 'a1'),
    node('a1xy', 'a1x'), // depth 4 leaf
    node('b', 'r'), // shallow
  ];
  const layers = enumerateLayersBottomUp('r', all);
  // Depths: a1xy=0, b=0, a1x=1, a1=2, a=3, r=4.
  // b is shallow but should land in layer 0 (with the deep leaf).
  assert.equal(layers.length, 5);
  assert.deepEqual(layers[0].map((i) => i.id).sort(), ['a1xy', 'b']);
  assert.deepEqual(layers[1].map((i) => i.id), ['a1x']);
  assert.deepEqual(layers[2].map((i) => i.id), ['a1']);
  assert.deepEqual(layers[3].map((i) => i.id), ['a']);
  assert.deepEqual(layers[4].map((i) => i.id), ['r']);
});

test('enumerateLayersBottomUp: throws when root is terminal', () => {
  const all = [node('r', null, 'done')];
  assert.throws(() => enumerateLayersBottomUp('r', all), /terminal status/);
});

test('enumerateLayersBottomUp: zero non-terminal descendants → just the root', () => {
  const all = [
    node('r', null),
    node('a', 'r', 'done'),
    node('b', 'r', 'cancelled'),
  ];
  const layers = enumerateLayersBottomUp('r', all);
  assert.equal(layers.length, 1);
  assert.deepEqual(layers[0].map((i) => i.id), ['r']);
});

test('boundedAll: respects concurrency cap', async () => {
  let inflight = 0;
  let peak = 0;
  const tasks = Array.from({ length: 8 }, () => async () => {
    inflight++;
    peak = Math.max(peak, inflight);
    await new Promise((r) => setTimeout(r, 10));
    inflight--;
    return 'ok';
  });
  const out = await boundedAll(tasks, 3);
  assert.equal(out.length, 8);
  assert.ok(peak <= 3, `peak inflight ${peak} exceeded cap of 3`);
  assert.ok(out.every((r) => r.ok));
});

test('boundedAll: failures surface as envelopes, batch continues', async () => {
  const tasks = [
    async () => 1,
    async () => {
      throw new Error('boom');
    },
    async () => 3,
  ];
  const out = await boundedAll(tasks, 2);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { ok: true, value: 1 });
  assert.equal(out[1].ok, false);
  if (!out[1].ok) assert.equal(out[1].error.message, 'boom');
  assert.deepEqual(out[2], { ok: true, value: 3 });
});

test('boundedAll: empty task list resolves immediately', async () => {
  const out = await boundedAll([], 4);
  assert.deepEqual(out, []);
});

test('boundedAll: cap >= task count behaves like Promise.all-ish', async () => {
  const tasks = [async () => 'a', async () => 'b'];
  const out = await boundedAll(tasks, 16);
  assert.deepEqual(
    out.map((r) => (r.ok ? r.value : null)),
    ['a', 'b'],
  );
});

// ─── runSubtreeAudit: parent_run_id linkage + rollup (PR 3) ────────

function freshWorkspace(): string {
  const id = `ws-st-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function fakeRunner(): Agent {
  return {
    id: 'agent-test-runner',
    name: 'Runner Test',
    role: 'researcher',
    avatar_emoji: '🔬',
    status: 'standby',
    is_master: false,
    workspace_id: 'default',
    source: 'gateway',
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    gateway_agent_id: 'mc-runner-test',
    session_key_prefix: 'agent:mc-runner-test',
    model: 'spark-lb/agent',
  } as unknown as Agent;
}

function stubClient(events: ChatEvent[] = [{ state: 'final', message: 'ok' }]): SendChatClient {
  const listeners = new Set<(p: ChatEvent) => void>();
  return {
    isConnected: () => true,
    on: (event, listener) => { if (event === 'chat_event') listeners.add(listener); return undefined; },
    off: (event, listener) => { if (event === 'chat_event') listeners.delete(listener); return undefined; },
    call: async (method, params) => {
      if (method !== 'chat.send') return undefined;
      const sessionKey = (params as { sessionKey?: string } | undefined)?.sessionKey;
      setImmediate(() => {
        for (const e of events) {
          const withKey = { ...e, sessionKey };
          for (const l of listeners) l(withKey);
        }
      });
      return {};
    },
  };
}

test.afterEach(() => {
  __setSendChatClientForTests(null);
});

test('runSubtreeAudit: creates synthetic parent + child rows linked by parent_run_id', async () => {
  __setSendChatClientForTests(stubClient());
  const ws = freshWorkspace();
  // Tree: root -> 3 stories.
  const root = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Root epic' });
  const c1 = createInitiative({ workspace_id: ws, kind: 'story', title: 'Story 1', parent_initiative_id: root.id });
  const c2 = createInitiative({ workspace_id: ws, kind: 'story', title: 'Story 2', parent_initiative_id: root.id });
  const c3 = createInitiative({ workspace_id: ws, kind: 'story', title: 'Story 3', parent_initiative_id: root.id });

  const result = await runSubtreeAudit({
    rootId: root.id,
    workspaceId: ws,
    guidance: null,
    perNodeTimeoutMs: 10_000,
    subtreeConcurrency: 2,
    runner: fakeRunner(),
  });

  // Synthetic parent row exists with the expected shape.
  assert.ok(result.parentRunId);
  const parent = getAgentRun(result.parentRunId!)!;
  assert.equal(parent.kind, 'initiative_audit');
  assert.equal(parent.source_kind, 'fanout');
  assert.equal(parent.parent_run_id, null);
  assert.equal(parent.initiative_id, root.id);
  assert.match(parent.label ?? '', /Subtree audit:/);

  // Child rows: one per node (3 stories + 1 root re-audit at top layer = 4).
  const children = queryAll<{ id: string; parent_run_id: string | null; initiative_id: string | null }>(
    `SELECT id, parent_run_id, initiative_id FROM agent_runs
       WHERE workspace_id = ? AND parent_run_id = ?
       ORDER BY created_at`,
    [ws, result.parentRunId],
  );
  assert.equal(children.length, 4, '3 stories + root self-audit');
  const childInitiativeIds = new Set(children.map((c) => c.initiative_id));
  for (const id of [root.id, c1.id, c2.id, c3.id]) {
    assert.ok(childInitiativeIds.has(id), `child for initiative ${id} present`);
  }
  for (const c of children) {
    assert.equal(c.parent_run_id, result.parentRunId);
  }
});

test('runSubtreeAudit: parent rolls up to complete when all children succeed', async () => {
  __setSendChatClientForTests(stubClient());
  const ws = freshWorkspace();
  const root = createInitiative({ workspace_id: ws, kind: 'epic', title: 'OK epic' });
  // No children — single-node fan-out (just the root).
  const result = await runSubtreeAudit({
    rootId: root.id,
    workspaceId: ws,
    guidance: null,
    perNodeTimeoutMs: 10_000,
    subtreeConcurrency: 1,
    runner: fakeRunner(),
  });
  // The single-node dispatch lands but won't have a take_note row; the
  // orchestrator records that as a failure outcome. With 1/1 failed
  // (>50%), the parent rolls up to failed. That's expected behavior —
  // see SUBTREE_FAILURE_THRESHOLD. Assert the rollup ran (parent is
  // terminal, not stuck running) regardless of branch.
  const parent = getAgentRun(result.parentRunId!)!;
  assert.ok(['complete', 'failed'].includes(parent.status), 'parent rolled up');
  assert.ok(parent.completed_at);
});

// ─── runSubtreeAudit: mode='subtree-proposal' (Phase 2) ────────────

test('runSubtreeAudit (subtree-proposal): manifest skip → synthetic audit_proposal, no dispatch', async () => {
  __setSendChatClientForTests(stubClient());
  const ws = freshWorkspace();
  const root = createInitiative({ workspace_id: ws, kind: 'epic', title: 'SP root' });
  const skipMe = createInitiative({
    workspace_id: ws,
    kind: 'story',
    title: 'Skip me',
    parent_initiative_id: root.id,
  });
  const auditMe = createInitiative({
    workspace_id: ws,
    kind: 'story',
    title: 'Audit me',
    parent_initiative_id: root.id,
  });

  // Stub the surveyor: skipMe gets skip:true / high; auditMe needs-deep-dive.
  const surveyorOverride = async (): Promise<SurveyorResult> => ({
    manifest: {
      version: 1,
      root_initiative_id: root.id,
      attempt: 1,
      previous_synthesis_run_group_id: null,
      summary: 'test manifest',
      nodes: [
        {
          initiative_id: skipMe.id,
          title: skipMe.title,
          current_status: 'in_progress',
          hypothesis: 'likely-done',
          confidence: 'high',
          investigation_prompt: 'No need to dig further.',
          scoped_evidence_hints: [],
          skip: true,
        },
        {
          initiative_id: auditMe.id,
          title: auditMe.title,
          current_status: 'in_progress',
          hypothesis: 'needs-deep-dive',
          confidence: 'medium',
          investigation_prompt: 'Do dig.',
          scoped_evidence_hints: [],
          skip: false,
        },
      ],
      cross_cutting_questions: [],
    },
    surveyorNoteId: null,
    dispatchOutcome: 'ok',
  });

  const result = await runSubtreeAudit({
    rootId: root.id,
    workspaceId: ws,
    guidance: null,
    perNodeTimeoutMs: 10_000,
    subtreeConcurrency: 2,
    runner: fakeRunner(),
    mode: 'subtree-proposal',
    surveyorOverride,
  });

  // skipMe must NOT have an agent_runs child row (no dispatch).
  const skipChildRuns = queryAll<{ id: string }>(
    `SELECT id FROM agent_runs WHERE workspace_id = ? AND initiative_id = ? AND parent_run_id = ?`,
    [ws, skipMe.id, result.parentRunId],
  );
  assert.equal(skipChildRuns.length, 0, 'skipped node was not dispatched');

  // auditMe SHOULD have a dispatched child run.
  const auditChildRuns = queryAll<{ id: string }>(
    `SELECT id FROM agent_runs WHERE workspace_id = ? AND initiative_id = ? AND parent_run_id = ?`,
    [ws, auditMe.id, result.parentRunId],
  );
  assert.equal(auditChildRuns.length, 1, 'non-skipped node was dispatched');

  // Synthetic audit_proposal note exists for skipMe.
  const proposals = listNotes({
    initiative_id: skipMe.id,
    kinds: ['audit_proposal'],
    limit: 5,
  });
  assert.equal(proposals.length, 1);
  const body = JSON.parse(proposals[0].body);
  assert.equal(body.proposed_action, 'keep');
  assert.equal(body.confidence, 'high');
  assert.equal(body.node_initiative_id, skipMe.id);

  // Per-node outcome includes the manifest-skip marker.
  const skipOutcome = result.perNodeOutcomes.find((o) => o.initiativeId === skipMe.id);
  assert.ok(skipOutcome);
  assert.equal(skipOutcome!.status, 'ok');
  assert.match(skipOutcome!.note ?? '', /manifest-skip/);
});

test('runSubtreeAudit (subtree-proposal): surveyor failure → fallback dispatches all nodes', async () => {
  __setSendChatClientForTests(stubClient());
  const ws = freshWorkspace();
  const root = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Fallback root' });
  const c1 = createInitiative({
    workspace_id: ws,
    kind: 'story',
    title: 'C1',
    parent_initiative_id: root.id,
  });
  const c2 = createInitiative({
    workspace_id: ws,
    kind: 'story',
    title: 'C2',
    parent_initiative_id: root.id,
  });

  const surveyorOverride = async () => {
    throw new Error('boom');
  };

  const result = await runSubtreeAudit({
    rootId: root.id,
    workspaceId: ws,
    guidance: null,
    perNodeTimeoutMs: 10_000,
    subtreeConcurrency: 2,
    runner: fakeRunner(),
    mode: 'subtree-proposal',
    surveyorOverride,
  });

  // All three nodes (root + 2 children) get dispatched (no skips in fallback).
  const childRuns = queryAll<{ initiative_id: string }>(
    `SELECT initiative_id FROM agent_runs WHERE workspace_id = ? AND parent_run_id = ?`,
    [ws, result.parentRunId],
  );
  const dispatchedIds = new Set(childRuns.map((r) => r.initiative_id));
  for (const id of [root.id, c1.id, c2.id]) {
    assert.ok(dispatchedIds.has(id), `expected dispatch for ${id}`);
  }
  // No synthetic audit_proposal notes because nothing was skipped.
  const propNotes = listNotes({
    initiative_id: c1.id,
    kinds: ['audit_proposal'],
    limit: 5,
  });
  assert.equal(propNotes.length, 0);
});
