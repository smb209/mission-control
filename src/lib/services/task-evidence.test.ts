/**
 * task-evidence service tests.
 *
 * Covers the parser fingerprints (so an agent can't submit garbage and
 * call it a typecheck) and the gate-required-by-stage logic in
 * checkStageEvidence.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { run, queryOne } from '@/lib/db';
import { submitEvidence, getLatestEvidence, hasAnyEvidence } from './task-evidence';
import { checkStageEvidence } from '@/lib/task-governance';

function seedAgent(opts: { id?: string; workspace?: string; role?: string } = {}): string {
  const id = opts.id ?? crypto.randomUUID();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_active, created_at, updated_at)
     VALUES (?, 'A', ?, ?, 1, datetime('now'), datetime('now'))`,
    [id, opts.role ?? 'builder', opts.workspace ?? 'default'],
  );
  return id;
}

function seedTask(opts: { id?: string; assigned?: string; status?: string } = {}): string {
  const id = opts.id ?? crypto.randomUUID();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at)
     VALUES (?, 'T', ?, 'normal', 'default', 'default', ?, datetime('now'), datetime('now'))`,
    [id, opts.status ?? 'in_progress', opts.assigned ?? null],
  );
  return id;
}

// ─── Parser fingerprints ────────────────────────────────────────────

test('build_fast rejects unrecognized output (e.g. echo ok)', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  const result = submitEvidence({
    taskId: task,
    actingAgentId: agent,
    gate: 'build_fast',
    command: 'echo ok',
    stdout: 'ok\n',
    stderr: '',
    exitCode: 0,
  });
  assert.equal(result.passed, false);
  assert.match(result.rejectReason ?? '', /no recognizable.*output/i);
});

test('build_fast accepts clean tsc output (empty stdout, exit 0)', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  const result = submitEvidence({
    taskId: task,
    actingAgentId: agent,
    gate: 'build_fast',
    command: 'yarn tsc --noEmit',
    stdout: '',
    stderr: '',
    exitCode: 0,
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.parsedSummary.fingerprints, ['tsc']);
  assert.equal(result.parsedSummary.ts_errors, 0);
});

test('build_fast fails on tsc errors regardless of exit code claim', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  const result = submitEvidence({
    taskId: task,
    actingAgentId: agent,
    gate: 'build_fast',
    command: 'yarn tsc --noEmit',
    stdout: "src/foo.ts(1,1): error TS2304: Cannot find name 'bar'.\n",
    stderr: '',
    exitCode: 0, // agent claims success
  });
  assert.equal(result.passed, false);
  assert.equal(result.parsedSummary.ts_errors, 1);
});

test('test_full requires recognizable runner summary', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  const result = submitEvidence({
    taskId: task,
    actingAgentId: agent,
    gate: 'test_full',
    command: 'yarn test',
    stdout: 'tests are fine trust me',
    stderr: '',
    exitCode: 0,
  });
  assert.equal(result.passed, false);
  assert.match(result.rejectReason ?? '', /test-runner summary/i);
});

test('test_full accepts jest summary', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  const result = submitEvidence({
    taskId: task,
    actingAgentId: agent,
    gate: 'test_full',
    command: 'yarn test',
    stdout:
      'Test Suites: 5 passed, 5 total\nTests: 0 failed, 42 passed, 0 skipped, 42 total\n',
    stderr: '',
    exitCode: 0,
  });
  assert.equal(result.passed, true);
  assert.equal(result.parsedSummary.tests_passed, 42);
  assert.equal(result.parsedSummary.tests_failed, 0);
});

test('runtime_ui requires at least one artifact path', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  const result = submitEvidence({
    taskId: task,
    actingAgentId: agent,
    gate: 'runtime_ui',
    command: 'playwright test',
    stdout: '1 passed (3s)\n',
    stderr: '',
    exitCode: 0,
    // no artifact_paths
  });
  assert.equal(result.passed, false);
  assert.match(result.rejectReason ?? '', /artifact_path/);
});

test('runtime_ui passes with artifact + exit 0', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  const result = submitEvidence({
    taskId: task,
    actingAgentId: agent,
    gate: 'runtime_ui',
    command: 'playwright test',
    stdout: '1 passed (3s)\n',
    stderr: '',
    exitCode: 0,
    artifactPaths: ['/tmp/screenshot.png'],
  });
  assert.equal(result.passed, true);
});

// ─── Persistence ─────────────────────────────────────────────────────

test('rejected evidence is still persisted (audit trail)', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  submitEvidence({
    taskId: task,
    actingAgentId: agent,
    gate: 'build_fast',
    command: 'echo nope',
    stdout: 'nope\n',
    stderr: '',
    exitCode: 0,
  });
  const row = queryOne<{ passed: number; reject_reason: string }>(
    `SELECT passed, reject_reason FROM task_evidence WHERE task_id = ?`,
    [task],
  );
  assert.ok(row);
  assert.equal(row.passed, 0);
  assert.match(row.reject_reason, /no recognizable/i);
});

test('stdout_hash is recorded for tamper-evidence', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  submitEvidence({
    taskId: task,
    actingAgentId: agent,
    gate: 'build_fast',
    command: 'yarn tsc --noEmit',
    stdout: '',
    stderr: '',
    exitCode: 0,
  });
  const row = queryOne<{ stdout_hash: string }>(
    `SELECT stdout_hash FROM task_evidence WHERE task_id = ?`,
    [task],
  );
  assert.ok(row);
  assert.equal(row.stdout_hash.length, 64); // sha256 hex
});

// ─── Stage gate integration ─────────────────────────────────────────

test('checkStageEvidence falls back to legacy bar when no evidence rows exist', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  // Legacy bar requires deliverable + activity. With neither, gate fails
  // — but this is the existing behavior, not the new strict path.
  const result = checkStageEvidence(task, 'testing');
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /no deliverables/);
});

test('checkStageEvidence enforces build_fast for testing once any evidence exists', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  // Submit a passing runtime_smoke (irrelevant to testing's required gate)
  // — this puts the task on the strict path but does not satisfy build_fast.
  submitEvidence({
    taskId: task,
    actingAgentId: agent,
    gate: 'runtime_smoke',
    command: 'curl -fsS http://localhost:4010/api/health',
    stdout: '{"ok":true}\n',
    stderr: '',
    exitCode: 0,
  });
  assert.equal(hasAnyEvidence(task), true);
  const result = checkStageEvidence(task, 'testing');
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /build_fast required/);
});

test('checkStageEvidence admits transition once required gate passed', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  submitEvidence({
    taskId: task,
    actingAgentId: agent,
    gate: 'build_fast',
    command: 'yarn tsc --noEmit',
    stdout: '',
    stderr: '',
    exitCode: 0,
  });
  const result = checkStageEvidence(task, 'testing');
  assert.equal(result.ok, true);
});

test('checkStageEvidence rejects when latest gate run failed', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  // Pass once
  submitEvidence({
    taskId: task,
    actingAgentId: agent,
    gate: 'build_fast',
    command: 'yarn tsc --noEmit',
    stdout: '',
    stderr: '',
    exitCode: 0,
  });
  // Then a later failing run supersedes
  submitEvidence({
    taskId: task,
    actingAgentId: agent,
    gate: 'build_fast',
    command: 'yarn tsc --noEmit',
    stdout: "src/x.ts(1,1): error TS2304: Cannot find name 'y'.\n",
    stderr: '',
    exitCode: 1,
  });
  const latest = getLatestEvidence(task, 'build_fast');
  assert.ok(latest);
  assert.equal(latest.passed, 0);
  const result = checkStageEvidence(task, 'testing');
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /did not pass/);
});

// ─── Replay test from the AlertDialog post-mortem ────────────────────

test("replay: AlertDialog Builder's self-attestation would NOT pass build_fast", () => {
  // Session 3, line 2293: Builder claimed "TS clean, dev server verified"
  // with no command output. Their submit_evidence call would have looked
  // like this — and the parser correctly rejects it.
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  const result = submitEvidence({
    taskId: task,
    actingAgentId: agent,
    gate: 'build_fast',
    command: 'verified manually',
    stdout: 'TS clean, dev server verified',
    stderr: '',
    exitCode: 0,
  });
  assert.equal(result.passed, false);
  assert.match(result.rejectReason ?? '', /no recognizable/i);
});
