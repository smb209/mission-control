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
import {
  synthesizeImpactAnalysis,
  dispatchPm,
  dispatchPmSynthesized,
  __setOpenClawClientForTests,
  __setNamedAgentTimeoutForTests,
} from './pm-dispatch';
import type { ChatEvent, SendChatClient } from '@/lib/openclaw/send-chat';
import { createProposal, getProposal } from '@/lib/db/pm-proposals';

/**
 * Build a SendChatClient stub that satisfies both `client.call('chat.send')`
 * and the chat_event subscription surface used by the new
 * `sendChatAndAwaitReply` primitive (PR #N follow-up).
 *
 * Pass `onChatSend` to react to outbound sends (e.g. simulate the agent
 * calling propose_changes via MCP). The stub auto-emits a synthetic
 * `state: 'final'` chat_event after each send unless you set
 * `emitFinal: false` (used to test the timeout path).
 */
function makeFakeClient(opts: {
  isConnected?: boolean;
  emitFinal?: boolean;
  emitDelayMs?: number;
  onChatSend?: (params: Record<string, unknown> | undefined) => void | Promise<void>;
  callOverride?: (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>;
}): {
  client: SendChatClient;
  seenSends: Array<{ method: string; params: unknown }>;
} {
  const seenSends: Array<{ method: string; params: unknown }> = [];
  const listeners = new Set<(payload: ChatEvent) => void>();
  const isConnected = opts.isConnected ?? true;
  const emitFinal = opts.emitFinal ?? true;
  const emitDelayMs = opts.emitDelayMs ?? 0;
  const client: SendChatClient = {
    isConnected: () => isConnected,
    call: async (method: string, params?: Record<string, unknown>) => {
      seenSends.push({ method, params });
      if (opts.callOverride) {
        return opts.callOverride(method, params);
      }
      if (method === 'chat.send') {
        await opts.onChatSend?.(params);
        if (emitFinal) {
          const sessionKey = (params as { sessionKey?: string } | undefined)
            ?.sessionKey;
          const fire = () => {
            for (const l of listeners) {
              try {
                l({ sessionKey, state: 'final' });
              } catch {
                // ignore listener errors
              }
            }
          };
          if (emitDelayMs > 0) setTimeout(fire, emitDelayMs);
          else fire();
        }
      }
      return undefined;
    },
    on: (event, listener) => {
      if (event === 'chat_event') listeners.add(listener);
      return client;
    },
    off: (event, listener) => {
      if (event === 'chat_event') listeners.delete(listener);
      return client;
    },
  };
  return { client, seenSends };
}
import { ensurePmAgent } from '@/lib/bootstrap-agents';

// Concrete gateway link the dispatch tests promote the seeded PM with.
// Pre-migration-061 these were exported from bootstrap-agents as
// hardcoded constants, which baked the prod gateway id into seeded
// workspaces. The new flow lets the operator promote any agent via
// the AgentModal PM checkbox; tests simulate that promotion below.
const TEST_PM_GATEWAY_AGENT_ID = 'mc-project-manager';
const TEST_PM_SESSION_KEY_PREFIX = `agent:${TEST_PM_GATEWAY_AGENT_ID}:main`;

function promotePmToGateway(workspaceId: string): void {
  run(
    `UPDATE agents
        SET gateway_agent_id = ?,
            session_key_prefix = ?,
            source = 'gateway'
      WHERE workspace_id = ? AND is_pm = 1`,
    [TEST_PM_GATEWAY_AGENT_ID, TEST_PM_SESSION_KEY_PREFIX, workspaceId],
  );
}

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

test('synthesizeImpactAnalysis: "next week" starts tomorrow (or next Monday on weekends), matching how operators talk', () => {
  // Today's date is fixed by the test harness; we just assert that the
  // start date is no more than 2 days after today (Sat/Sun → Monday).
  // The pre-fix behavior would land on the Monday of the FOLLOWING ISO
  // week, which can be 8+ days after today.
  const ws = freshWorkspace();
  seedNamedAgent(ws, 'Sarah');
  const snap = getRoadmapSnapshot({ workspace_id: ws });
  const result = synthesizeImpactAnalysis(snap, 'Sarah out next week');
  const window = result.parsed.date_windows[0];
  assert.ok(window, 'expected a parsed date_window');
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  // start should be within [today, today+2] depending on weekday.
  const dayDiff = Math.round((Date.parse(window.start + 'T00:00:00Z') - Date.parse(todayIso + 'T00:00:00Z')) / 86400000);
  assert.ok(dayDiff >= 0 && dayDiff <= 2, `expected next-week start within 0-2 days of today, got ${dayDiff} (start=${window.start}, today=${todayIso})`);
  // end is start + 6 → conversational "Mon through Fri of that week" in practice.
  const endDayDiff = Math.round((Date.parse(window.end + 'T00:00:00Z') - Date.parse(window.start + 'T00:00:00Z')) / 86400000);
  assert.equal(endDayDiff, 6);
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

test('dispatchPm: persists a draft proposal AND posts to PM chat with metadata', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  const sarahId = seedNamedAgent(ws, 'Sarah');

  const result = dispatchPm({
    workspace_id: ws,
    trigger_text: 'Sarah out 2026-05-01 to 2026-05-05',
  });
  // Tier 3 of pm-dispatch-async: dispatchPm returns the synth placeholder
  // synchronously; the named-agent reconciler runs in the background.
  // Await completion to assert the lifecycle settled with the synth-only
  // outcome (no PM agent connected in this test seed).
  const settled = await result.completion;
  assert.equal(settled.used_synthesize_fallback, true);
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

test('dispatchPm: returns a usable proposal even when nothing is parsed', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  const result = dispatchPm({ workspace_id: ws, trigger_text: 'qqq xyz' });
  await result.completion;
  assert.equal(result.proposal.status, 'draft');
  assert.equal(result.proposal.proposed_changes.length, 0);
  assert.match(result.proposal.impact_md, /could not extract|No structured changes/);
});

// ─── Bootstrap: PM is now a named gateway agent ────────────────────

test('ensurePmAgent: seeds a generic local PM placeholder with is_pm=1', () => {
  const ws = freshWorkspace();
  const r = ensurePmAgent(ws);
  assert.equal(r.created, true);
  const row = queryOne<{
    name: string;
    avatar_emoji: string;
    role: string;
    source: string;
    is_pm: number;
    gateway_agent_id: string | null;
    session_key_prefix: string | null;
  }>(
    `SELECT name, avatar_emoji, role, source, is_pm, gateway_agent_id, session_key_prefix
       FROM agents WHERE id = ?`,
    [r.id],
  );
  assert.ok(row);
  assert.equal(row!.role, 'pm');
  assert.equal(row!.is_pm, 1);
  assert.equal(row!.source, 'local');
  // Pre-061 the seed baked the prod gateway link in here; post-061 the
  // operator promotes a real gateway agent via the AgentModal checkbox.
  assert.equal(row!.gateway_agent_id, null);
  assert.equal(row!.session_key_prefix, null);
  assert.equal(row!.name, 'PM');
  assert.equal(row!.avatar_emoji, '📋');
});

// ─── Named-agent dispatch routing ──────────────────────────────────

test('dispatchPm: routes through named agent when openclaw is connected; mock creates proposal via propose_changes simulation', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  promotePmToGateway(ws);

  // The named agent would call propose_changes via MCP. Our mock client
  // simulates that side effect: when chat.send is invoked, it inserts a
  // pm_proposals row with rich impact_md, then auto-emits a final
  // chat_event so `sendChatAndAwaitReply` resolves immediately. The
  // dispatch handler then queries pm_proposals and returns the row.
  const { client: fakeClient, seenSends } = makeFakeClient({
    onChatSend: () => {
      // Simulate the agent calling propose_changes via MCP.
      createProposal({
        workspace_id: ws,
        trigger_text: 'named-agent dispatch',
        trigger_kind: 'manual',
        impact_md: '### Named-agent verdict\n\n- richer than synth',
        proposed_changes: [],
      });
    },
  });
  __setOpenClawClientForTests(fakeClient);
  __setNamedAgentTimeoutForTests(2_000);

  try {
    const result = dispatchPm({
      workspace_id: ws,
      trigger_text: 'Operator says we lost a sprint',
    });
    // Synth placeholder returned synchronously; agent supersedes via the
    // background reconciler.
    assert.equal(result.awaiting_agent, true);
    const settled = await result.completion;
    assert.equal(settled.used_synthesize_fallback, false);
    assert.equal(settled.used_named_agent, true);
    assert.match(settled.final.impact_md, /Named-agent verdict/);
    // chat.send went to the canonical PM session.
    const send = seenSends.find(s => s.method === 'chat.send');
    assert.ok(send);
    const sk = (send!.params as { sessionKey?: string }).sessionKey;
    assert.equal(sk, `agent:${TEST_PM_GATEWAY_AGENT_ID}:main:dispatch-main`);
    // Identity preamble must embed the PM's MC agent_id (UUID) so the agent
    // can call propose_changes without round-tripping whoami — required since
    // PR #133 made gateway_agent_id ambiguous across cloned workspaces.
    const pm = queryOne<{ id: string }>(
      `SELECT id FROM agents WHERE workspace_id = ? AND is_pm = 1`,
      [ws],
    );
    assert.ok(pm);
    const msg = (send!.params as { message?: string }).message ?? '';
    assert.match(msg, new RegExp(`Your agent_id is: ${pm!.id}`));
    assert.match(msg, new RegExp(`Your gateway_agent_id is: ${TEST_PM_GATEWAY_AGENT_ID}`));
  } finally {
    __setOpenClawClientForTests(null);
    __setNamedAgentTimeoutForTests(null);
  }
});

test('dispatchPm: falls back to synth when openclaw client is offline', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  promotePmToGateway(ws);
  seedNamedAgent(ws, 'Sarah');

  const { client } = makeFakeClient({ isConnected: false });
  __setOpenClawClientForTests(client);

  try {
    const result = dispatchPm({
      workspace_id: ws,
      trigger_text: 'Sarah out next week',
    });
    // Gateway down → no background reconciler runs; placeholder is the
    // operator's final draft, marked synth_only.
    assert.equal(result.awaiting_agent, false);
    const settled = await result.completion;
    assert.equal(settled.used_synthesize_fallback, true);
    assert.equal(settled.used_named_agent, false);
    // The synth path produced a real availability diff.
    const avail = result.proposal.proposed_changes.find(c => c.kind === 'add_availability');
    assert.ok(avail, 'expected synth fallback to produce add_availability');
  } finally {
    __setOpenClawClientForTests(null);
  }
});

test('dispatchPm: falls back to synth when named-agent send throws', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  promotePmToGateway(ws);
  seedNamedAgent(ws, 'Sarah');

  const { client } = makeFakeClient({
    callOverride: async () => {
      throw new Error('gateway boom');
    },
  });
  __setOpenClawClientForTests(client);
  __setNamedAgentTimeoutForTests(500);

  try {
    const result = dispatchPm({
      workspace_id: ws,
      trigger_text: 'Sarah out next week',
    });
    const settled = await result.completion;
    assert.equal(settled.used_synthesize_fallback, true);
    assert.equal(settled.used_named_agent, false);
    assert.equal(settled.final.status, 'draft');
  } finally {
    __setOpenClawClientForTests(null);
    __setNamedAgentTimeoutForTests(null);
  }
});

