/**
 * Service-layer smoke tests.
 *
 * Focused on the two things the service layer newly owns vs the old
 * inline-in-route code: authorization is called, and the happy path
 * returns the right shape. Route-level HTTP behavior (status codes, body
 * validation) is already covered by the route handlers themselves.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '@/lib/db';
import { AuthzError } from '@/lib/authz/agent-task';
import { registerDeliverable } from './task-deliverables';
import { logActivity } from './task-activities';
import { failTask } from './task-failure';
import { saveTaskCheckpoint } from './task-checkpoint';
import { sendAgentMail } from './agent-mailbox';
import { transitionTaskStatus } from './task-status';

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

// ─── task-deliverables ──────────────────────────────────────────────

test('registerDeliverable throws AuthzError when agent is not on task', () => {
  const outsider = seedAgent();
  const task = seedTask();
  assert.throws(
    () =>
      registerDeliverable({
        taskId: task,
        actingAgentId: outsider,
        deliverableType: 'artifact',
        title: 't',
      }),
    (err: unknown) => err instanceof AuthzError,
  );
});

test('registerDeliverable happy path returns a TaskDeliverable row', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  const result = registerDeliverable({
    taskId: task,
    actingAgentId: agent,
    deliverableType: 'artifact',
    title: 'widgets',
  });
  assert.equal(result.deliverable.task_id, task);
  assert.equal(result.deliverable.deliverable_type, 'artifact');
  assert.equal(result.deliverable.title, 'widgets');
});

test('registerDeliverable skips authz when actingAgentId is null (operator flow)', () => {
  const task = seedTask();
  const result = registerDeliverable({
    taskId: task,
    actingAgentId: null,
    deliverableType: 'url',
    title: 'op-provided',
    path: 'https://example.com',
  });
  assert.equal(result.deliverable.task_id, task);
});

// ─── task-activities ────────────────────────────────────────────────

test('logActivity throws AuthzError when agent is not on task', () => {
  const outsider = seedAgent();
  const task = seedTask();
  assert.throws(
    () =>
      logActivity({
        taskId: task,
        actingAgentId: outsider,
        activityType: 'updated',
        message: 'hi',
      }),
    (err: unknown) => err instanceof AuthzError,
  );
});

test('logActivity happy path returns a TaskActivity with message', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  const result = logActivity({
    taskId: task,
    actingAgentId: agent,
    activityType: 'completed',
    message: 'done',
  });
  assert.equal(result.task_id, task);
  assert.equal(result.message, 'done');
  assert.equal(result.agent_id, agent);
});

// ─── task-checkpoint ────────────────────────────────────────────────

test('saveTaskCheckpoint throws AuthzError when agent is not on task', () => {
  const outsider = seedAgent();
  const task = seedTask();
  assert.throws(
    () =>
      saveTaskCheckpoint({
        taskId: task,
        agentId: outsider,
        stateSummary: 's',
      }),
    (err: unknown) => err instanceof AuthzError,
  );
});

test('saveTaskCheckpoint happy path writes a checkpoint row', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  const cp = saveTaskCheckpoint({
    taskId: task,
    agentId: agent,
    stateSummary: 'halfway',
  });
  assert.equal(cp.task_id, task);
  assert.equal(cp.state_summary, 'halfway');
});

// ─── task-failure ───────────────────────────────────────────────────

test('failTask rejects when task is not in a failable stage', async () => {
  const agent = seedAgent({ role: 'tester' });
  const task = seedTask({ assigned: agent, status: 'in_progress' });
  const result = await failTask({ taskId: task, actingAgentId: agent, reason: 'x' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'bad_state');
  }
});

test('failTask returns not_found for missing task', async () => {
  const result = await failTask({
    taskId: crypto.randomUUID(),
    actingAgentId: null,
    reason: 'x',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'not_found');
});

// ─── task-status ────────────────────────────────────────────────────

test('transitionTaskStatus throws AuthzError when agent is not on task', () => {
  const outsider = seedAgent();
  const task = seedTask({ status: 'in_progress' });
  assert.throws(
    () =>
      transitionTaskStatus({
        taskId: task,
        actingAgentId: outsider,
        newStatus: 'review',
      }),
    (err: unknown) => err instanceof AuthzError,
  );
});

test('transitionTaskStatus rejects with evidence_gate when entering review without deliverable/activity', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent, status: 'in_progress' });
  const result = transitionTaskStatus({
    taskId: task,
    actingAgentId: agent,
    newStatus: 'review',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'evidence_gate');
});

test('transitionTaskStatus no-op when newStatus === existing.status', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent, status: 'in_progress' });
  const result = transitionTaskStatus({
    taskId: task,
    actingAgentId: agent,
    newStatus: 'in_progress',
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.previousStatus, 'in_progress');
});

test('transitionTaskStatus returns not_found for missing task', () => {
  const result = transitionTaskStatus({
    taskId: crypto.randomUUID(),
    actingAgentId: null,
    newStatus: 'assigned',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'not_found');
});

// ─── agent-mailbox ──────────────────────────────────────────────────

test('sendAgentMail throws AuthzError on cross-task mail', async () => {
  const outsider = seedAgent();
  const recipient = seedAgent();
  const task = seedTask(); // outsider is not on this task
  await assert.rejects(
    async () =>
      sendAgentMail({
        fromAgentId: outsider,
        toAgentId: recipient,
        body: 'hello',
        taskId: task,
      }),
    (err: unknown) => err instanceof AuthzError,
  );
});

test('sendAgentMail throws AuthzError when sender is missing', async () => {
  const recipient = seedAgent();
  await assert.rejects(
    async () =>
      sendAgentMail({
        fromAgentId: crypto.randomUUID(),
        toAgentId: recipient,
        body: 'hi',
      }),
    (err: unknown) => err instanceof AuthzError,
  );
});

test('sendAgentMail returns recipient_not_found when recipient does not exist', async () => {
  const sender = seedAgent();
  const result = await sendAgentMail({
    fromAgentId: sender,
    toAgentId: crypto.randomUUID(),
    body: 'hi',
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'recipient_not_found');
});

test('sendAgentMail happy path writes and returns a message', async () => {
  const sender = seedAgent();
  const recipient = seedAgent();
  const result = await sendAgentMail({
    fromAgentId: sender,
    toAgentId: recipient,
    body: 'hello',
    subject: 'hi',
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.message.from_agent_id, sender);
    assert.equal(result.message.to_agent_id, recipient);
    assert.equal(result.message.body, 'hello');
  }
});
