import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '@/lib/db';
import {
  AuthzError,
  assertAgentActive,
  assertAgentCanActOnTask,
} from './agent-task';

// Seed helpers — match the style of task-governance.test.ts:11.

function seedAgent(opts: {
  id?: string;
  workspace?: string;
  isActive?: number;
  role?: string;
} = {}): string {
  const id = opts.id ?? crypto.randomUUID();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_active, created_at, updated_at)
     VALUES (?, 'A', ?, ?, ?, datetime('now'), datetime('now'))`,
    [id, opts.role ?? 'builder', opts.workspace ?? 'default', opts.isActive ?? 1],
  );
  return id;
}

function seedTask(opts: {
  id?: string;
  workspace?: string;
  assigned?: string | null;
  creator?: string | null;
} = {}): string {
  const id = opts.id ?? crypto.randomUUID();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_by_agent_id, created_at, updated_at)
     VALUES (?, 'T', 'assigned', 'normal', ?, 'default', ?, ?, datetime('now'), datetime('now'))`,
    [id, opts.workspace ?? 'default', opts.assigned ?? null, opts.creator ?? null],
  );
  return id;
}

function seedRole(taskId: string, agentId: string, role: string): void {
  run(
    `INSERT INTO task_roles (id, task_id, role, agent_id, created_at)
     VALUES (lower(hex(randomblob(16))), ?, ?, ?, datetime('now'))`,
    [taskId, role, agentId],
  );
}

// ─── assertAgentActive ──────────────────────────────────────────────

test('assertAgentActive throws on missing agent', () => {
  assert.throws(() => assertAgentActive('nonexistent'), (err: unknown) => {
    return err instanceof AuthzError && (err as AuthzError).code === 'agent_not_found';
  });
});

test('assertAgentActive throws on disabled agent', () => {
  const id = seedAgent({ isActive: 0 });
  assert.throws(() => assertAgentActive(id), (err: unknown) => {
    return err instanceof AuthzError && (err as AuthzError).code === 'agent_disabled';
  });
});

test('assertAgentActive passes for active agent', () => {
  const id = seedAgent();
  assert.doesNotThrow(() => assertAgentActive(id));
});

// ─── assertAgentCanActOnTask — agent/task existence ─────────────────

test('throws agent_not_found when agent missing', () => {
  const task = seedTask();
  assert.throws(
    () => assertAgentCanActOnTask('nonexistent', task, 'activity'),
    (err: unknown) => err instanceof AuthzError && (err as AuthzError).code === 'agent_not_found',
  );
});

test('throws agent_disabled when agent is_active=0', () => {
  const agent = seedAgent({ isActive: 0 });
  const task = seedTask({ assigned: agent });
  assert.throws(
    () => assertAgentCanActOnTask(agent, task, 'activity'),
    (err: unknown) => err instanceof AuthzError && (err as AuthzError).code === 'agent_disabled',
  );
});

test('throws task_not_found when task missing', () => {
  const agent = seedAgent();
  assert.throws(
    () => assertAgentCanActOnTask(agent, 'nonexistent', 'activity'),
    (err: unknown) => err instanceof AuthzError && (err as AuthzError).code === 'task_not_found',
  );
});

// ─── workspace isolation ────────────────────────────────────────────

test('throws workspace_mismatch when agent and task are in different workspaces', () => {
  // Seed a non-default workspace (FK target)
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES ('other-ws', 'Other', 'other-ws')`,
    [],
  );
  const agent = seedAgent({ workspace: 'other-ws' });
  const task = seedTask({ workspace: 'default', assigned: agent });
  assert.throws(
    () => assertAgentCanActOnTask(agent, task, 'activity'),
    (err: unknown) => err instanceof AuthzError && (err as AuthzError).code === 'workspace_mismatch',
  );
});

// ─── authorization paths ────────────────────────────────────────────

test('assigned_agent_id passes for any non-delegate action', () => {
  const agent = seedAgent();
  const task = seedTask({ assigned: agent });
  for (const action of ['read', 'activity', 'deliverable', 'status', 'fail', 'checkpoint'] as const) {
    assert.doesNotThrow(
      () => assertAgentCanActOnTask(agent, task, action),
      `assigned agent should pass for ${action}`,
    );
  }
});

test('task_roles entry (any role) passes for state-changing actions', () => {
  const agent = seedAgent();
  const task = seedTask(); // not assigned to this agent
  seedRole(task, agent, 'tester');

  assert.doesNotThrow(() => assertAgentCanActOnTask(agent, task, 'activity'));
  assert.doesNotThrow(() => assertAgentCanActOnTask(agent, task, 'status'));
  assert.doesNotThrow(() => assertAgentCanActOnTask(agent, task, 'fail'));
});

test('unrelated agent throws agent_not_on_task for non-delegate action', () => {
  const agent = seedAgent();
  const task = seedTask(); // unrelated
  assert.throws(
    () => assertAgentCanActOnTask(agent, task, 'activity'),
    (err: unknown) =>
      err instanceof AuthzError && (err as AuthzError).code === 'agent_not_on_task',
  );
});

// ─── delegate — coordinator-only ────────────────────────────────────

test('delegate throws agent_not_coordinator for a plain task-roles entry', () => {
  // Has a task role, but role != coordinator → still not allowed to delegate.
  const agent = seedAgent();
  const task = seedTask();
  seedRole(task, agent, 'builder');
  assert.throws(
    () => assertAgentCanActOnTask(agent, task, 'delegate'),
    (err: unknown) =>
      err instanceof AuthzError && (err as AuthzError).code === 'agent_not_coordinator',
  );
});

test('delegate passes when agent has task_roles[role=coordinator]', () => {
  const agent = seedAgent({ role: 'builder' });
  const task = seedTask();
  seedRole(task, agent, 'coordinator');
  assert.doesNotThrow(() => assertAgentCanActOnTask(agent, task, 'delegate'));
});

test('delegate passes when agent is assigned AND has role=coordinator', () => {
  const agent = seedAgent({ role: 'coordinator' });
  const task = seedTask({ assigned: agent });
  assert.doesNotThrow(() => assertAgentCanActOnTask(agent, task, 'delegate'));
});

test('delegate passes when agent is the task creator (created_by_agent_id)', () => {
  const agent = seedAgent({ role: 'builder' });
  const task = seedTask({ creator: agent });
  assert.doesNotThrow(() => assertAgentCanActOnTask(agent, task, 'delegate'));
});

test('delegate throws when agent is assigned but not a coordinator-role', () => {
  // Assigned agent has role=builder — they can act on the task but cannot
  // delegate. This prevents a builder from fanning out fake delegations.
  const agent = seedAgent({ role: 'builder' });
  const task = seedTask({ assigned: agent });
  assert.throws(
    () => assertAgentCanActOnTask(agent, task, 'delegate'),
    (err: unknown) =>
      err instanceof AuthzError && (err as AuthzError).code === 'agent_not_coordinator',
  );
});

// ─── role matching is case-insensitive ──────────────────────────────

test('task_roles role match is case-insensitive for coordinator', () => {
  const agent = seedAgent();
  const task = seedTask();
  seedRole(task, agent, 'COORDINATOR');
  assert.doesNotThrow(() => assertAgentCanActOnTask(agent, task, 'delegate'));
});