test('dispatchPm: falls back to synth when named agent times out without writing', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  promotePmToGateway(ws);

  // emitFinal: false → no chat_event arrives, await primitive will time out.
  const { client } = makeFakeClient({ emitFinal: false });
  __setOpenClawClientForTests(client);
  __setNamedAgentTimeoutForTests(500);

  try {
    const result = dispatchPm({
      workspace_id: ws,
      trigger_text: 'no agent will respond',
    });
    const settled = await result.completion;
    assert.equal(settled.used_synthesize_fallback, true);
    assert.equal(settled.used_named_agent, false);
    assert.match(settled.final.impact_md, /No structured changes|could not extract/);
  } finally {
    __setOpenClawClientForTests(null);
    __setNamedAgentTimeoutForTests(null);
  }
});

// ─── notes_intake + allowFallback ──────────────────────────────────

test('dispatchPm: notes_intake uses a fresh per-correlation session and the notes prompt', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  promotePmToGateway(ws);

  const { client, seenSends } = makeFakeClient({
    onChatSend: () => {
      createProposal({
        workspace_id: ws,
        trigger_text: 'notes',
        trigger_kind: 'notes_intake',
        impact_md: '### Notes intake verdict\n\n- task list',
        proposed_changes: [],
      });
    },
  });
  __setOpenClawClientForTests(client);
  __setNamedAgentTimeoutForTests(2_000);

  try {
    const result = dispatchPm({
      workspace_id: ws,
      trigger_text: 'Stand-up notes:\n- ship onboarding\n- fix #123',
      trigger_kind: 'notes_intake',
    });
    const settled = await result.completion;
    assert.equal(settled.used_named_agent, true);
    const send = seenSends.find(s => s.method === 'chat.send');
    assert.ok(send);
    const params = send!.params as { sessionKey?: string; message?: string };
    // Fresh notes-<correlation> session, NOT the stable dispatch-main key.
    assert.match(params.sessionKey ?? '', /:notes-/);
    // Prompt template includes the notes-intake instructions.
    assert.match(params.message ?? '', /PM notes intake/);
    assert.match(params.message ?? '', /create_task_under_initiative/);
  } finally {
    __setOpenClawClientForTests(null);
    __setNamedAgentTimeoutForTests(null);
  }
});

