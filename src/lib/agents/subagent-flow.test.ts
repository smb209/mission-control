/**
 * Phase J2 integration test — walks the full data flow without
 * mocking Next.js or openclaw:
 *
 *   1. dispatchSubagent builds the META envelope for a builder.
 *   2. Simulate the PM calling sessions_spawn (just generate a
 *      runId + childSessionKey).
 *   3. Call upsertSession (the work register_subagent_dispatch MCP
 *      tool does internally).
 *   4. Re-call dispatchSubagent for the same task — its briefing
 *      input is the META, but the active-session manifest is on the
 *      coord-task briefing the PM gets re-dispatched. So we also
 *      call buildBriefing for the PM's coord session and assert the
 *      manifest includes the prior dispatch.
 *   5. Simulate subagent_ended via closeSessionByRunId. Verify
 *      next coord briefing has the manifest empty.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import { __setTemplatesDirForTests, buildBriefing } from './briefing';
import { dispatchSubagent } from './dispatch-subagent';
import { closeSessionByRunId, upsertSession } from '@/lib/db/mc-sessions';
import type { Agent } from '@/lib/types';

function freshWorkspace(): string {
  const id = `ws-flow-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function makePm(workspaceId: string): Agent {
  const id = uuidv4();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, gateway_agent_id, source,
                          session_key_prefix, is_pm, is_master, is_active, created_at, updated_at)
     VALUES (?, 'PM', 'pm', ?, 'mc-pm-test-dev', 'gateway',
             'agent:mc-pm-test-dev', 1, 1, 1, datetime('now'), datetime('now'))`,
    [id, workspaceId],
  );
  return {
    id,
    name: 'PM',
    role: 'pm',
    workspace_id: workspaceId,
    gateway_agent_id: 'mc-pm-test-dev',
    session_key_prefix: 'agent:mc-pm-test-dev',
    is_pm: 1,
    is_master: 1,
    is_active: 1,
  } as unknown as Agent;
}

function fixtureTemplates(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'mc-j2-flow-'));
  for (const role of ['builder', 'tester', 'pm']) {
    mkdirSync(path.join(dir, role), { recursive: true });
    writeFileSync(path.join(dir, role, 'SOUL.md'), `# ${role} soul\n`);
  }
  mkdirSync(path.join(dir, '_shared'), { recursive: true });
  writeFileSync(path.join(dir, '_shared', 'notetaker.md'), '# notetaker\n');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('Phase J2 flow: dispatch → register → manifest visible → close → manifest empty', () => {
  const fx = fixtureTemplates();
  __setTemplatesDirForTests(fx.dir);
  const ws = freshWorkspace();
  const pm = makePm(ws);
  try {
    // Seed a task.
    const taskId = uuidv4();
    run(
      `INSERT INTO tasks (id, workspace_id, title, status, created_at, updated_at)
       VALUES (?, ?, 'Build the schema', 'in_progress', datetime('now'), datetime('now'))`,
      [taskId, ws],
    );

    // Step 1 — MC builds the META envelope for the PM.
    const dispatch1 = dispatchSubagent({
      workspace_id: ws,
      role: 'builder',
      pm,
      task_id: taskId,
      attempt: 1,
      trigger_body: 'Build the FOIA agency profile schema.',
    });
    assert.match(dispatch1.meta_message, /sessions_spawn/);
    assert.match(dispatch1.meta_message, /register_subagent_dispatch/);
    assert.equal(
      dispatch1.pm_coord_scope_key,
      `agent:mc-pm-test-dev:coord-task-${taskId}`,
    );

    // Step 2 — simulate openclaw response.
    const runId = `run-${uuidv4().slice(0, 12)}`;
    const childSessionKey = `agent:mc-pm-test-dev:subagent:${uuidv4()}`;

    // Step 3 — PM calls register_subagent_dispatch. We exercise the
    // DAO directly (the MCP tool is just a wrapper around upsertSession).
    upsertSession({
      scope_key: childSessionKey,
      workspace_id: ws,
      role: 'builder',
      scope_type: 'task_role',
      task_id: taskId,
      attempt: 1,
      run_id: runId,
    });

    // Step 4 — re-dispatch a coord briefing for the PM. The active-
    // subagent manifest in the briefing should now include this run.
    const coordBriefing = buildBriefing({
      workspace_id: ws,
      role: 'pm',
      scope_key: dispatch1.pm_coord_scope_key,
      agent_id: pm.id,
      gateway_agent_id: 'mc-pm-test-dev',
      run_group_id: uuidv4(),
      task_id: taskId,
      trigger_body: 'Status check on builder progress.',
    });
    assert.match(coordBriefing, /Active subagents for this task:/);
    assert.match(coordBriefing, /\*\*builder\*\* attempt 1/);
    assert.match(coordBriefing, new RegExp(runId.slice(0, 12)));
    assert.match(coordBriefing, /status=active/);

    // Step 5 — subagent_ended fires. closeSessionByRunId is what the
    // hook handler will call.
    const closed = closeSessionByRunId(runId);
    assert.equal(closed?.status, 'closed');

    // After close, manifest should be empty (only filters active|idle).
    const coordAfter = buildBriefing({
      workspace_id: ws,
      role: 'pm',
      scope_key: dispatch1.pm_coord_scope_key,
      agent_id: pm.id,
      gateway_agent_id: 'mc-pm-test-dev',
      run_group_id: uuidv4(),
      task_id: taskId,
      trigger_body: 'Are we done?',
    });
    assert.doesNotMatch(coordAfter, /Active subagents for this task:/);
  } finally {
    __setTemplatesDirForTests(null);
    fx.cleanup();
  }
});

test('Phase J2 flow: retry attempt produces a second mc_sessions row, manifest shows both', () => {
  const fx = fixtureTemplates();
  __setTemplatesDirForTests(fx.dir);
  const ws = freshWorkspace();
  const pm = makePm(ws);
  try {
    const taskId = uuidv4();
    run(
      `INSERT INTO tasks (id, workspace_id, title, status, created_at, updated_at)
       VALUES (?, ?, 't', 'in_progress', datetime('now'), datetime('now'))`,
      [taskId, ws],
    );

    const runId1 = `run-${uuidv4().slice(0, 12)}`;
    const key1 = `agent:mc-pm-test-dev:subagent:${uuidv4()}`;
    upsertSession({
      scope_key: key1,
      workspace_id: ws,
      role: 'builder',
      scope_type: 'task_role',
      task_id: taskId,
      attempt: 1,
      run_id: runId1,
    });

    // First builder failed; close it as failed.
    closeSessionByRunId(runId1, 'failed');

    // Retry: attempt 2.
    const runId2 = `run-${uuidv4().slice(0, 12)}`;
    const key2 = `agent:mc-pm-test-dev:subagent:${uuidv4()}`;
    upsertSession({
      scope_key: key2,
      workspace_id: ws,
      role: 'builder',
      scope_type: 'task_role',
      task_id: taskId,
      attempt: 2,
      run_id: runId2,
    });

    const coord = buildBriefing({
      workspace_id: ws,
      role: 'pm',
      scope_key: `agent:mc-pm-test-dev:coord-task-${taskId}`,
      agent_id: pm.id,
      gateway_agent_id: 'mc-pm-test-dev',
      run_group_id: uuidv4(),
      task_id: taskId,
      trigger_body: 'Coord check',
    });
    // Manifest filters by status active|idle, so the failed attempt-1
    // row is excluded; only attempt-2 active row appears.
    assert.match(coord, /\*\*builder\*\* attempt 2/);
    assert.doesNotMatch(coord, /\*\*builder\*\* attempt 1/);
  } finally {
    __setTemplatesDirForTests(null);
    fx.cleanup();
  }
});
