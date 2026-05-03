/**
 * Runner agent helper tests.
 *
 * Coverage: getRunnerAgent fallback chain, computeWorkerScopeSuffix
 * format, nextWorkerAttempt counting, isScopeKeyedDispatchEnabled
 * flag.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import { upsertSession } from '@/lib/db/mc-sessions';
import {
  computeWorkerScopeSuffix,
  getRunnerAgent,
  isScopeKeyedDispatchEnabled,
  nextWorkerAttempt,
} from './runner';

function freshWorkspace(): string {
  const id = `ws-rn-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function ensureRunnerRow(gatewayId: string, workspace: string): string {
  const id = uuidv4();
  run(
    `INSERT OR IGNORE INTO agents (
       id, name, role, workspace_id, gateway_agent_id, source, is_active,
       session_key_prefix, created_at, updated_at
     ) VALUES (?, ?, 'runner', ?, ?, 'gateway', 1, ?, datetime('now'), datetime('now'))`,
    [id, `Runner-${gatewayId}`, workspace, gatewayId, `agent:${gatewayId}:main`],
  );
  return id;
}

test('getRunnerAgent: returns null when no runner registered', () => {
  // Nuke any runner rows from the test template before exercising.
  run(`DELETE FROM agents WHERE gateway_agent_id IN ('mc-runner-dev','mc-runner')`);
  delete process.env.MC_RUNNER_GATEWAY_ID;
  assert.equal(getRunnerAgent(), null);
});

test('getRunnerAgent: prefers mc-runner-dev in dev environment', () => {
  run(`DELETE FROM agents WHERE gateway_agent_id IN ('mc-runner-dev','mc-runner')`);
  ensureRunnerRow('mc-runner-dev', 'default');
  ensureRunnerRow('mc-runner', 'default');
  const prevEnv = process.env.NODE_ENV;
  const prevMcEnv = process.env.MC_ENV;
  // process.env's typed as readonly NODE_ENV by next; cast to mutate for the test.
  const env = process.env as Record<string, string | undefined>;
  env.NODE_ENV = 'development';
  env.MC_ENV = 'dev';
  try {
    const r = getRunnerAgent();
    assert.equal(r?.gateway_agent_id, 'mc-runner-dev');
  } finally {
    if (prevEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = prevEnv;
    if (prevMcEnv === undefined) delete env.MC_ENV;
    else env.MC_ENV = prevMcEnv;
  }
});

test('getRunnerAgent: explicit MC_RUNNER_GATEWAY_ID overrides environment heuristic', () => {
  run(`DELETE FROM agents WHERE gateway_agent_id IN ('mc-runner-dev','mc-runner','mc-custom-runner')`);
  ensureRunnerRow('mc-custom-runner', 'default');
  process.env.MC_RUNNER_GATEWAY_ID = 'mc-custom-runner';
  try {
    const r = getRunnerAgent();
    assert.equal(r?.gateway_agent_id, 'mc-custom-runner');
  } finally {
    delete process.env.MC_RUNNER_GATEWAY_ID;
  }
});

test('computeWorkerScopeSuffix: format and segment validity', () => {
  const wsid = uuidv4();
  const tid = uuidv4();
  const suffix = computeWorkerScopeSuffix({
    workspace_id: wsid,
    task_id: tid,
    role: 'builder',
    attempt: 1,
  });
  assert.equal(suffix, `ws-${wsid}:task-${tid}:builder:1`);
  for (const seg of suffix.split(':')) {
    // Each segment matches openclaw's [a-z0-9][a-z0-9_-]{0,63}
    assert.ok(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(seg), `bad segment: ${seg}`);
  }
});

test('nextWorkerAttempt: increments per (task,role) based on mc_sessions count', () => {
  const ws = freshWorkspace();
  const taskId = uuidv4();
  run(
    `INSERT OR IGNORE INTO tasks (id, workspace_id, title, status, created_at, updated_at)
     VALUES (?, ?, 'seed', 'inbox', datetime('now'), datetime('now'))`,
    [taskId, ws],
  );
  assert.equal(nextWorkerAttempt(taskId, 'builder'), 1);

  upsertSession({
    scope_key: `agent:mc-runner-dev:main:ws-${ws}:task-${taskId}:builder:1`,
    workspace_id: ws,
    role: 'builder',
    scope_type: 'task_role',
    task_id: taskId,
  });
  assert.equal(nextWorkerAttempt(taskId, 'builder'), 2);

  // Different role doesn't bump builder's counter.
  upsertSession({
    scope_key: `agent:mc-runner-dev:main:ws-${ws}:task-${taskId}:tester:1`,
    workspace_id: ws,
    role: 'tester',
    scope_type: 'task_role',
    task_id: taskId,
  });
  assert.equal(nextWorkerAttempt(taskId, 'builder'), 2);
  assert.equal(nextWorkerAttempt(taskId, 'tester'), 2);
});

test('isScopeKeyedDispatchEnabled: defaults on, opt-out via env=0', () => {
  const prev = process.env.MC_USE_SCOPE_KEYED_DISPATCH;
  delete process.env.MC_USE_SCOPE_KEYED_DISPATCH;
  // Phase F default — on.
  assert.equal(isScopeKeyedDispatchEnabled(), true);
  process.env.MC_USE_SCOPE_KEYED_DISPATCH = '1';
  assert.equal(isScopeKeyedDispatchEnabled(), true);
  process.env.MC_USE_SCOPE_KEYED_DISPATCH = '0';
  assert.equal(isScopeKeyedDispatchEnabled(), false);
  process.env.MC_USE_SCOPE_KEYED_DISPATCH = 'false';
  assert.equal(isScopeKeyedDispatchEnabled(), false);
  if (prev === undefined) delete process.env.MC_USE_SCOPE_KEYED_DISPATCH;
  else process.env.MC_USE_SCOPE_KEYED_DISPATCH = prev;
});