test('dispatchPm: allowFallback=false propagates gateway error instead of synth-falling-back', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  promotePmToGateway(ws);

  // Gateway is down — synth path should be skipped.
  const { client } = makeFakeClient({ isConnected: false });
  __setOpenClawClientForTests(client);
  const { PmDispatchGatewayUnavailableError } = await import('./pm-dispatch');
  try {
    // dispatchPm is now synchronous; allowFallback:false + gateway down
    // throws immediately before any placeholder is created.
    assert.throws(
      () =>
        dispatchPm({
          workspace_id: ws,
          trigger_text: 'notes go here',
          trigger_kind: 'notes_intake',
          allowFallback: false,
        }),
      PmDispatchGatewayUnavailableError,
    );
  } finally {
    __setOpenClawClientForTests(null);
  }
});

test('dispatchPm: allowFallback=false + gateway-up but agent silent → completion.used_named_agent === false', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  promotePmToGateway(ws);

  // Gateway up, but the agent emits final without writing a propose_changes
  // row. The reconciler tail expires; completion settles synth_only.
  const { client } = makeFakeClient({ emitFinal: true });
  __setOpenClawClientForTests(client);
  __setNamedAgentTimeoutForTests(500);
  try {
    const result = dispatchPm({
      workspace_id: ws,
      trigger_text: 'whatever',
      trigger_kind: 'notes_intake',
      allowFallback: false,
    });
    // With Tier 3, dispatchPm always returns the placeholder synchronously
    // even with allowFallback:false — the strict-gateway behavior is
    // delegated to callers (e.g. propose_from_notes) that await completion
    // and act on `used_named_agent === false`.
    assert.equal(result.awaiting_agent, true);
    const settled = await result.completion;
    assert.equal(settled.used_named_agent, false);
    assert.equal(settled.final.dispatch_state, 'synth_only');
  } finally {
    __setOpenClawClientForTests(null);
    __setNamedAgentTimeoutForTests(null);
  }
});

