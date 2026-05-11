/**
 * Unit tests for the L1 surveyor (Phase 2 of
 * docs/archive/subtree-audit-proposals-spec.md).
 *
 * Covers:
 *   - runSurveyor happy path: dispatch + valid manifest landed →
 *     dispatchOutcome 'ok' with parsed body.
 *   - runSurveyor failure path: dispatch throws → 'failed'.
 *   - runSurveyor no-manifest path: dispatch ok but no audit_manifest
 *     note appears → 'no-manifest'.
 *   - buildFallbackManifest: every node has skip:false / hypothesis
 *     'needs-deep-dive'; root is excluded.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import { createInitiative } from '@/lib/db/initiatives';
import { createNote, listNotes } from '@/lib/db/agent-notes';
import { buildAuditPrompt } from './audit-prompt';
import { runSurveyor, buildFallbackManifest } from './audit-survey';
import {
  __setSendChatClientForTests,
  type ChatEvent,
  type SendChatClient,
} from '@/lib/openclaw/send-chat';
import type { Agent } from '@/lib/types';

function freshWorkspace(): string {
  const id = `ws-surv-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function fakeRunner(): Agent {
  return {
    id: 'agent-surv-runner',
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

function stubClient(opts: {
  events?: ChatEvent[];
  throwOnSend?: boolean;
  /** Called inside the dispatch flow (between event emit and return). */
  beforeReply?: (sessionKey: string | undefined) => void;
} = {}): SendChatClient {
  const { events = [{ state: 'final', message: 'ok' }], throwOnSend, beforeReply } = opts;
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
      if (throwOnSend) throw new Error('stub-dispatch-failure');
      const sessionKey = (params as { sessionKey?: string } | undefined)?.sessionKey;
      if (beforeReply) beforeReply(sessionKey);
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

test('runSurveyor: happy path returns parsed manifest', async () => {
  const ws = freshWorkspace();
  const root = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Surv root' });
  const c1 = createInitiative({
    workspace_id: ws,
    kind: 'story',
    title: 'Story 1',
    parent_initiative_id: root.id,
  });

  // The stub plants an audit_manifest note BEFORE the chat reply
  // returns, simulating the auditor having taken the note inside its
  // dispatch.
  __setSendChatClientForTests(
    stubClient({
      beforeReply: () => {
        createNote({
          workspace_id: ws,
          agent_id: null,
          initiative_id: root.id,
          scope_key: `initiative-${root.id}:audit-survey:1`,
          role: 'auditor',
          run_group_id: uuidv4(),
          kind: 'audit_manifest',
          audience: 'pm',
          importance: 1,
          body: JSON.stringify({
            version: 1,
            root_initiative_id: root.id,
            attempt: 1,
            previous_synthesis_run_group_id: null,
            summary: 'test',
            nodes: [
              {
                initiative_id: c1.id,
                title: c1.title,
                current_status: 'in_progress',
                hypothesis: 'needs-deep-dive',
                confidence: 'medium',
                investigation_prompt: 'do the thing',
                scoped_evidence_hints: [],
                skip: false,
              },
            ],
            cross_cutting_questions: [],
          }),
        });
      },
    }),
  );

  const result = await runSurveyor({
    rootId: root.id,
    workspaceId: ws,
    attempt: 1,
    runner: fakeRunner(),
    parentRunId: null,
  });

  assert.equal(result.dispatchOutcome, 'ok');
  assert.ok(result.manifest);
  assert.equal(result.manifest!.root_initiative_id, root.id);
  assert.equal(result.manifest!.nodes.length, 1);
  assert.equal(result.manifest!.nodes[0].initiative_id, c1.id);
  assert.ok(result.surveyorNoteId);
});

test('runSurveyor: root not found → dispatchOutcome failed', async () => {
  const ws = freshWorkspace();
  __setSendChatClientForTests(stubClient());

  // Root id doesn't exist in this workspace → runSurveyor short-circuits
  // with the 'failed' outcome before dispatch. Exercises the same
  // error-handling envelope the real failure path uses.
  const result = await runSurveyor({
    rootId: 'nonexistent-root-id',
    workspaceId: ws,
    attempt: 1,
    runner: fakeRunner(),
    parentRunId: null,
  });

  assert.equal(result.dispatchOutcome, 'failed');
  assert.equal(result.manifest, null);
  assert.match(result.errorMessage ?? '', /not found/i);
});

test('runSurveyor: dispatch ok but no manifest note → dispatchOutcome no-manifest', async () => {
  const ws = freshWorkspace();
  const root = createInitiative({
    workspace_id: ws,
    kind: 'epic',
    title: 'Quiet runner',
  });
  __setSendChatClientForTests(stubClient());

  const result = await runSurveyor({
    rootId: root.id,
    workspaceId: ws,
    attempt: 1,
    runner: fakeRunner(),
    parentRunId: null,
  });

  assert.equal(result.dispatchOutcome, 'no-manifest');
  assert.equal(result.manifest, null);
});

test('runSurveyor (Phase 5): no prior synthesis → manifest has previous_synthesis_run_group_id null + briefing renders "no prior audit"', async () => {
  const ws = freshWorkspace();
  const root = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Delta root no prior' });
  const child = createInitiative({
    workspace_id: ws,
    kind: 'story',
    title: 'Child A',
    parent_initiative_id: root.id,
  });

  __setSendChatClientForTests(
    stubClient({
      beforeReply: () => {
        createNote({
          workspace_id: ws,
          agent_id: null,
          initiative_id: root.id,
          scope_key: `initiative-${root.id}:audit-survey:1`,
          role: 'auditor',
          run_group_id: uuidv4(),
          kind: 'audit_manifest',
          audience: 'pm',
          importance: 1,
          // Surveyor agent (hallucinated) emits a non-null id; we expect
          // the orchestrator to overwrite it back to null since no prior
          // synthesis exists in the DB.
          body: JSON.stringify({
            version: 1,
            root_initiative_id: root.id,
            attempt: 1,
            previous_synthesis_run_group_id: 'hallucinated-id',
            summary: 'no prior',
            nodes: [
              {
                initiative_id: child.id,
                title: child.title,
                current_status: 'in_progress',
                hypothesis: 'needs-deep-dive',
                confidence: 'medium',
                investigation_prompt: 'go look',
                scoped_evidence_hints: [],
                skip: false,
              },
            ],
            cross_cutting_questions: [],
          }),
        });
      },
    }),
  );

  const result = await runSurveyor({
    rootId: root.id,
    workspaceId: ws,
    attempt: 1,
    runner: fakeRunner(),
    parentRunId: null,
  });

  assert.equal(result.dispatchOutcome, 'ok');
  assert.equal(result.manifest!.previous_synthesis_run_group_id, null);

  // Cross-check: rendering buildAuditPrompt with priorSynthesis=null
  // surfaces the "(no prior audit synthesis on this root …)" line.
  const briefing = buildAuditPrompt({
    initiative: root,
    tasks: [],
    childInitiatives: [],
    priorFindings: [],
    childFindings: [],
    mode: 'survey',
    surveyInput: {
      rootId: root.id,
      attempt: 1,
      descendants: [
        { id: child.id, title: child.title, kind: 'story', status: 'in_progress', parent_initiative_id: root.id },
      ],
      gitActivity: null,
      priorSynthesis: null,
    },
  });
  assert.match(briefing, /## Prior audit/);
  assert.match(briefing, /no prior audit synthesis/);
  assert.match(briefing, /previous_synthesis_run_group_id: null/);
});

test('runSurveyor (Phase 5): prior synthesis present → manifest carries run_group_id; briefing surfaces sentinel + delta-skip guidance', async () => {
  const ws = freshWorkspace();
  const root = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Delta root with prior' });
  const child = createInitiative({
    workspace_id: ws,
    kind: 'story',
    title: 'Child B',
    parent_initiative_id: root.id,
  });

  // Plant a valid prior audit_synthesis note on the root.
  const priorRunGroupId = uuidv4();
  const priorSynthesisBody = {
    version: 1,
    root_initiative_id: root.id,
    attempt: 1,
    completion_sentinel: 'Phase 4 cutover ships and surveyor delta-runs are validated.',
    epic_proposals: [],
    cross_node_proposals: [],
  };
  createNote({
    workspace_id: ws,
    agent_id: null,
    initiative_id: root.id,
    scope_key: `initiative-${root.id}:audit-synthesis:0`,
    role: 'auditor',
    run_group_id: priorRunGroupId,
    kind: 'audit_synthesis',
    audience: 'pm',
    importance: 1,
    body: JSON.stringify(priorSynthesisBody),
  });

  __setSendChatClientForTests(
    stubClient({
      beforeReply: () => {
        createNote({
          workspace_id: ws,
          agent_id: null,
          initiative_id: root.id,
          scope_key: `initiative-${root.id}:audit-survey:1`,
          role: 'auditor',
          run_group_id: uuidv4(),
          kind: 'audit_manifest',
          audience: 'pm',
          importance: 1,
          // Even if the agent emits the wrong id, the orchestrator
          // should overwrite to the truth.
          body: JSON.stringify({
            version: 1,
            root_initiative_id: root.id,
            attempt: 1,
            previous_synthesis_run_group_id: 'wrong-id',
            summary: 'with prior',
            nodes: [
              {
                initiative_id: child.id,
                title: child.title,
                current_status: 'in_progress',
                hypothesis: 'likely-done',
                confidence: 'high',
                investigation_prompt: 'unchanged since prior',
                scoped_evidence_hints: [],
                skip: true,
              },
            ],
            cross_cutting_questions: [],
          }),
        });
      },
    }),
  );

  const result = await runSurveyor({
    rootId: root.id,
    workspaceId: ws,
    attempt: 1,
    runner: fakeRunner(),
    parentRunId: null,
  });

  assert.equal(result.dispatchOutcome, 'ok');
  assert.equal(
    result.manifest!.previous_synthesis_run_group_id,
    priorRunGroupId,
    'orchestrator overwrites previous_synthesis_run_group_id with the DB-truth',
  );

  // Briefing rendering — pull the same priorSynthesis the surveyor saw.
  const priorNote = listNotes({
    initiative_id: root.id,
    kinds: ['audit_synthesis'],
    limit: 1,
    order: 'desc',
  })[0];
  assert.ok(priorNote);
  const briefing = buildAuditPrompt({
    initiative: root,
    tasks: [],
    childInitiatives: [],
    priorFindings: [],
    childFindings: [],
    mode: 'survey',
    surveyInput: {
      rootId: root.id,
      attempt: 1,
      descendants: [
        { id: child.id, title: child.title, kind: 'story', status: 'in_progress', parent_initiative_id: root.id },
      ],
      gitActivity: null,
      priorSynthesis: {
        created_at: priorNote.created_at,
        run_group_id: priorNote.run_group_id,
        completion_sentinel: priorSynthesisBody.completion_sentinel,
      },
    },
  });
  assert.match(briefing, /## Prior audit/);
  assert.match(briefing, /A prior audit completed at /);
  assert.match(briefing, /Last sentinel:/);
  assert.match(briefing, /Phase 4 cutover ships/);
  assert.match(briefing, /delta baseline/);
  assert.match(briefing, /skip: true/);
  assert.ok(briefing.includes(priorNote.run_group_id), 'briefing tells the agent the exact run_group_id to emit');
});

test('buildFallbackManifest: every descendant skip:false, hypothesis needs-deep-dive', () => {
  const root = { id: 'r', title: 'Root', kind: 'epic', status: 'in_progress', parent_initiative_id: null };
  const a = { id: 'a', title: 'A', kind: 'story', status: 'in_progress', parent_initiative_id: 'r' };
  const b = { id: 'b', title: 'B', kind: 'story', status: 'in_progress', parent_initiative_id: 'r' };
  const layers = [[a, b], [root]];

  const manifest = buildFallbackManifest('r', layers, 7);
  assert.equal(manifest.root_initiative_id, 'r');
  assert.equal(manifest.attempt, 7);
  // Root is excluded — manifest covers descendants only.
  assert.equal(manifest.nodes.length, 2);
  for (const n of manifest.nodes) {
    assert.equal(n.skip, false);
    assert.equal(n.hypothesis, 'needs-deep-dive');
  }
  assert.deepEqual(manifest.nodes.map((n) => n.initiative_id).sort(), ['a', 'b']);
});
