/**
 * /api/briefs/[id]/run route tests.
 *
 * Stubs the openclaw client so the orchestrator marks the brief
 * complete synchronously before the route returns. Covers the
 * thin wrapper's contract: 202 on dispatch, 404 unknown, 409
 * already-running.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { POST } from './route';
import { run } from '@/lib/db';
import { createBriefWithRun } from '@/lib/db/briefs';
import { markRunning } from '@/lib/db/agent-runs';
import {
  __setSendChatClientForTests,
  type SendChatClient,
} from '@/lib/openclaw/send-chat';

function freshWorkspace(): string {
  const id = `ws-rbr-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function ensureResearcher(workspaceId: string): void {
  run(
    `INSERT INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, source, gateway_agent_id, session_key_prefix, model, created_at, updated_at)
     VALUES (?, 'mc-researcher-test', 'researcher', '🔍', 'standby', 0, ?, 'gateway', 'gw-r', 'agent:gw-r', 'spark-lb/agent', datetime('now'), datetime('now'))`,
    [`ag-${uuidv4().slice(0, 8)}`, workspaceId],
  );
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function postReq(): NextRequest {
  return new NextRequest('http://localhost/x', { method: 'POST' });
}

function inertStub(): SendChatClient {
  // Stub that "sends" but emits no events — the orchestrator will
  // time out, but the route test only cares about the synchronous
  // dispatch result, so we kick with awaitCompletionForTesting=false
  // (default) which the route does.
  return {
    isConnected: () => true,
    on: () => undefined,
    off: () => undefined,
    call: async () => ({}),
  };
}

test.afterEach(() => {
  __setSendChatClientForTests(null);
});

test('POST /api/briefs/[id]/run: 404 for unknown', async () => {
  const res = await POST(postReq(), ctx('nope'));
  assert.equal(res.status, 404);
});

test('POST /api/briefs/[id]/run: 202 on accepted dispatch', async () => {
  const ws = freshWorkspace();
  ensureResearcher(ws);
  __setSendChatClientForTests(inertStub());
  const { brief } = createBriefWithRun({
    workspace_id: ws, template: 'general_brief',
    title: 'x', prompt: 'p',
  });
  const res = await POST(postReq(), ctx(brief.id));
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.state, 'started');
  assert.equal(body.brief_id, brief.id);
});

test('POST /api/briefs/[id]/run: 409 when brief is already running', async () => {
  const ws = freshWorkspace();
  __setSendChatClientForTests(inertStub());
  const { brief, agent_run } = createBriefWithRun({
    workspace_id: ws, template: 'general_brief',
    title: 'x', prompt: 'p',
  });
  markRunning(agent_run.id);
  const res = await POST(postReq(), ctx(brief.id));
  assert.equal(res.status, 409);
});
