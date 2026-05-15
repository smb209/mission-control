/**
 * Tests for `checkAgentHealth` proof-of-life sources.
 *
 * Regression: previously the watcher only inspected `task_activities` to
 * decide if an agent was alive — but `register_deliverable` and
 * `take_note` (the most common MCP call sites for "I am working") write
 * to `task_deliverables` / `task_notes` instead. An agent actively
 * registering deliverables would be flagged `stalled` → `stuck` and the
 * stall watcher would re-dispatch, stomping on its in-flight progress.
 *
 * These tests pin the behavior: any of the three signals (activity,
 * deliverable, note) within the threshold window keeps the agent
 * `working`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '@/lib/db';
import { checkAgentHealth } from './agent-health';

function uuid(): string {
  return (globalThis.crypto ?? require('node:crypto')).randomUUID();
}

function seedWorkingAgent(): string {
  const id = uuid();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_active, status, created_at, updated_at)
       VALUES (?, 'A', 'builder', 'default', 1, 'working', datetime('now'), datetime('now'))`,
    [id],
  );
  return id;
}

function seedActiveTask(agentId: string, ageMinutes: number): string {
  const id = uuid();
  const past = new Date(Date.now() - ageMinutes * 60_000).toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at)
       VALUES (?, 't', 'in_progress', 'normal', 'default', 'default', ?, ?, ?)`,
    [id, agentId, past, past],
  );
  // Active openclaw_session row so the early-return doesn't tag 'zombie'
  run(
    `INSERT INTO openclaw_sessions (id, agent_id, openclaw_session_id, task_id, status, channel, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 'mission-control', ?, ?)`,
    [uuid(), agentId, `mc-${id}`, id, past, past],
  );
  return id;
}

function insertActivity(taskId: string, agentId: string, agoMinutes: number, message = 'real activity'): void {
  const past = new Date(Date.now() - agoMinutes * 60_000).toISOString();
  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
       VALUES (?, ?, ?, 'progress', ?, ?)`,
    [uuid(), taskId, agentId, message, past],
  );
}

function insertDeliverable(taskId: string, agoMinutes: number): void {
  const past = new Date(Date.now() - agoMinutes * 60_000).toISOString();
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, storage_scheme, created_at)
       VALUES (?, ?, 'file', 'd', 'inline', ?)`,
    [uuid(), taskId, past],
  );
}

function insertNote(taskId: string, agoMinutes: number): void {
  const past = new Date(Date.now() - agoMinutes * 60_000).toISOString();
  // agent_notes is what the take_note MCP tool writes to. Required cols:
  // workspace_id, scope_key, role, run_group_id, kind (CHECK list), body.
  run(
    `INSERT INTO agent_notes (
        id, workspace_id, agent_id, task_id, scope_key, role, run_group_id, kind, body, created_at
      ) VALUES (?, 'default', NULL, ?, 'test-scope', 'builder', 'test-run', 'discovery', 'note body', ?)`,
    [uuid(), taskId, past],
  );
}

test('checkAgentHealth: recent task_activities row keeps agent working', () => {
  const agentId = seedWorkingAgent();
  const taskId = seedActiveTask(agentId, 30);
  insertActivity(taskId, agentId, 1);
  assert.equal(checkAgentHealth(agentId), 'working');
});

test('checkAgentHealth: recent task_deliverables row keeps agent working (regression)', () => {
  const agentId = seedWorkingAgent();
  const taskId = seedActiveTask(agentId, 30);
  // No task_activities row at all — only a deliverable. Pre-fix this
  // returned 'stuck' (taskAge > STUCK_THRESHOLD) because the watcher
  // only looked at task_activities.
  insertDeliverable(taskId, 1);
  assert.equal(checkAgentHealth(agentId), 'working');
});

test('checkAgentHealth: recent task_notes row keeps agent working', () => {
  const agentId = seedWorkingAgent();
  const taskId = seedActiveTask(agentId, 30);
  insertNote(taskId, 1);
  assert.equal(checkAgentHealth(agentId), 'working');
});

test('checkAgentHealth: stale activity, fresh deliverable → working (max wins)', () => {
  const agentId = seedWorkingAgent();
  const taskId = seedActiveTask(agentId, 30);
  insertActivity(taskId, agentId, 60); // way past stuck threshold
  insertDeliverable(taskId, 1);
  assert.equal(checkAgentHealth(agentId), 'working');
});

test('checkAgentHealth: all signals stale → stuck', () => {
  const agentId = seedWorkingAgent();
  const taskId = seedActiveTask(agentId, 60);
  insertActivity(taskId, agentId, 60);
  insertDeliverable(taskId, 60);
  insertNote(taskId, 60);
  assert.equal(checkAgentHealth(agentId), 'stuck');
});

test('checkAgentHealth: all signals between stall and stuck thresholds → stalled', () => {
  const agentId = seedWorkingAgent();
  const taskId = seedActiveTask(agentId, 10);
  insertDeliverable(taskId, 10); // > 5min stall, < 15min stuck
  assert.equal(checkAgentHealth(agentId), 'stalled');
});

test('checkAgentHealth: heartbeat-style activities (Agent health: …) ignored as proof-of-life', () => {
  const agentId = seedWorkingAgent();
  const taskId = seedActiveTask(agentId, 30);
  // Heartbeat row, not real activity.
  insertActivity(taskId, agentId, 1, 'Agent health: stalled');
  // No other signals → should fall through to taskAge-based check → stuck.
  assert.equal(checkAgentHealth(agentId), 'stuck');
});
