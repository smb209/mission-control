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
import { saveKnowledge } from './knowledge';

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

test('registerDeliverable dedupes by (task, type, path) — second call updates in place', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  const first = registerDeliverable({
    taskId: task,
    actingAgentId: agent,
    deliverableType: 'file',
    title: 'v1 title',
    path: 'docs/guide.md',
    description: 'first',
  });
  const second = registerDeliverable({
    taskId: task,
    actingAgentId: agent,
    deliverableType: 'file',
    title: 'v2 title',
    path: 'docs/guide.md',
    description: 'second',
  });
  // Same id — not a new row — and metadata reflects the latest call.
  assert.equal(second.deliverable.id, first.deliverable.id);
  assert.equal(second.deliverable.title, 'v2 title');
  assert.equal(second.deliverable.description, 'second');
  // Confirm the DB really has just one row for that (task, type, path).
  const { queryOne: qOne } = require('@/lib/db') as typeof import('@/lib/db');
  const row = qOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM task_deliverables WHERE task_id = ? AND deliverable_type = 'file' AND path = ?`,
    [task, 'docs/guide.md'],
  );
  assert.equal(row?.cnt, 1);
});

test('registerDeliverable dedupes path-less artifacts by title', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  const first = registerDeliverable({
    taskId: task,
    actingAgentId: agent,
    deliverableType: 'artifact',
    title: 'summary',
    description: 'v1',
  });
  const second = registerDeliverable({
    taskId: task,
    actingAgentId: agent,
    deliverableType: 'artifact',
    title: 'summary',
    description: 'v2',
  });
  assert.equal(second.deliverable.id, first.deliverable.id);
  assert.equal(second.deliverable.description, 'v2');
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

// ─── transitionTaskStatus: review-stage gates (Slice 1 of review-robust) ───

function setEnv(key: string, value: string | undefined): () => void {
  const prior = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return () => {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  };
}

function seedDeliverable(taskId: string): void {
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, role, created_at)
     VALUES (?, ?, 'file', 'x', 'output', datetime('now'))`,
    [crypto.randomUUID(), taskId],
  );
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (?, ?, 'completed', 'done', datetime('now'))`,
    [crypto.randomUUID(), taskId],
  );
}

test('transitionTaskStatus → review: reviewer_required when no reviewer agent exists (strict mode)', () => {
  const restore = setEnv('MC_REVIEW_STRICT_GATING', '1');
  try {
    const builder = seedAgent({ role: 'builder' });
    const task = seedTask({ assigned: builder, status: 'in_progress' });
    seedDeliverable(task);
    const result = transitionTaskStatus({
      taskId: task,
      actingAgentId: builder,
      newStatus: 'review',
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'reviewer_required');
  } finally { restore(); }
});

test('transitionTaskStatus → review: auto-picks reviewer agent + writes task_roles row (strict mode)', () => {
  const restore = setEnv('MC_REVIEW_STRICT_GATING', '1');
  try {
    const builder = seedAgent({ role: 'builder' });
    seedAgent({ role: 'reviewer' });
    const task = seedTask({ assigned: builder, status: 'in_progress' });
    seedDeliverable(task);
    const result = transitionTaskStatus({
      taskId: task,
      actingAgentId: builder,
      newStatus: 'review',
    });
    assert.equal(result.ok, true);
    const { queryOne: qOne } = require('@/lib/db') as typeof import('@/lib/db');
    const reviewerRow = qOne<{ agent_id: string }>(
      `SELECT agent_id FROM task_roles WHERE task_id = ? AND role = 'reviewer'`,
      [task],
    );
    assert.ok(reviewerRow);
    assert.notEqual(reviewerRow!.agent_id, builder);
  } finally { restore(); }
});

test('transitionTaskStatus → review: self_review_blocked when only reviewer is the completer (strict mode)', () => {
  const restore = setEnv('MC_REVIEW_STRICT_GATING', '1');
  try {
    // Builder agent IS itself flagged as reviewer; no other agent available.
    const solo = seedAgent({ role: 'reviewer' });
    const task = seedTask({ assigned: solo, status: 'in_progress' });
    // Pre-seed an explicit reviewer row pointing at the same agent — this is
    // how the self-review case manifests when an explicit assignment exists.
    run(
      `INSERT INTO task_roles (id, task_id, role, agent_id, created_at)
       VALUES (?, ?, 'reviewer', ?, datetime('now'))`,
      [crypto.randomUUID(), task, solo],
    );
    seedDeliverable(task);
    const result = transitionTaskStatus({
      taskId: task,
      actingAgentId: solo,
      newStatus: 'review',
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'self_review_blocked');
  } finally { restore(); }
});

test('transitionTaskStatus → review: respects pre-assigned reviewer (strict mode)', () => {
  const restore = setEnv('MC_REVIEW_STRICT_GATING', '1');
  try {
    const builder = seedAgent({ role: 'builder' });
    const reviewer = seedAgent({ role: 'reviewer' });
    const task = seedTask({ assigned: builder, status: 'in_progress' });
    run(
      `INSERT INTO task_roles (id, task_id, role, agent_id, created_at)
       VALUES (?, ?, 'reviewer', ?, datetime('now'))`,
      [crypto.randomUUID(), task, reviewer],
    );
    seedDeliverable(task);
    const result = transitionTaskStatus({
      taskId: task,
      actingAgentId: builder,
      newStatus: 'review',
    });
    assert.equal(result.ok, true);
  } finally { restore(); }
});

test('transitionTaskStatus → review: skipped when MC_REVIEW_STRICT_GATING != "1" (back-compat)', () => {
  const restore = setEnv('MC_REVIEW_STRICT_GATING', undefined);
  try {
    const solo = seedAgent({ role: 'builder' });
    const task = seedTask({ assigned: solo, status: 'in_progress' });
    seedDeliverable(task);
    // No reviewer in workspace, builder is completer — strict mode would
    // reject. With flag off, the legacy behavior (just evidence gate)
    // applies and the transition succeeds.
    const result = transitionTaskStatus({
      taskId: task,
      actingAgentId: solo,
      newStatus: 'review',
    });
    assert.equal(result.ok, true);
  } finally { restore(); }
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

// ─── knowledge ──────────────────────────────────────────────────────

test('saveKnowledge throws AuthzError when agent_id is set with task_id but agent is off-task', () => {
  const outsider = seedAgent();
  const task = seedTask();
  assert.throws(
    () =>
      saveKnowledge({
        actingAgentId: outsider,
        workspaceId: 'default',
        taskId: task,
        category: 'pattern',
        title: 't',
        content: 'c',
      }),
    (err: unknown) => err instanceof AuthzError,
  );
});

test('saveKnowledge happy path (workspace-only, no task_id)', () => {
  const agent = seedAgent({ role: 'learner' });
  const entry = saveKnowledge({
    actingAgentId: agent,
    workspaceId: 'default',
    category: 'pattern',
    title: 'Learned thing',
    content: 'Some detail',
    tags: ['testing'],
    confidence: 0.75,
  });
  assert.equal(entry.workspace_id, 'default');
  assert.equal(entry.category, 'pattern');
  assert.equal(entry.title, 'Learned thing');
  assert.equal(entry.confidence, 0.75);
  assert.deepEqual(entry.tags, ['testing']);
  assert.equal(entry.created_by_agent_id, agent);
  assert.equal(entry.task_id, undefined);
});

test('saveKnowledge happy path when agent is on the task', () => {
  const agent = seedAgent({ role: 'learner' });
  const task = seedTask({ assigned: agent });
  const entry = saveKnowledge({
    actingAgentId: agent,
    workspaceId: 'default',
    taskId: task,
    category: 'failure',
    title: 'Boom',
    content: 'It exploded',
  });
  assert.equal(entry.task_id, task);
  assert.equal(entry.confidence, 0.5);
  assert.deepEqual(entry.tags, []);
});

test('saveKnowledge skips authz when actingAgentId is null (operator flow)', () => {
  const entry = saveKnowledge({
    actingAgentId: null,
    workspaceId: 'default',
    category: 'checklist',
    title: 'op note',
    content: 'x',
  });
  assert.equal(entry.title, 'op note');
  assert.equal(entry.created_by_agent_id, undefined);
});

test('saveKnowledge throws AuthzError for missing acting agent', () => {
  assert.throws(
    () =>
      saveKnowledge({
        actingAgentId: crypto.randomUUID(),
        workspaceId: 'default',
        category: 'pattern',
        title: 't',
        content: 'c',
      }),
    (err: unknown) => err instanceof AuthzError,
  );
});

// ─── knowledge ──────────────────────────────────────────────────────

test('saveKnowledge throws AuthzError when agent_id is set with task_id but agent is off-task', () => {
  const outsider = seedAgent();
  const task = seedTask();
  assert.throws(
    () =>
      saveKnowledge({
        actingAgentId: outsider,
        workspaceId: 'default',
        taskId: task,
        category: 'pattern',
        title: 't',
        content: 'c',
      }),
    (err: unknown) => err instanceof AuthzError,
  );
});

test('saveKnowledge happy path (workspace-only, no task_id)', () => {
  const agent = seedAgent({ role: 'learner' });
  const entry = saveKnowledge({
    actingAgentId: agent,
    workspaceId: 'default',
    category: 'pattern',
    title: 'Learned thing',
    content: 'Some detail',
    tags: ['testing'],
    confidence: 0.75,
  });
  assert.equal(entry.workspace_id, 'default');
  assert.equal(entry.category, 'pattern');
  assert.equal(entry.title, 'Learned thing');
  assert.equal(entry.confidence, 0.75);
  assert.deepEqual(entry.tags, ['testing']);
  assert.equal(entry.created_by_agent_id, agent);
  assert.equal(entry.task_id, undefined);
});

test('saveKnowledge happy path when agent is on the task', () => {
  const agent = seedAgent({ role: 'learner' });
  const task = seedTask({ assigned: agent });
  const entry = saveKnowledge({
    actingAgentId: agent,
    workspaceId: 'default',
    taskId: task,
    category: 'failure',
    title: 'Boom',
    content: 'It exploded',
  });
  assert.equal(entry.task_id, task);
  assert.equal(entry.confidence, 0.5); // default
  assert.deepEqual(entry.tags, []); // null → []
});

test('saveKnowledge skips authz when actingAgentId is null (operator flow)', () => {
  const entry = saveKnowledge({
    actingAgentId: null,
    workspaceId: 'default',
    category: 'checklist',
    title: 'op note',
    content: 'x',
  });
  assert.equal(entry.title, 'op note');
  assert.equal(entry.created_by_agent_id, undefined);
});

test('saveKnowledge throws AuthzError for missing acting agent', () => {
  assert.throws(
    () =>
      saveKnowledge({
        actingAgentId: crypto.randomUUID(),
        workspaceId: 'default',
        category: 'pattern',
        title: 't',
        content: 'c',
      }),
    (err: unknown) => err instanceof AuthzError,
  );
});