// ─── pm-pending-drain ──────────────────────────────────────────────

test('drainPendingNotes: skips when gateway is down', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  promotePmToGateway(ws);
  const { enqueuePendingNote } = await import('@/lib/db/pm-pending-notes');
  enqueuePendingNote({ workspace_id: ws, agent_id: 'a', notes_text: 'x' });

  const { client } = makeFakeClient({ isConnected: false });
  __setOpenClawClientForTests(client);
  const { drainPendingNotes, __setGatewayProbeForTests } = await import('./pm-pending-drain');
  __setGatewayProbeForTests({ isConnected: () => false });
  try {
    const result = await drainPendingNotes();
    assert.equal(result.skipped_gateway_down, true);
    assert.equal(result.attempted, 0);
  } finally {
    __setOpenClawClientForTests(null);
    __setGatewayProbeForTests(null);
  }
});

test('drainPendingNotes: dispatches each pending row and marks dispatched', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  promotePmToGateway(ws);
  // Earlier tests in the file may leave pending rows whose workspace
  // PMs aren't wired up to this fake client. Skip them so the drain
  // loop processes our row only.
  run(`UPDATE pm_pending_notes SET status = 'dispatched' WHERE status = 'pending'`);
  const { enqueuePendingNote, getPendingNote } = await import('@/lib/db/pm-pending-notes');
  const note = enqueuePendingNote({
    workspace_id: ws,
    agent_id: 'a',
    notes_text: 'queued notes',
  });

  const { client } = makeFakeClient({
    onChatSend: () => {
      createProposal({
        workspace_id: ws,
        trigger_text: 'queued notes',
        trigger_kind: 'notes_intake',
        impact_md: '### Drained',
        proposed_changes: [],
      });
    },
  });
  __setOpenClawClientForTests(client);
  __setNamedAgentTimeoutForTests(1_000);

  const { drainPendingNotes, __setGatewayProbeForTests } = await import('./pm-pending-drain');
  __setGatewayProbeForTests({ isConnected: () => true });
  try {
    const result = await drainPendingNotes();
    assert.equal(result.skipped_gateway_down, false);
    assert.ok(result.dispatched >= 1);
    const after = getPendingNote(note.id)!;
    assert.equal(after.status, 'dispatched');
    assert.ok(after.proposal_id);
  } finally {
    __setOpenClawClientForTests(null);
    __setNamedAgentTimeoutForTests(null);
    __setGatewayProbeForTests(null);
  }
});

