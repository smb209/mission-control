/**
 * /api/briefs/[id] route tests.
 *
 * Covers: GET (200 returns brief + agent_run; 404 for unknown).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { run } from '@/lib/db';
import { createBriefWithRun } from '@/lib/db/briefs';

function freshWorkspace(): string {
  const id = `ws-brid-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

test('GET /api/briefs/[id]: 404 for unknown', async () => {
  const res = await GET(new NextRequest('http://localhost/x'), ctx('nope'));
  assert.equal(res.status, 404);
});

test('GET /api/briefs/[id]: 200 with hydrated agent_run', async () => {
  const ws = freshWorkspace();
  const { brief, agent_run } = createBriefWithRun({
    workspace_id: ws, template: 'general_brief',
    title: 'survey', prompt: 'p',
  });
  const res = await GET(new NextRequest('http://localhost/x'), ctx(brief.id));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.brief.id, brief.id);
  assert.equal(body.agent_run.id, agent_run.id);
  assert.equal(body.agent_run.status, 'queued');
});
