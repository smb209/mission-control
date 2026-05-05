/**
 * Recurring scheduler — research dispatch branch.
 *
 * These tests exercise the failure paths of the slice-2 research
 * binding (topic missing/archived, researcher missing, runner missing,
 * pause-after-3). The success path requires a live gateway dispatch
 * through `runBrief` and is deferred to the slice-5 eval harness.
 *
 * Pre-existing scope-keyed scheduler behavior is unchanged by slice 2
 * and is exercised end-to-end by `recurring-jobs.test.ts` plus the
 * dispatchScope tests; we don't re-cover it here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import {
  createResearchSchedule,
  getRecurringJob,
} from '@/lib/db/recurring-jobs';
import { dispatchRecurringJobOnce } from './recurring-scheduler';

function freshWorkspace(): string {
  const id = `ws-rs-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function freshTopic(workspaceId: string, name = 'Topic'): string {
  const id = `tp-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT INTO topics (id, workspace_id, name, description, tags_json, created_at, updated_at)
     VALUES (?, ?, ?, '', '[]', datetime('now'), datetime('now'))`,
    [id, workspaceId, name],
  );
  return id;
}

function archiveTopic(topicId: string): void {
  run(`UPDATE topics SET archived_at = datetime('now') WHERE id = ?`, [topicId]);
}

function addResearcher(workspaceId: string): void {
  run(
    `INSERT INTO agents (id, workspace_id, name, role, source, status, created_at, updated_at, is_active)
     VALUES (?, ?, ?, 'researcher', 'local', 'standby', datetime('now'), datetime('now'), 1)`,
    [`agent-${uuidv4().slice(0, 8)}`, workspaceId, 'Test Researcher'],
  );
}

test('research schedule: topic archived → markRunFailure', async () => {
  const ws = freshWorkspace();
  const tp = freshTopic(ws);
  addResearcher(ws);
  const sched = createResearchSchedule({
    workspace_id: ws,
    topic_id: tp,
    brief_template: 'general_brief',
    cadence_seconds: 60,
    first_run_at: new Date().toISOString(),
  });
  archiveTopic(tp);

  await dispatchRecurringJobOnce(sched);
  const after = getRecurringJob(sched.id);
  assert.equal(after?.consecutive_failures, 1);
  assert.equal(after?.run_count, 0);
  assert.equal(after?.status, 'active'); // not yet paused (1 < 3)
});

test('research schedule: missing researcher → markRunFailure', async () => {
  const ws = freshWorkspace();
  const tp = freshTopic(ws);
  // No addResearcher call.
  const sched = createResearchSchedule({
    workspace_id: ws,
    topic_id: tp,
    brief_template: 'general_brief',
    cadence_seconds: 60,
    first_run_at: new Date().toISOString(),
  });

  await dispatchRecurringJobOnce(sched);
  const after = getRecurringJob(sched.id);
  assert.equal(after?.consecutive_failures, 1);
  assert.equal(after?.run_count, 0);
});

test('research schedule: pauses after 3 consecutive failures', async () => {
  const ws = freshWorkspace();
  const tp = freshTopic(ws);
  // Researcher present but no runner — every dispatch will fail at
  // the runner check.
  addResearcher(ws);
  const sched = createResearchSchedule({
    workspace_id: ws,
    topic_id: tp,
    brief_template: 'general_brief',
    cadence_seconds: 60,
    first_run_at: new Date().toISOString(),
  });

  // We don't stub the runner — production code returns null when no
  // runner agent row exists, which is the default in tests.
  await dispatchRecurringJobOnce(sched);
  await dispatchRecurringJobOnce(sched);
  await dispatchRecurringJobOnce(sched);

  const after = getRecurringJob(sched.id);
  assert.equal(after?.consecutive_failures, 3);
  assert.equal(after?.status, 'paused');
});