// ─── dispatchPmSynthesized — Tier 1/2/3 (async w/ tail-window reconciler) ──

const baseSynth = {
  impact_md: '### Synth\n- placeholder',
  changes: [],
  plan_suggestions: { refined_description: '_(synth)_', complexity: 'M' as const, target_start: null, target_end: null, dependencies: [], status_check_md: null, owner_agent_id: null },
};

test('dispatchPmSynthesized: returns synth placeholder synchronously when gateway is up', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  promotePmToGateway(ws);
  const { client } = makeFakeClient({
    onChatSend: () => {
      // Simulate the agent landing a proposal via MCP propose_changes.
      createProposal({
        workspace_id: ws,
        trigger_text: 'agent reply',
        trigger_kind: 'manual',
        impact_md: '### Agent reply\n- richer than synth',
        proposed_changes: [],
      });
    },
  });
  __setOpenClawClientForTests(client);
  __setNamedAgentTimeoutForTests(2_000);
  try {
    const dispatch = dispatchPmSynthesized({
      workspace_id: ws,
      trigger_text: 'plan something',
      trigger_kind: 'plan_initiative',
      synth: baseSynth,
      agent_prompt: 'plan it',
    });
    // Returns immediately with the placeholder; agent dispatch runs in background.
    assert.equal(dispatch.proposal.status, 'draft');
    assert.equal(dispatch.proposal.dispatch_state, 'pending_agent');
    assert.equal(dispatch.awaiting_agent, true);
    // Wait for the lifecycle to settle.
    const settled = await dispatch.completion;
    assert.equal(settled.used_named_agent, true);
    // The agent's row supersedes the synth placeholder.
    const placeholder = getProposal(dispatch.proposal.id)!;
    assert.equal(placeholder.status, 'superseded');
    const agentRow = getProposal(settled.final.id)!;
    assert.equal(agentRow.parent_proposal_id, dispatch.proposal.id);
    assert.equal(agentRow.trigger_kind, 'plan_initiative');
    assert.equal(agentRow.dispatch_state, 'agent_complete');
  } finally {
    __setOpenClawClientForTests(null);
    __setNamedAgentTimeoutForTests(null);
  }
});

