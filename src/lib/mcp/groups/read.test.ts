/**
 * Read MCP tools — focused on `read_brief`, the new tool added by
 * slice 4 of the initiative-research-loop. Exercises the handler the
 * same way the runtime MCP server does: register the group on a
 * minimal handler-capturing stub, then call the handler.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import { createBriefWithRun } from '@/lib/db/briefs';
import { markComplete, markRunning } from '@/lib/db/agent-runs';
import { registerReadTools } from './read';

type Handler = (args: Record<string, unknown>) => Promise<{
  content?: Array<{ type: string; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}>;

function makeStubServer(): { handlers: Map<string, Handler>; server: { registerTool: (name: string, _spec: unknown, handler: Handler) => void } } {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _spec: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  };
  return { handlers, server };
}

function freshWorkspace(): string {
  const id = `ws-rb-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function structured(result: { structuredContent?: unknown; content?: Array<{ type: string; text: string }> }): unknown {
  if (result.structuredContent) return result.structuredContent;
  // Fall back to content[0].text JSON, mirroring the SDK's wrapping.
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

test('read_brief: returns the full brief shape including initiative_id + summary + status', async () => {
  const ws = freshWorkspace();
  const { handlers, server } = makeStubServer();
  registerReadTools(server as Parameters<typeof registerReadTools>[0]);
  const handler = handlers.get('read_brief');
  assert.ok(handler, 'read_brief should be registered');

  const initId = `init-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT INTO initiatives (id, workspace_id, kind, title, status, sort_order, created_at, updated_at)
     VALUES (?, ?, 'theme', 'Theme', 'planned', 0, datetime('now'), datetime('now'))`,
    [initId, ws],
  );

  const { brief, agent_run } = createBriefWithRun({
    workspace_id: ws,
    template: 'general_brief',
    title: 'WebGPU survey',
    prompt: 'Survey WebGPU support.',
    initiative_id: initId,
  });
  markRunning(agent_run.id);
  markComplete(agent_run.id);

  const out = await handler!({ agent_id: 'mc-tester', brief_id: brief.id });
  assert.equal(out.isError, undefined, 'should not error');
  const body = structured(out) as Record<string, unknown>;
  assert.equal(body.id, brief.id);
  assert.equal(body.initiative_id, initId);
  assert.equal(body.title, 'WebGPU survey');
  assert.equal(body.prompt, 'Survey WebGPU support.');
  assert.equal(body.template, 'general_brief');
  assert.equal(body.status, 'complete');
  assert.ok(body.completed_at, 'completed_at should be set');
  // result_md is set by setBriefResult during runBrief, not here. We
  // just confirm the field is present in the response shape.
  assert.ok('result_md' in body);
  assert.ok('citations' in body);
  assert.ok('summary' in body);
});

test('read_brief: throws when brief not found', async () => {
  const { handlers, server } = makeStubServer();
  registerReadTools(server as Parameters<typeof registerReadTools>[0]);
  const handler = handlers.get('read_brief')!;
  const out = await handler({ agent_id: 'mc-tester', brief_id: 'does-not-exist' });
  assert.equal(out.isError, true);
});
