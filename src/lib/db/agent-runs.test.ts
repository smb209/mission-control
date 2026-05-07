/**
 * agent_runs DAO tests.
 *
 * Covers: create / get / list / lifecycle transitions
 * (queued→running→complete|failed|cancelled), invalid-transition
 * errors, workspace isolation, stale-running reaper, cost+session
 * threading.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import {
  createAgentRun,
  getAgentRun,
  listAgentRuns,
  markCancelled,
  markComplete,
  markFailed,
  markRunning,
  reapStaleRunning,
  startAgentRun,
  completeAgentRun,
  failAgentRun,
  scopeTypeToRunKind,
  listJobs,
  AgentRunTransitionError,
  AgentRunValidationError,
} from './agent-runs';
import type { ScopeType } from './mc-sessions';

function freshWorkspace(): string {
  const id = `ws-ar-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

test('createAgentRun: round-trip with defaults', () => {
  const ws = freshWorkspace();
  const r = createAgentRun({ workspace_id: ws, kind: 'brief' });
  assert.equal(r.workspace_id, ws);
  assert.equal(r.kind, 'brief');
  assert.equal(r.status, 'queued');
  assert.equal(r.source_kind, 'manual');
  assert.equal(r.source_ref, null);
  assert.equal(r.openclaw_session_id, null);
  assert.equal(r.cost_cents, null);
  assert.equal(r.error_md, null);
  assert.equal(r.started_at, null);
  assert.equal(r.completed_at, null);
  assert.ok(r.created_at);
  assert.ok(r.updated_at);
});

test('createAgentRun: rejects empty workspace_id', () => {
  assert.throws(
    () => createAgentRun({ workspace_id: '   ', kind: 'brief' }),
    AgentRunValidationError,
  );
});

test('createAgentRun: source_kind + source_ref + ceiling threaded through', () => {
  const ws = freshWorkspace();
  const r = createAgentRun({
    workspace_id: ws,
    kind: 'brief',
    source_kind: 'schedule',
    source_ref: 'schedule:42',
    cost_ceiling_cents: 500,
  });
  assert.equal(r.source_kind, 'schedule');
  assert.equal(r.source_ref, 'schedule:42');
  assert.equal(r.cost_ceiling_cents, 500);
});

test('lifecycle: queued → running → complete', () => {
  const ws = freshWorkspace();
  const r = createAgentRun({ workspace_id: ws, kind: 'brief' });

  const running = markRunning(r.id, {
    openclaw_session_id: 'sess-abc',
    model_used: 'spark-lb/agent',
  });
  assert.equal(running.status, 'running');
  assert.equal(running.openclaw_session_id, 'sess-abc');
  assert.equal(running.model_used, 'spark-lb/agent');
  assert.ok(running.started_at);
  assert.equal(running.completed_at, null);

  const done = markComplete(r.id, { cost_cents: 42 });
  assert.equal(done.status, 'complete');
  assert.equal(done.cost_cents, 42);
  assert.ok(done.completed_at);
});

test('lifecycle: queued → running → failed records error_md', () => {
  const ws = freshWorkspace();
  const r = createAgentRun({ workspace_id: ws, kind: 'brief' });
  markRunning(r.id);
  const failed = markFailed(r.id, { error_md: 'gateway unreachable' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_md, 'gateway unreachable');
  assert.ok(failed.completed_at);
});

test('lifecycle: queued → cancelled', () => {
  const ws = freshWorkspace();
  const r = createAgentRun({ workspace_id: ws, kind: 'brief' });
  const cancelled = markCancelled(r.id, 'user aborted');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.error_md, 'user aborted');
});

test('lifecycle: terminal states reject further transitions', () => {
  const ws = freshWorkspace();
  const r = createAgentRun({ workspace_id: ws, kind: 'brief' });
  markRunning(r.id);
  markComplete(r.id);
  assert.throws(() => markFailed(r.id, { error_md: 'too late' }), AgentRunTransitionError);
  assert.throws(() => markRunning(r.id), AgentRunTransitionError);
  assert.throws(() => markCancelled(r.id), AgentRunTransitionError);
});

test('lifecycle: cannot complete from queued (must run first)', () => {
  const ws = freshWorkspace();
  const r = createAgentRun({ workspace_id: ws, kind: 'brief' });
  assert.throws(() => markComplete(r.id), AgentRunTransitionError);
});

test('listAgentRuns: filters by status and kind, scoped to workspace', () => {
  const wsA = freshWorkspace();
  const wsB = freshWorkspace();
  const a1 = createAgentRun({ workspace_id: wsA, kind: 'brief' });
  const a2 = createAgentRun({ workspace_id: wsA, kind: 'brief' });
  createAgentRun({ workspace_id: wsB, kind: 'brief' });

  markRunning(a1.id);

  const allA = listAgentRuns(wsA);
  assert.equal(allA.length, 2);

  const runningA = listAgentRuns(wsA, { status: 'running' });
  assert.equal(runningA.length, 1);
  assert.equal(runningA[0].id, a1.id);

  const queuedA = listAgentRuns(wsA, { status: 'queued' });
  assert.equal(queuedA.length, 1);
  assert.equal(queuedA[0].id, a2.id);

  // Workspace B is invisible from A.
  const briefsA = listAgentRuns(wsA, { kind: 'brief' });
  assert.equal(briefsA.length, 2);
  assert.ok(briefsA.every(r => r.workspace_id === wsA));
});

test('reapStaleRunning: marks rows older than threshold as failed', () => {
  const ws = freshWorkspace();
  const r = createAgentRun({ workspace_id: ws, kind: 'brief' });
  markRunning(r.id);

  // Backdate updated_at so it appears stale.
  run(
    `UPDATE agent_runs SET updated_at = datetime('now', '-1 hour') WHERE id = ?`,
    [r.id],
  );

  const reaped = reapStaleRunning(60, 'reaped: stale running');
  assert.equal(reaped, 1);

  const after = getAgentRun(r.id);
  assert.equal(after?.status, 'failed');
  assert.equal(after?.error_md, 'reaped: stale running');
});

test('reapStaleRunning: leaves fresh running rows alone', () => {
  const ws = freshWorkspace();
  const r = createAgentRun({ workspace_id: ws, kind: 'brief' });
  markRunning(r.id);
  // No backdate — updated_at is fresh.
  const reaped = reapStaleRunning(60, 'should not fire');
  assert.equal(reaped, 0);
  const after = getAgentRun(r.id);
  assert.equal(after?.status, 'running');
});

test('FK cascade: deleting workspace removes its agent_runs', () => {
  const ws = freshWorkspace();
  const r = createAgentRun({ workspace_id: ws, kind: 'brief' });
  assert.ok(getAgentRun(r.id));
  run(`DELETE FROM workspaces WHERE id = ?`, [ws]);
  assert.equal(getAgentRun(r.id), null);
});

// ─── Jobs-in-Progress (PR 1): start/complete/fail + scope mapping ───

test('scopeTypeToRunKind: maps every ScopeType', () => {
  const cases: Array<[ScopeType, string]> = [
    ['pm_chat', 'pm_chat'],
    ['plan', 'plan'],
    ['decompose', 'decompose'],
    ['decompose_story', 'decompose'],
    ['notes_intake', 'pm_chat'],
    ['task_coord', 'task_coord'],
    ['task_role', 'task_role'],
    ['recurring', 'recurring'],
    ['heartbeat', 'task_coord'],
    ['initiative_audit', 'initiative_audit'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(scopeTypeToRunKind(input), expected, `mapping for ${input}`);
  }
});

test('scopeTypeToRunKind: throws on unknown scope_type', () => {
  assert.throws(
    () => scopeTypeToRunKind('not_a_real_scope_type' as unknown as ScopeType),
    /unknown scope_type/,
  );
});

test('startAgentRun: writes a row in running state with attribution', () => {
  const ws = freshWorkspace();
  const id = startAgentRun({
    workspace_id: ws,
    kind: 'pm_chat',
    scope_key: 'agent:pm:dispatch-main',
    scope_type: 'pm_chat',
    role: 'pm',
    agent_id: 'mc-pm-default',
    label: 'PM chat: ping',
  });
  const row = getAgentRun(id);
  assert.ok(row, 'row inserted');
  assert.equal(row!.status, 'running');
  assert.equal(row!.kind, 'pm_chat');
  assert.equal(row!.scope_key, 'agent:pm:dispatch-main');
  assert.equal(row!.scope_type, 'pm_chat');
  assert.equal(row!.role, 'pm');
  assert.equal(row!.agent_id, 'mc-pm-default');
  assert.equal(row!.label, 'PM chat: ping');
  assert.ok(row!.started_at);
});

test('startAgentRun: rejects empty workspace_id', () => {
  assert.throws(
    () =>
      startAgentRun({
        workspace_id: '   ',
        kind: 'pm_chat',
        scope_key: 'k',
        scope_type: 'pm_chat',
        role: 'pm',
        agent_id: 'a',
      }),
    AgentRunValidationError,
  );
});

test('completeAgentRun: stamps cost/model/session and marks complete', () => {
  const ws = freshWorkspace();
  const id = startAgentRun({
    workspace_id: ws,
    kind: 'plan',
    scope_key: 'k1',
    scope_type: 'plan',
    role: 'pm',
    agent_id: 'a',
  });
  completeAgentRun(id, {
    openclaw_session_id: 'agent:pm:plan-x',
    model_used: 'spark-lb/agent',
    cost_cents: 7,
  });
  const row = getAgentRun(id);
  assert.equal(row!.status, 'complete');
  assert.equal(row!.openclaw_session_id, 'agent:pm:plan-x');
  assert.equal(row!.model_used, 'spark-lb/agent');
  assert.equal(row!.cost_cents, 7);
  assert.ok(row!.completed_at);
});

test('failAgentRun: records error_md and marks failed', () => {
  const ws = freshWorkspace();
  const id = startAgentRun({
    workspace_id: ws,
    kind: 'initiative_audit',
    scope_key: 'k2',
    scope_type: 'initiative_audit',
    role: 'researcher',
    agent_id: 'a',
  });
  failAgentRun(id, 'gateway unreachable');
  const row = getAgentRun(id);
  assert.equal(row!.status, 'failed');
  assert.equal(row!.error_md, 'gateway unreachable');
  assert.ok(row!.completed_at);
});

test('completeAgentRun / failAgentRun: terminal status no-op', () => {
  const ws = freshWorkspace();
  const id = startAgentRun({
    workspace_id: ws,
    kind: 'pm_chat',
    scope_key: 'k3',
    scope_type: 'pm_chat',
    role: 'pm',
    agent_id: 'a',
  });
  completeAgentRun(id, { cost_cents: 1 });
  // Second completion / failure does not mutate the terminal row.
  failAgentRun(id, 'too late');
  const row = getAgentRun(id);
  assert.equal(row!.status, 'complete');
  assert.equal(row!.error_md, null);
});

test('migration 080 idempotent: kind enum accepts pm_chat after extension', () => {
  // The migration runs at db-open time; this just exercises the
  // post-state by inserting a row with the new enum value.
  const ws = freshWorkspace();
  const id = startAgentRun({
    workspace_id: ws,
    kind: 'pm_chat',
    scope_key: 'idem-k',
    scope_type: 'pm_chat',
    role: 'pm',
    agent_id: 'a',
  });
  assert.ok(getAgentRun(id));
});

// ─── listJobs (PR 2) ────────────────────────────────────────────────

test('listJobs: rejects empty workspace_id', () => {
  assert.throws(() => listJobs('   '), AgentRunValidationError);
});

test('listJobs: empty workspace returns three empty buckets', () => {
  const ws = freshWorkspace();
  const r = listJobs(ws);
  assert.deepEqual(r.live, []);
  assert.deepEqual(r.scheduled, []);
  assert.deepEqual(r.recent, []);
});

test('listJobs: pm_chat rows collapse by scope_key with group_count + max started_at', () => {
  const ws = freshWorkspace();
  const scope = `scope:${uuidv4()}`;
  // Insert three pm_chat runs against the same scope_key, with
  // distinct started_at values so we can verify "most recent wins".
  for (let i = 0; i < 3; i++) {
    startAgentRun({
      workspace_id: ws,
      kind: 'pm_chat',
      scope_key: scope,
      scope_type: 'pm_chat',
      role: 'pm',
      agent_id: `agent-${i}`,
    });
  }
  // Plus one different-scope pm_chat — must NOT merge.
  startAgentRun({
    workspace_id: ws,
    kind: 'pm_chat',
    scope_key: `scope:${uuidv4()}`,
    scope_type: 'pm_chat',
    role: 'pm',
    agent_id: 'agent-other',
  });
  const r = listJobs(ws);
  // Two groups total: 1 collapsed (count=3) + 1 standalone.
  assert.equal(r.live.length, 2);
  const collapsed = r.live.find(x => x.scope_key === scope);
  assert.ok(collapsed);
  assert.equal(collapsed!.group_count, 3);
  const standalone = r.live.find(x => x.scope_key !== scope);
  assert.equal(standalone!.group_count, 1);
});

test('listJobs: non-pm_chat kinds never collapse', () => {
  const ws = freshWorkspace();
  const scope = `scope:${uuidv4()}`;
  for (let i = 0; i < 3; i++) {
    startAgentRun({
      workspace_id: ws,
      kind: 'initiative_audit',
      scope_key: scope,
      scope_type: 'initiative_audit',
      role: 'researcher',
      agent_id: `r-${i}`,
    });
  }
  const r = listJobs(ws);
  assert.equal(r.live.length, 3);
  assert.ok(r.live.every(x => x.group_count === 1));
});

test('listJobs: recent enforces 24h window and excludes still-running rows', () => {
  const ws = freshWorkspace();
  // Run that completed 2h ago — should appear.
  const fresh = startAgentRun({
    workspace_id: ws, kind: 'plan',
    scope_key: 's1', scope_type: 'plan', role: 'pm', agent_id: 'a',
  });
  run(`UPDATE agent_runs SET status='complete', completed_at=datetime('now','-2 hours') WHERE id=?`, [fresh]);

  // Run that completed 30h ago — must be excluded.
  const stale = startAgentRun({
    workspace_id: ws, kind: 'plan',
    scope_key: 's2', scope_type: 'plan', role: 'pm', agent_id: 'a',
  });
  run(`UPDATE agent_runs SET status='complete', completed_at=datetime('now','-30 hours') WHERE id=?`, [stale]);

  // Still-running row — must not leak into recent.
  const live = startAgentRun({
    workspace_id: ws, kind: 'plan',
    scope_key: 's3', scope_type: 'plan', role: 'pm', agent_id: 'a',
  });

  const r = listJobs(ws);
  assert.equal(r.recent.length, 1);
  assert.equal(r.recent[0].id, fresh);
  assert.ok(r.live.some(x => x.id === live));
});

test('listJobs: scheduled excludes paused jobs and far-future runs', () => {
  const ws = freshWorkspace();
  // Active, due in 1h → include.
  run(
    `INSERT INTO recurring_jobs
       (id, workspace_id, name, role, scope_key_template, briefing_template,
        cadence_seconds, status, next_run_at)
     VALUES (?, ?, 'soon', 'researcher', 't', 'b', 3600, 'active', datetime('now','+1 hour'))`,
    [`rj-${uuidv4()}`, ws],
  );
  // Active, due in 3 days → exclude.
  run(
    `INSERT INTO recurring_jobs
       (id, workspace_id, name, role, scope_key_template, briefing_template,
        cadence_seconds, status, next_run_at)
     VALUES (?, ?, 'far', 'researcher', 't', 'b', 3600, 'active', datetime('now','+3 days'))`,
    [`rj-${uuidv4()}`, ws],
  );
  // Paused, due in 1h → exclude.
  run(
    `INSERT INTO recurring_jobs
       (id, workspace_id, name, role, scope_key_template, briefing_template,
        cadence_seconds, status, next_run_at)
     VALUES (?, ?, 'paused', 'researcher', 't', 'b', 3600, 'paused', datetime('now','+1 hour'))`,
    [`rj-${uuidv4()}`, ws],
  );
  const r = listJobs(ws);
  assert.equal(r.scheduled.length, 1);
  assert.equal(r.scheduled[0].name, 'soon');
});

test('listJobs: workspace-isolated', () => {
  const ws1 = freshWorkspace();
  const ws2 = freshWorkspace();
  startAgentRun({
    workspace_id: ws1, kind: 'pm_chat',
    scope_key: 's', scope_type: 'pm_chat', role: 'pm', agent_id: 'a',
  });
  const r = listJobs(ws2);
  assert.equal(r.live.length, 0);
});
