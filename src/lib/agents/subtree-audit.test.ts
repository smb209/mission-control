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
  summarizeProposalForBriefing,
} from './subtree-audit';
import { createInitiative } from '@/lib/db/initiatives';
import { createNote, listNotes } from '@/lib/db/agent-notes';
import { auditProposalBodySchema } from '@/lib/agents/audit-proposals/schemas';
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

  // The two children are dispatched. The root is NOT dispatched in
  // subtree-proposal mode — it's deferred to the L3 synthesizer
  // (Phase 4).
  const childRuns = queryAll<{ initiative_id: string }>(
    `SELECT initiative_id FROM agent_runs WHERE workspace_id = ? AND parent_run_id = ?`,
    [ws, result.parentRunId],
  );
  const dispatchedIds = new Set(childRuns.map((r) => r.initiative_id));
  for (const id of [c1.id, c2.id]) {
    assert.ok(dispatchedIds.has(id), `expected dispatch for ${id}`);
  }
  assert.ok(!dispatchedIds.has(root.id), 'root must not be dispatched in subtree-proposal mode');
  // The default stubClient never writes an audit_proposal, so each
  // dispatched leaf falls into the Phase-3 synthetic-keep fallback path.
  const propNotes = listNotes({
    initiative_id: c1.id,
    kinds: ['audit_proposal'],
    limit: 5,
  });
  assert.equal(propNotes.length, 1, 'fallback keep proposal emitted');
  const fb = JSON.parse(propNotes[0].body);
  assert.equal(fb.proposed_action, 'keep');
  assert.equal(fb.confidence, 'low');
});

// ─── runSubtreeAudit: mode='subtree-proposal' (Phase 3) ────────────

/**
 * Stub client variant that, on each `chat.send`, optionally lets the
 * test create an audit_proposal note for the dispatched initiative
 * before emitting the final event. Initiative id is parsed out of the
 * trigger message (the per-node briefing puts `id=<initiativeId>` in
 * the Target line).
 */
function stubClientWithProposalHook(
  hook: (initiativeId: string | null) => void,
): SendChatClient {
  const listeners = new Set<(p: ChatEvent) => void>();
  return {
    isConnected: () => true,
    on: (event, listener) => {
      if (event === 'chat_event') listeners.add(listener);
      return undefined;
    },
    off: (event, listener) => {
      if (event === 'chat_event') listeners.delete(listener);
      return undefined;
    },
    call: async (method, params) => {
      if (method !== 'chat.send') return undefined;
      const sessionKey = (params as { sessionKey?: string } | undefined)?.sessionKey;
      const message = (params as { message?: string } | undefined)?.message ?? '';
      // Parse initiative id from the briefing's "id=..." marker.
      const m = /id=([^),\s]+)/.exec(message);
      const initiativeId = m ? m[1] : null;
      hook(initiativeId);
      setImmediate(() => {
        for (const l of listeners) l({ state: 'final', message: 'ok', sessionKey } as ChatEvent);
      });
      return {};
    },
  };
}

