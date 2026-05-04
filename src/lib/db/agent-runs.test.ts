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
  AgentRunTransitionError,
  AgentRunValidationError,
} from './agent-runs';

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