test('dispatchPmSynthesized: agent supersede re-echoes a chat message anchored to the new proposal id', async () => {
  // Without this re-echo the chat thread keeps anchoring to the
  // (now superseded) synth placeholder and the operator never sees
  // the agent's richer breakdown inline. The right-rail proposals
  // list still surfaces the new row; the chat does not. Mirrors the
  // disruption-path behavior in dispatchPm.
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  promotePmToGateway(ws);
  const agentImpactMd = '### Agent reply\n- 8-story decomposition with deps';
  const { client } = makeFakeClient({
    onChatSend: () => {
      createProposal({
        workspace_id: ws,
        trigger_text: 'agent reply',
        trigger_kind: 'decompose_initiative',
        impact_md: agentImpactMd,
        proposed_changes: [],
      });
    },
  });
  __setOpenClawClientForTests(client);
  __setNamedAgentTimeoutForTests(2_000);
  try {
    const dispatch = dispatchPmSynthesized({
      workspace_id: ws,
      trigger_text: JSON.stringify({ mode: 'decompose_initiative' }),
      trigger_kind: 'decompose_initiative',
      synth: baseSynth,
      agent_prompt: 'decompose it',
    });
    const settled = await dispatch.completion;
    assert.equal(settled.used_named_agent, true);
    const agentRowId = settled.final.id;
    assert.notEqual(agentRowId, dispatch.proposal.id);

    // Note: dispatchPmSynthesized doesn't post the placeholder chat
    // anchor itself — that's the API route caller's job (see e.g.
    // /api/pm/decompose-initiative). What this test asserts is that
    // dispatchPmSynthesized DOES post a re-echo anchored to the
    // agent's superseding row, mirroring dispatchPm's behavior.
    const pm = queryOne<{ id: string }>(
      `SELECT id FROM agents WHERE workspace_id = ? AND role = 'pm'`,
      [ws],
    );
    assert.ok(pm);
    const messages = queryAll<{ role: string; metadata: string | null; content: string }>(
      `SELECT role, metadata, content FROM agent_chat_messages WHERE agent_id = ? ORDER BY created_at`,
      [pm!.id],
    );
    const reEcho = messages.find(m => {
      if (m.role !== 'assistant' || !m.metadata) return false;
      try {
        const meta = JSON.parse(m.metadata) as { proposal_id?: string };
        return meta.proposal_id === agentRowId;
      } catch { return false; }
    });
    assert.ok(
      reEcho,
      `expected a chat message anchored to agent row ${agentRowId}; messages: ${JSON.stringify(messages)}`,
    );
    assert.equal(reEcho!.content, agentImpactMd);
  } finally {
    __setOpenClawClientForTests(null);
    __setNamedAgentTimeoutForTests(null);
  }
});

test('dispatchPmSynthesized: timeoutMs is honored — bumping it lets a slow agent win', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  promotePmToGateway(ws);
  // The fake client emits final 200ms after send; with a 50ms timeout the
  // primary wait fails, but the tail window catches it.
  const { client } = makeFakeClient({
    onChatSend: () => {
      createProposal({
        workspace_id: ws,
        trigger_text: 'slow agent reply',
        trigger_kind: 'manual',
        impact_md: '### Slow agent reply',
        proposed_changes: [],
      });
    },
    emitDelayMs: 200,
  });
  __setOpenClawClientForTests(client);
  __setNamedAgentTimeoutForTests(50);
  try {
    const dispatch = dispatchPmSynthesized({
      workspace_id: ws,
      trigger_text: 'plan slow',
      trigger_kind: 'plan_initiative',
      synth: baseSynth,
      agent_prompt: 'plan it',
      // Generous tail window will catch the agent's late arrival.
    });
    const settled = await dispatch.completion;
    assert.equal(settled.used_named_agent, true);
    assert.notEqual(settled.final.id, dispatch.proposal.id);
  } finally {
    __setOpenClawClientForTests(null);
    __setNamedAgentTimeoutForTests(null);
  }
});

test('dispatchPmSynthesized: synth_only when no agent reply ever arrives', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  promotePmToGateway(ws);
  // No onChatSend → no agent row created. emitFinal default true so wait
  // returns sent:true but findProposal sees nothing.
  const { client } = makeFakeClient({});
  __setOpenClawClientForTests(client);
  __setNamedAgentTimeoutForTests(50);
  try {
    const dispatch = dispatchPmSynthesized({
      workspace_id: ws,
      trigger_text: 'silent agent',
      trigger_kind: 'plan_initiative',
      synth: baseSynth,
      agent_prompt: 'plan it',
    });
    const settled = await dispatch.completion;
    assert.equal(settled.used_named_agent, false);
    assert.equal(settled.final.id, dispatch.proposal.id);
    // Placeholder stays as the operator's draft, marked as synth-only.
    const refreshed = getProposal(dispatch.proposal.id)!;
    assert.equal(refreshed.status, 'draft');
    assert.equal(refreshed.dispatch_state, 'synth_only');
  } finally {
    __setOpenClawClientForTests(null);
    __setNamedAgentTimeoutForTests(null);
  }
});