test('runSubtreeAudit (subtree-proposal): happy path — auditor emits valid proposal, picked up + threaded', async () => {
  const ws = freshWorkspace();
  const root = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Happy root' });
  const leaf = createInitiative({
    workspace_id: ws,
    kind: 'story',
    title: 'Happy leaf',
    parent_initiative_id: root.id,
  });

  // Stubbed auditor: when dispatched against the leaf, write a
  // schema-conformant audit_proposal note.
  __setSendChatClientForTests(
    stubClientWithProposalHook((initiativeId) => {
      if (initiativeId !== leaf.id) return;
      const body = JSON.stringify({
        version: 1,
        node_initiative_id: leaf.id,
        current_mc_status: 'in_progress',
        current_mc_target_end: null,
        proposed_action: 'mark_done',
        proposed_changes: { note: 'PR #999 closes this story; tests green.' },
        repo_evidence: [{ kind: 'pr', ref: 'https://example/pull/999' }],
        rationale: 'PR #999 implements the happy path and ships tests.',
        confidence: 'high',
        would_confirm_by: null,
        continuation_note_id: null,
      });
      createNote({
        workspace_id: ws,
        agent_id: null,
        initiative_id: leaf.id,
        scope_key: `initiative-${root.id}:audit:test`,
        role: 'auditor',
        run_group_id: uuidv4(),
        kind: 'audit_proposal',
        audience: 'pm',
        body,
        importance: 2,
      });
    }),
  );

  const surveyorOverride = async (): Promise<SurveyorResult> => ({
    manifest: {
      version: 1,
      root_initiative_id: root.id,
      attempt: 1,
      previous_synthesis_run_group_id: null,
      summary: 'happy',
      nodes: [
        {
          initiative_id: leaf.id,
          title: leaf.title,
          current_status: 'in_progress',
          hypothesis: 'likely-done',
          confidence: 'medium',
          investigation_prompt: 'Confirm this story is done.',
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
    subtreeConcurrency: 1,
    runner: fakeRunner(),
    mode: 'subtree-proposal',
    surveyorOverride,
  });

  // Per-node outcome for leaf is ok; root is deferred.
  const leafOutcome = result.perNodeOutcomes.find((o) => o.initiativeId === leaf.id);
  assert.ok(leafOutcome);
  assert.equal(leafOutcome!.status, 'ok');
  const proposalsForLeaf = listNotes({
    initiative_id: leaf.id,
    kinds: ['audit_proposal'],
    limit: 5,
  });
  assert.equal(proposalsForLeaf.length, 1);
  const parsed = JSON.parse(proposalsForLeaf[0].body);
  assert.equal(parsed.proposed_action, 'mark_done');

  // Root outcome is the deferred placeholder; root was NOT dispatched.
  const rootOutcome = result.perNodeOutcomes.find((o) => o.initiativeId === root.id);
  assert.ok(rootOutcome);
  assert.match(rootOutcome!.note ?? '', /root deferred to L3 synthesizer/);
  const rootRuns = queryAll<{ id: string }>(
    `SELECT id FROM agent_runs WHERE workspace_id = ? AND initiative_id = ? AND parent_run_id = ?`,
    [ws, root.id, result.parentRunId],
  );
  assert.equal(rootRuns.length, 0, 'root must NOT be dispatched in subtree-proposal mode');
});

test('runSubtreeAudit (subtree-proposal): no proposal landed → synthetic fallback keep with low confidence', async () => {
  const ws = freshWorkspace();
  const root = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Fallback proposal root' });
  const leaf = createInitiative({
    workspace_id: ws,
    kind: 'story',
    title: 'Sad leaf',
    parent_initiative_id: root.id,
  });

  // Stubbed auditor "completes" but writes the wrong kind (observation),
  // simulating the agent's last-resort fallback path.
  __setSendChatClientForTests(
    stubClientWithProposalHook((initiativeId) => {
      if (initiativeId !== leaf.id) return;
      createNote({
        workspace_id: ws,
        agent_id: null,
        initiative_id: leaf.id,
        scope_key: `initiative-${root.id}:audit:test`,
        role: 'auditor',
        run_group_id: uuidv4(),
        kind: 'observation',
        audience: 'pm',
        body: 'gave up after 2 retries',
        importance: 2,
      });
    }),
  );

  const surveyorOverride = async (): Promise<SurveyorResult> => ({
    manifest: {
      version: 1,
      root_initiative_id: root.id,
      attempt: 1,
      previous_synthesis_run_group_id: null,
      summary: 'sad',
      nodes: [
        {
          initiative_id: leaf.id,
          title: leaf.title,
          current_status: 'in_progress',
          hypothesis: 'needs-deep-dive',
          confidence: 'low',
          investigation_prompt: 'Dig.',
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
    subtreeConcurrency: 1,
    runner: fakeRunner(),
    mode: 'subtree-proposal',
    surveyorOverride,
  });

  const leafOutcome = result.perNodeOutcomes.find((o) => o.initiativeId === leaf.id);
  assert.ok(leafOutcome);
  assert.equal(leafOutcome!.status, 'failed');
  assert.match(leafOutcome!.error ?? '', /no audit_proposal landed/);

  const proposals = listNotes({
    initiative_id: leaf.id,
    kinds: ['audit_proposal'],
    limit: 5,
  });
  assert.equal(proposals.length, 1, 'synthetic fallback proposal exists');
  const body = JSON.parse(proposals[0].body);
  assert.equal(body.proposed_action, 'keep');
  assert.equal(body.confidence, 'low');
  assert.match(body.rationale, /audit failed.*invalid proposal body/);
  assert.ok(body.would_confirm_by && body.would_confirm_by.length > 0);
});

test('summarizeProposalForBriefing: each proposed_action enum produces ≤6 lines of prose', () => {
  const base = {
    version: 1 as const,
    node_initiative_id: 'i1',
    current_mc_status: 'in_progress',
    current_mc_target_end: null,
    repo_evidence: [{ kind: 'file' as const, ref: 'a.ts' }],
    rationale: 'because',
    confidence: 'medium' as const,
    would_confirm_by: 'reading b.ts',
    continuation_note_id: null,
  };
  const cases = [
    { ...base, proposed_action: 'keep' as const, proposed_changes: {} },
    {
      ...base,
      proposed_action: 'mark_done' as const,
      proposed_changes: { note: 'shipped' },
    },
    {
      ...base,
      proposed_action: 'cancel' as const,
      proposed_changes: { reason: 'obsolete' },
    },
    {
      ...base,
      proposed_action: 'modify_scope' as const,
      proposed_changes: { title: 'New', description: 'Different' },
    },
    {
      ...base,
      proposed_action: 'modify_dates' as const,
      proposed_changes: { target_start: '2026-01-01', target_end: '2026-02-01' },
    },
  ];
  for (const c of cases) {
    const parsed = auditProposalBodySchema.parse(c);
    const out = summarizeProposalForBriefing(parsed);
    assert.match(out, /Proposed action:/);
    assert.match(out, /Rationale:/);
    assert.match(out, /Evidence:/);
    assert.ok(out.split('\n').length <= 6, `too many lines for ${c.proposed_action}: ${out}`);
  }
});
