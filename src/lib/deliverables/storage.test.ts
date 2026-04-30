/**
 * Smoke tests for getTaskDeliverableDir's perspective handling.
 *
 * Slice 7 of the autonomous-flow tightening. The AlertDialog Tester
 * wrote a screenshot to `/app/workspace/...` (container path) on a host
 * runtime and got ENOENT because the dispatch always passed 'host'.
 * Now `agent.runtime_kind` picks the perspective at dispatch time. This
 * test pins the underlying resolver behavior so future refactors can't
 * silently regress.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { getTaskDeliverableDir } from './storage';

test('getTaskDeliverableDir(host) and (container) diverge when env paths differ', () => {
  const prevHost = process.env.MC_DELIVERABLES_HOST_PATH;
  const prevContainer = process.env.MC_DELIVERABLES_CONTAINER_PATH;
  process.env.MC_DELIVERABLES_HOST_PATH = '/Users/op/projects';
  process.env.MC_DELIVERABLES_CONTAINER_PATH = '/app/workspace/projects';

  const taskId = 'tid-7';
  const hostPath = getTaskDeliverableDir(taskId, 'host');
  const containerPath = getTaskDeliverableDir(taskId, 'container');

  assert.match(hostPath, /^\/Users\/op\/projects/);
  assert.match(containerPath, /^\/app\/workspace\/projects/);
  assert.notEqual(hostPath, containerPath);

  // Cleanup
  if (prevHost === undefined) delete process.env.MC_DELIVERABLES_HOST_PATH;
  else process.env.MC_DELIVERABLES_HOST_PATH = prevHost;
  if (prevContainer === undefined) delete process.env.MC_DELIVERABLES_CONTAINER_PATH;
  else process.env.MC_DELIVERABLES_CONTAINER_PATH = prevContainer;
});

test('getTaskDeliverableDir collapses when env paths coincide (local dev default)', () => {
  const prevHost = process.env.MC_DELIVERABLES_HOST_PATH;
  const prevContainer = process.env.MC_DELIVERABLES_CONTAINER_PATH;
  delete process.env.MC_DELIVERABLES_HOST_PATH;
  delete process.env.MC_DELIVERABLES_CONTAINER_PATH;

  const taskId = 'tid-collapse';
  const hostPath = getTaskDeliverableDir(taskId, 'host');
  const containerPath = getTaskDeliverableDir(taskId, 'container');
  assert.equal(hostPath, containerPath);

  if (prevHost !== undefined) process.env.MC_DELIVERABLES_HOST_PATH = prevHost;
  if (prevContainer !== undefined) process.env.MC_DELIVERABLES_CONTAINER_PATH = prevContainer;
});
