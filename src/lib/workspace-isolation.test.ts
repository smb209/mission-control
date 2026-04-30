/**
 * Tests for `resolveDispatchWorkspace` — the strict workspace resolver
 * introduced in slice 3 of the autonomous-flow tightening.
 *
 * These cover the failure-mode matrix from the post-mortem:
 *   - Builder hits unisolated path → must hard-fail (was warn-and-continue)
 *   - Tester/reviewer with no Builder workspace → 409
 *   - Re-dispatch reuses the existing workspace path
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '@/lib/db';
import {
  resolveDispatchWorkspace,
  type DispatchRole,
} from './workspace-isolation';
import type { Task } from './types';

function seedTask(
  opts: {
    repoUrl?: string;
    workspacePath?: string;
    workspacePort?: number;
    status?: string;
  } = {},
): Task & { workspace_path?: string; workspace_port?: number } {
  const id = crypto.randomUUID();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id,
       repo_url, workspace_path, workspace_port, created_at, updated_at)
     VALUES (?, 't', ?, 'normal', 'default', 'default', ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      id,
      opts.status ?? 'assigned',
      opts.repoUrl ?? null,
      opts.workspacePath ?? null,
      opts.workspacePort ?? null,
    ],
  );
  return {
    id,
    title: 't',
    status: (opts.status ?? 'assigned') as Task['status'],
    priority: 'normal',
    workspace_id: 'default',
    business_id: 'default',
    repo_url: opts.repoUrl,
    workspace_path: opts.workspacePath,
    workspace_port: opts.workspacePort,
    created_at: '',
    updated_at: '',
  } as Task & { workspace_path?: string; workspace_port?: number };
}

const okIO = {
  existsSync: () => true,
  createTaskWorkspace: async () => ({
    path: '/tmp/created-ws',
    strategy: 'worktree' as const,
    branch: 'task/abc',
    baseBranch: 'main',
    port: 4011,
  }),
};

test('non-repo product: returns shared dir, not isolated', async () => {
  const task = seedTask(); // no repo_url → no isolation strategy
  const result = await resolveDispatchWorkspace(task, 'builder', okIO);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.isolated, false);
});

test('repo-backed builder dispatch: creates fresh workspace when none recorded', async () => {

  const task = seedTask({ repoUrl: 'https://github.com/x/y.git' });
  const result = await resolveDispatchWorkspace(task, 'builder', okIO);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.isolated, true);
  assert.equal(result.reused, false);
  assert.equal(result.path, '/tmp/created-ws');
  assert.equal(result.branch, 'task/abc');
});

test('repo-backed builder re-dispatch: reuses existing on-disk workspace', async () => {

  const task = seedTask({ repoUrl: 'https://github.com/x/y.git',
    workspacePath: '/already/exists',
    workspacePort: 4019,
  });
  let createCalls = 0;
  const io = {
    existsSync: (p: string) => p === '/already/exists',
    createTaskWorkspace: async () => {
      createCalls++;
      return okIO.createTaskWorkspace();
    },
  };
  const result = await resolveDispatchWorkspace(task, 'builder', io);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reused, true);
  assert.equal(result.path, '/already/exists');
  assert.equal(result.port, 4019);
  assert.equal(createCalls, 0);
});

test('repo-backed builder: createTaskWorkspace failure returns 503 (not warn-and-continue)', async () => {

  const task = seedTask({ repoUrl: 'https://github.com/x/y.git' });
  const io = {
    existsSync: () => false,
    createTaskWorkspace: async () => {
      throw new Error('rsync target missing');
    },
  };
  const result = await resolveDispatchWorkspace(task, 'builder', io);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'workspace_isolation_failed');
  assert.equal(result.http_status, 503);
  assert.match(result.detail, /rsync target missing/);
});

test('repo-backed tester/reviewer: reuses Builder workspace when present', async () => {

  const task = seedTask({ repoUrl: 'https://github.com/x/y.git',
    workspacePath: '/wt/task-x',
    workspacePort: 4023,
    status: 'testing',
  });
  let createCalls = 0;
  const io = {
    existsSync: () => true,
    createTaskWorkspace: async () => {
      createCalls++;
      return okIO.createTaskWorkspace();
    },
  };
  const result = await resolveDispatchWorkspace(task, 'tester_or_reviewer' as DispatchRole, io);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.path, '/wt/task-x');
  assert.equal(result.reused, true);
  assert.equal(createCalls, 0); // never call create on tester/reviewer
});

test('repo-backed tester: missing workspace_path returns 409', async () => {

  const task = seedTask({ repoUrl: 'https://github.com/x/y.git', status: 'testing' }); // no workspace_path
  const result = await resolveDispatchWorkspace(task, 'tester_or_reviewer', okIO);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'no_workspace_for_quality_stage');
  assert.equal(result.http_status, 409);
});

test('non-repo tester: returns shared dir without 409 (no strategy → not enforced)', async () => {
  const task = seedTask({ status: 'testing' });
  const result = await resolveDispatchWorkspace(task, 'tester_or_reviewer', okIO);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.isolated, false);
});
