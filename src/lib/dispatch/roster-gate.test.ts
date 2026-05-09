/**
 * Tests for the pre-dispatch workspace-roster gate (Slice 0).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run, queryOne } from '@/lib/db';
import {
  enforceRosterGate,
  requiredRolesForTask,
  validateWorkspaceRoster,
  type RosterRole,
} from './roster-gate';

function seedWorkspace(id: string): void {
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`,
    [id, id, id],
  );
}

function freshWorkspace(): string {
  const id = `ws-${crypto.randomUUID().slice(0, 8)}`;
  seedWorkspace(id);
  return id;
}

function seedAgent(opts: {
  id?: string;
  workspace?: string;
  role?: string | null;
  gateway?: string | null;
  status?: string;
  isActive?: number;
  isPm?: number;
  isMaster?: number;
} = {}): string {
  const id = opts.id ?? crypto.randomUUID();
  run(
    `INSERT INTO agents (id, name, role, gateway_agent_id, workspace_id, status, is_active, is_pm, is_master, created_at, updated_at)
     VALUES (?, 'A', ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      id,
      // role is NOT NULL in schema. Empty string lets the gateway-id-derivation path fire.
      opts.role ?? '',
      opts.gateway ?? null,
      opts.workspace ?? 'default',
      opts.status ?? 'standby',
      opts.isActive ?? 1,
      opts.isPm ?? 0,
      opts.isMaster ?? 0,
    ],
  );
  return id;
}

function seedTask(opts: {
  id?: string;
  workspace?: string;
  status?: string;
  assigned?: string | null;
  convoyId?: string | null;
  isSubtask?: number;
  workflowTemplateId?: string | null;
} = {}): string {
  const id = opts.id ?? crypto.randomUUID();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, convoy_id, is_subtask, workflow_template_id, created_at, updated_at)
     VALUES (?, 'T', ?, 'normal', ?, 'default', ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      id,
      opts.status ?? 'inbox',
      opts.workspace ?? 'default',
      opts.assigned ?? null,
      opts.convoyId ?? null,
      opts.isSubtask ?? 0,
      opts.workflowTemplateId ?? null,
    ],
  );
  return id;
}

function seedConvoySubtask(taskId: string, convoyId: string, suggestedRole: string): void {
  run(
    `INSERT INTO convoy_subtasks (id, convoy_id, task_id, sort_order, suggested_role, slice, created_at)
     VALUES (?, ?, ?, 0, ?, 'test slice', datetime('now'))`,
    [crypto.randomUUID(), convoyId, taskId, suggestedRole],
  );
}

function seedConvoy(id: string, workspace = 'default'): { parentTaskId: string } {
  // convoys.parent_task_id is NOT NULL — create a parent task first.
  const parentTaskId = seedTask({ workspace, status: 'convoy_active' });
  run(
    `INSERT INTO convoys (id, parent_task_id, name, status, created_at, updated_at)
     VALUES (?, ?, 'test convoy', 'active', datetime('now'), datetime('now'))`,
    [id, parentTaskId],
  );
  return { parentTaskId };
}

function setEnv(key: string, value: string | undefined): () => void {
  const prior = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return () => {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  };
}

// ─── requiredRolesForTask ─────────────────────────────────────────────

test('requiredRolesForTask: plain task defaults to builder + reviewer', () => {
  const task = seedTask();
  const roles = requiredRolesForTask(task);
  assert.deepEqual([...roles].sort(), ['builder', 'reviewer']);
});

test('requiredRolesForTask: convoy subtask uses suggested_role + reviewer', () => {
  const convoyId = crypto.randomUUID();
  seedConvoy(convoyId);
  const task = seedTask({ convoyId, isSubtask: 1 });
  seedConvoySubtask(task, convoyId, 'tester');
  const roles = requiredRolesForTask(task);
  assert.deepEqual([...roles].sort(), ['reviewer', 'tester']);
});

test('requiredRolesForTask: convoy subtask with unknown suggested_role falls back to builder', () => {
  const convoyId = crypto.randomUUID();
  seedConvoy(convoyId);
  const task = seedTask({ convoyId, isSubtask: 1 });
  seedConvoySubtask(task, convoyId, 'wizard'); // not a known role
  const roles = requiredRolesForTask(task);
  assert.deepEqual([...roles].sort(), ['builder', 'reviewer']);
});

test('requiredRolesForTask: workflow-template task unions stage roles', () => {
  const tplId = crypto.randomUUID();
  run(
    `INSERT INTO workflow_templates (id, workspace_id, name, stages, created_at, updated_at)
     VALUES (?, 'default', 'Std', ?, datetime('now'), datetime('now'))`,
    [
      tplId,
      JSON.stringify([
        { id: 'build', label: 'Build', role: 'builder', status: 'in_progress' },
        { id: 'test', label: 'Test', role: 'tester', status: 'testing' },
        { id: 'review', label: 'Review', role: 'reviewer', status: 'review' },
      ]),
    ],
  );
  const task = seedTask({ workflowTemplateId: tplId });
  const roles = requiredRolesForTask(task);
  assert.deepEqual([...roles].sort(), ['builder', 'reviewer', 'tester']);
});

test('requiredRolesForTask: malformed template falls back to default ladder', () => {
  const tplId = crypto.randomUUID();
  run(
    `INSERT INTO workflow_templates (id, workspace_id, name, stages, created_at, updated_at)
     VALUES (?, 'default', 'Bad', 'not-json', datetime('now'), datetime('now'))`,
    [tplId],
  );
  const task = seedTask({ workflowTemplateId: tplId });
  const roles = requiredRolesForTask(task);
  assert.deepEqual([...roles].sort(), ['builder', 'reviewer']);
});

// ─── validateWorkspaceRoster ──────────────────────────────────────────

test('validateWorkspaceRoster: passes when each role has an online active agent', () => {
  const ws = freshWorkspace();
  seedAgent({ workspace: ws, role: 'builder', status: 'standby' });
  seedAgent({ workspace: ws, role: 'reviewer', status: 'standby' });
  const result = validateWorkspaceRoster(ws, ['builder', 'reviewer']);
  assert.equal(result.ok, true);
});

test('validateWorkspaceRoster: fails when reviewer absent', () => {
  const ws = freshWorkspace();
  seedAgent({ workspace: ws, role: 'builder', status: 'standby' });
  const result = validateWorkspaceRoster(ws, ['builder', 'reviewer']);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.missing, ['reviewer']);
    assert.equal(result.availableByRole.builder, 1);
  }
});

test('validateWorkspaceRoster: offline agent does not satisfy', () => {
  const ws = freshWorkspace();
  seedAgent({ workspace: ws, role: 'reviewer', status: 'offline' });
  const result = validateWorkspaceRoster(ws, ['reviewer']);
  assert.equal(result.ok, false);
});

test('validateWorkspaceRoster: is_active = 0 does not satisfy', () => {
  const ws = freshWorkspace();
  seedAgent({ workspace: ws, role: 'reviewer', status: 'standby', isActive: 0 });
  const result = validateWorkspaceRoster(ws, ['reviewer']);
  assert.equal(result.ok, false);
});

test('validateWorkspaceRoster: gateway-id derivation provides role when role column null', () => {
  const ws = freshWorkspace();
  seedAgent({ workspace: ws, role: null, gateway: 'mc-reviewer-dev', status: 'standby' });
  const result = validateWorkspaceRoster(ws, ['reviewer']);
  assert.equal(result.ok, true);
});

test('validateWorkspaceRoster: cross-workspace agent does not satisfy', () => {
  const wsA = freshWorkspace();
  const wsB = freshWorkspace();
  seedAgent({ workspace: wsB, role: 'reviewer', status: 'standby' });
  const result = validateWorkspaceRoster(wsA, ['reviewer']);
  assert.equal(result.ok, false);
});

// ─── enforceRosterGate ────────────────────────────────────────────────

test('enforceRosterGate: no-op when MC_ROSTER_GATE != "1"', async () => {
  const restore = setEnv('MC_ROSTER_GATE', undefined);
  try {
    const ws = freshWorkspace();
    const task = seedTask({ workspace: ws }); // no agents exist
    const result = await enforceRosterGate(task);
    assert.equal(result.ok, true);
    // Task was NOT touched.
    const row = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [task]);
    assert.equal(row?.status, 'inbox');
  } finally {
    restore();
  }
});

test('enforceRosterGate: blocks when reviewer missing and flips status + writes activity', async () => {
  const restore = setEnv('MC_ROSTER_GATE', '1');
  try {
    const ws = freshWorkspace();
    seedAgent({ workspace: ws, role: 'builder', status: 'standby' });
    // No reviewer.
    const task = seedTask({ workspace: ws });
    const result = await enforceRosterGate(task);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'roster_incomplete');
      assert.deepEqual(result.missing, ['reviewer']);
    }
    const row = queryOne<{ status: string; status_reason: string | null }>(
      'SELECT status, status_reason FROM tasks WHERE id = ?',
      [task],
    );
    assert.equal(row?.status, 'needs_user_input');
    assert.match(row?.status_reason ?? '', /^roster_incomplete:/);
    const activity = queryOne<{ activity_type: string }>(
      `SELECT activity_type FROM task_activities WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
      [task],
    );
    assert.equal(activity?.activity_type, 'roster_incomplete');
  } finally {
    restore();
  }
});

test('enforceRosterGate: passes when full roster available — task untouched', async () => {
  const restore = setEnv('MC_ROSTER_GATE', '1');
  try {
    const ws = freshWorkspace();
    seedAgent({ workspace: ws, role: 'builder', status: 'standby' });
    seedAgent({ workspace: ws, role: 'reviewer', status: 'standby' });
    const task = seedTask({ workspace: ws });
    const result = await enforceRosterGate(task);
    assert.equal(result.ok, true);
    const row = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [task]);
    assert.equal(row?.status, 'inbox'); // not changed
  } finally {
    restore();
  }
});

test('enforceRosterGate: writes mailbox row to workspace PM when present', async () => {
  const restore = setEnv('MC_ROSTER_GATE', '1');
  try {
    const ws = freshWorkspace();
    const pmId = seedAgent({
      workspace: ws,
      role: 'pm',
      gateway: 'mc-pm-test-dev',
      status: 'standby',
      isPm: 1,
      isMaster: 1,
    });
    // No builder, no reviewer.
    const task = seedTask({ workspace: ws });
    const result = await enforceRosterGate(task);
    assert.equal(result.ok, false);
    const mail = queryOne<{ from_agent_id: string; to_agent_id: string; subject: string | null }>(
      `SELECT from_agent_id, to_agent_id, subject FROM agent_mailbox WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
      [task],
    );
    assert.equal(mail?.to_agent_id, pmId);
    assert.match(mail?.subject ?? '', /Roster incomplete/);
  } finally {
    restore();
  }
});

test('enforceRosterGate: missing roles list reflects multiple deficits', async () => {
  const restore = setEnv('MC_ROSTER_GATE', '1');
  try {
    const ws = freshWorkspace();
    // Empty workspace.
    const task = seedTask({ workspace: ws });
    const result = await enforceRosterGate(task);
    assert.equal(result.ok, false);
    if (!result.ok) {
      const missing = result.missing as RosterRole[];
      assert.ok(missing.includes('builder'));
      assert.ok(missing.includes('reviewer'));
    }
  } finally {
    restore();
  }
});