test('dispatchPmSynthesized: gateway down → synth-only placeholder, no background dispatch', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  promotePmToGateway(ws);
  const { client } = makeFakeClient({ isConnected: false });
  __setOpenClawClientForTests(client);
  try {
    const dispatch = dispatchPmSynthesized({
      workspace_id: ws,
      trigger_text: 'no gateway',
      trigger_kind: 'plan_initiative',
      synth: baseSynth,
      agent_prompt: 'plan it',
    });
    assert.equal(dispatch.awaiting_agent, false);
    assert.equal(dispatch.proposal.dispatch_state, 'synth_only');
    const settled = await dispatch.completion;
    assert.equal(settled.used_named_agent, false);
    assert.equal(settled.final.id, dispatch.proposal.id);
  } finally {
    __setOpenClawClientForTests(null);
  }
});

test('dispatchPmSynthesized: target_initiative_id is stamped on the agent row during supersede', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  promotePmToGateway(ws);
  const init = createInitiative({ workspace_id: ws, kind: 'epic', title: 'Tier-2 target' });
  const { client } = makeFakeClient({
    onChatSend: () => {
      // Agent's propose_changes call lands without target_initiative_id (current MCP shape).
      createProposal({
        workspace_id: ws,
        trigger_text: 'agent reply',
        trigger_kind: 'manual',
        impact_md: '### Plan',
        proposed_changes: [],
      });
    },
  });
  __setOpenClawClientForTests(client);
  __setNamedAgentTimeoutForTests(2_000);
  try {
    const dispatch = dispatchPmSynthesized({
      workspace_id: ws,
      trigger_text: 'plan with target',
      trigger_kind: 'plan_initiative',
      target_initiative_id: init.id,
      synth: baseSynth,
      agent_prompt: 'plan it',
    });
    const settled = await dispatch.completion;
    assert.equal(settled.used_named_agent, true);
    const agentRow = getProposal(settled.final.id)!;
    assert.equal(agentRow.target_initiative_id, init.id);
    assert.equal(agentRow.trigger_kind, 'plan_initiative');
  } finally {
    __setOpenClawClientForTests(null);
    __setNamedAgentTimeoutForTests(null);
  }
});

test('dispatchPmSynthesized: plan_initiative — agent omits target dates → reconciler backfills from synth', async () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  promotePmToGateway(ws);
  // Build a synth that has populated dates (always true in production —
  // synthesizePlanInitiative inserts derived target_start / _end based on
  // complexity).
  const synthWithDates = {
    impact_md: '### Synth\n- placeholder',
    changes: [],
    plan_suggestions: {
      refined_description: '_(synth)_',
      complexity: 'L' as const,
      target_start: '2026-05-01',
      target_end: '2026-06-15',
      dependencies: [],
      status_check_md: null,
      owner_agent_id: null,
    },
  };
  const { client } = makeFakeClient({
    onChatSend: () => {
      // Agent lands its propose_changes call with NULL dates — the
      // observed wild behavior we're fixing.
      createProposal({
        workspace_id: ws,
        trigger_text: 'agent reply',
        trigger_kind: 'manual',
        impact_md: '### Plan\n- something',
        proposed_changes: [],
        plan_suggestions: {
          refined_description: 'agent rewrite',
          complexity: 'L',
          target_start: null,
          target_end: null,
          dependencies: [],
          status_check_md: null,
          owner_agent_id: null,
        },
      });
    },
  });
  __setOpenClawClientForTests(client);
  __setNamedAgentTimeoutForTests(2_000);
  try {
    const dispatch = dispatchPmSynthesized({
      workspace_id: ws,
      trigger_text: 'plan',
      trigger_kind: 'plan_initiative',
      synth: synthWithDates,
      agent_prompt: 'plan it',
    });
    const settled = await dispatch.completion;
    assert.equal(settled.used_named_agent, true);
    const refreshed = getProposal(settled.final.id)!;
    const ps = refreshed.plan_suggestions as { target_start?: string | null; target_end?: string | null; refined_description?: string };
    // Dates filled from synth, but the agent's refined_description is preserved.
    assert.equal(ps.target_start, '2026-05-01');
    assert.equal(ps.target_end, '2026-06-15');
    assert.equal(ps.refined_description, 'agent rewrite');
  } finally {
    __setOpenClawClientForTests(null);
    __setNamedAgentTimeoutForTests(null);
  }
});
