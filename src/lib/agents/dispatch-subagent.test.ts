/**
 * dispatchSubagent primitive tests (Phase J1).
 *
 * Pure-function tests on the META envelope shape + worker briefing
 * composition + context-mode resolution. Doesn't exercise the openclaw
 * round-trip — that's J2's territory once the dispatch route wires
 * this in behind the feature flag.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import { __setTemplatesDirForTests } from './briefing';
import { dispatchSubagent } from './dispatch-subagent';
import type { Agent } from '@/lib/types';

function freshWorkspace(): string {
  const id = `ws-ds-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function makePmAgent(workspaceId: string): Agent {
  const id = uuidv4();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, gateway_agent_id, source,
                          session_key_prefix, is_pm, is_master, is_active, created_at, updated_at)
     VALUES (?, 'MC PM (test)', 'pm', ?, ?, 'gateway', ?, 1, 1, 1, datetime('now'), datetime('now'))`,
    [id, workspaceId, 'mc-pm-test-dev', 'agent:mc-pm-test-dev'],
  );
  return {
    id,
    name: 'MC PM (test)',
    role: 'pm',
    workspace_id: workspaceId,
    gateway_agent_id: 'mc-pm-test-dev',
    session_key_prefix: 'agent:mc-pm-test-dev',
    is_pm: 1,
    is_master: 1,
    is_active: 1,
  } as unknown as Agent;
}

function makeFixtureTemplates(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'mc-dispatch-subagent-'));
  for (const role of ['builder', 'tester', 'reviewer']) {
    mkdirSync(path.join(dir, role), { recursive: true });
    writeFileSync(path.join(dir, role, 'SOUL.md'), `# ${role} soul\n`);
  }
  mkdirSync(path.join(dir, '_shared'), { recursive: true });
  writeFileSync(path.join(dir, '_shared', 'notetaker.md'), '# notetaker\n');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('dispatchSubagent: META envelope contains task_id, role, attempt + sessions_spawn args', () => {
  const fx = makeFixtureTemplates();
  __setTemplatesDirForTests(fx.dir);
  const ws = freshWorkspace();
  const pm = makePmAgent(ws);
  try {
    const taskId = uuidv4();
    const result = dispatchSubagent({
      workspace_id: ws,
      role: 'builder',
      pm,
      task_id: taskId,
      attempt: 1,
      trigger_body: 'Build the FOIA agency profile schema.',
    });
    assert.match(result.meta_message, /MC subagent dispatch/);
    assert.match(result.meta_message, new RegExp(`task=${taskId}`));
    assert.match(result.meta_message, /Spawn a \*\*builder\*\* subagent/);
    assert.match(result.meta_message, /sessions_spawn/);
    assert.match(result.meta_message, /register_subagent_dispatch/);
    assert.match(result.meta_message, /WORKER_BRIEFING/);
    assert.match(result.meta_message, /Build the FOIA agency profile schema/);
    assert.match(result.meta_message, /"context": "isolated"/, 'default context_mode for builder');
  } finally {
    __setTemplatesDirForTests(null);
    fx.cleanup();
  }
});

test('dispatchSubagent: pm_coord_scope_key uses agent.session_key_prefix + coord-task-<id>', () => {
  const fx = makeFixtureTemplates();
  __setTemplatesDirForTests(fx.dir);
  const ws = freshWorkspace();
  const pm = makePmAgent(ws);
  try {
    const taskId = uuidv4();
    const result = dispatchSubagent({
      workspace_id: ws,
      role: 'builder',
      pm,
      task_id: taskId,
      attempt: 1,
      trigger_body: 'body',
    });
    assert.equal(result.pm_coord_scope_key, `agent:mc-pm-test-dev:coord-task-${taskId}`);
  } finally {
    __setTemplatesDirForTests(null);
    fx.cleanup();
  }
});

test('dispatchSubagent: context_mode override beats per-role default', () => {
  const fx = makeFixtureTemplates();
  __setTemplatesDirForTests(fx.dir);
  const ws = freshWorkspace();
  const pm = makePmAgent(ws);
  try {
    const result = dispatchSubagent({
      workspace_id: ws,
      role: 'builder',
      pm,
      task_id: uuidv4(),
      attempt: 1,
      trigger_body: 'body',
      context_mode: 'fork',
    });
    assert.equal(result.context_mode, 'fork');
    assert.match(result.meta_message, /"context": "fork"/);
  } finally {
    __setTemplatesDirForTests(null);
    fx.cleanup();
  }
});

test('dispatchSubagent: agent_role_overrides.subagent_context_mode flips role default', () => {
  const fx = makeFixtureTemplates();
  __setTemplatesDirForTests(fx.dir);
  const ws = freshWorkspace();
  const pm = makePmAgent(ws);
  try {
    run(
      `INSERT INTO agent_role_overrides (workspace_id, role, subagent_context_mode)
       VALUES (?, 'builder', 'fork')`,
      [ws],
    );
    const result = dispatchSubagent({
      workspace_id: ws,
      role: 'builder',
      pm,
      task_id: uuidv4(),
      attempt: 1,
      trigger_body: 'body',
    });
    assert.equal(result.context_mode, 'fork');
  } finally {
    __setTemplatesDirForTests(null);
    fx.cleanup();
  }
});

test('dispatchSubagent: worker_briefing carries identity preamble + role section + trigger body', () => {
  const fx = makeFixtureTemplates();
  __setTemplatesDirForTests(fx.dir);
  const ws = freshWorkspace();
  const pm = makePmAgent(ws);
  try {
    const result = dispatchSubagent({
      workspace_id: ws,
      role: 'builder',
      pm,
      task_id: uuidv4(),
      attempt: 1,
      trigger_body: 'TRIGGER_MARKER',
    });
    assert.match(result.worker_briefing, new RegExp(`Your agent_id is: ${pm.id}`));
    assert.match(result.worker_briefing, /Your gateway_agent_id is: mc-pm-test-dev/);
    assert.match(result.worker_briefing, /# Role: builder/);
    assert.match(result.worker_briefing, /TRIGGER_MARKER/);
    assert.ok(result.worker_briefing_bytes > 0);
  } finally {
    __setTemplatesDirForTests(null);
    fx.cleanup();
  }
});

test('dispatchSubagent: attempt number flows into meta + label', () => {
  const fx = makeFixtureTemplates();
  __setTemplatesDirForTests(fx.dir);
  const ws = freshWorkspace();
  const pm = makePmAgent(ws);
  try {
    const taskId = 'aabbccdd-1111-2222-3333-444455556666';
    const result = dispatchSubagent({
      workspace_id: ws,
      role: 'tester',
      pm,
      task_id: taskId,
      attempt: 3,
      trigger_body: 'body',
    });
    assert.match(result.meta_message, /Attempt #3/);
    assert.match(result.meta_message, /"label": "tester-aabbccdd-attempt3"/);
    assert.match(result.meta_message, /"attempt": 3/);
  } finally {
    __setTemplatesDirForTests(null);
    fx.cleanup();
  }
});
