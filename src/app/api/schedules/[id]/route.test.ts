/**
 * /api/schedules/[id] route tests.
 *
 * Covers GET, PATCH (cadence change, status pause/resume), DELETE,
 * and the run-now sub-route's behavior.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { DELETE, GET, PATCH } from './route';
import { POST as RUN_NOW } from './run-now/route';
import { run } from '@/lib/db';
import { createTopic } from '@/lib/db/topics';
import {
  createResearchSchedule,
  getRecurringJob,
  setJobStatus,
} from '@/lib/db/recurring-jobs';

function freshWorkspace(): string {
  const id = `ws-srid-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function patchReq(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/schedules/x', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeSchedule(): { ws: string; topicId: string; jobId: string } {
  const ws = freshWorkspace();
  const tp = createTopic({ workspace_id: ws, name: 'Topic' });
  const sched = createResearchSchedule({
    workspace_id: ws,
    topic_id: tp.id,
    brief_template: 'general_brief',
    cadence_seconds: 60,
  });
  return { ws, topicId: tp.id, jobId: sched.id };
}

test('GET /api/schedules/[id]: 404 for unknown', async () => {
  const res = await GET(new NextRequest('http://localhost/x'), ctx('nope'));
  assert.equal(res.status, 404);
});

test('PATCH /api/schedules/[id]: cadence_seconds updates + re-anchors next_run_at', async () => {
  const { jobId } = makeSchedule();
  const before = getRecurringJob(jobId)!;
  const res = await PATCH(patchReq({ cadence_seconds: 600 }), ctx(jobId));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.cadence_seconds, 600);
  // next_run_at moved to ~ created_at + 600s; before was created_at + 60s.
  assert.notEqual(body.next_run_at, before.next_run_at);
});

test('PATCH /api/schedules/[id]: pause + resume round trip', async () => {
  const { jobId } = makeSchedule();
  const paused = await PATCH(patchReq({ status: 'paused' }), ctx(jobId));
  assert.equal((await paused.json()).status, 'paused');

  // Simulate previous failures so we can confirm resume clears them.
  run(`UPDATE recurring_jobs SET consecutive_failures = 2 WHERE id = ?`, [jobId]);

  const resumed = await PATCH(patchReq({ status: 'active' }), ctx(jobId));
  const resumedBody = await resumed.json();
  assert.equal(resumedBody.status, 'active');
  assert.equal(resumedBody.consecutive_failures, 0);
});

test('DELETE /api/schedules/[id]: 204 on success, 404 thereafter', async () => {
  const { jobId } = makeSchedule();
  const res = await DELETE(new NextRequest('http://localhost/x'), ctx(jobId));
  assert.equal(res.status, 204);
  assert.equal(getRecurringJob(jobId), null);

  const second = await DELETE(new NextRequest('http://localhost/x'), ctx(jobId));
  assert.equal(second.status, 404);
});

test('POST /api/schedules/[id]/run-now: bumps next_run_at to ~now', async () => {
  const { jobId } = makeSchedule();
  const before = getRecurringJob(jobId)!;
  const res = await RUN_NOW(new NextRequest('http://localhost/x'), ctx(jobId));
  assert.equal(res.status, 200);
  const body = await res.json();
  // New next_run_at should be earlier than the one we got out of
  // createResearchSchedule (which was 60s out).
  assert.ok(Date.parse(body.next_run_at) < Date.parse(before.next_run_at));
});

test('POST /api/schedules/[id]/run-now: 400 when paused', async () => {
  const { jobId } = makeSchedule();
  setJobStatus(jobId, 'paused');
  const res = await RUN_NOW(new NextRequest('http://localhost/x'), ctx(jobId));
  assert.equal(res.status, 400);
});
