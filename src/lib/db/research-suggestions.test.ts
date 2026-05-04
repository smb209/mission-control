/**
 * research_suggestions DAO tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import {
  createSuggestion,
  dismissPendingForWorkspaceKind,
  getSuggestion,
  listSuggestions,
  markAccepted,
  markDismissed,
  markRejected,
  SuggestionValidationError,
} from './research-suggestions';

function freshWorkspace(): string {
  const id = `ws-rs-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

test('createSuggestion: round-trip topic kind', () => {
  const ws = freshWorkspace();
  const s = createSuggestion({
    workspace_id: ws,
    kind: 'topic',
    payload: {
      name: 'GLP-1 regulation',
      description: 'Watch FDA actions',
      tags: ['pharma'],
    },
    rationale: 'Three initiatives touch healthcare regulation; no topic exists.',
  });
  assert.equal(s.workspace_id, ws);
  assert.equal(s.kind, 'topic');
  assert.equal(s.status, 'pending');
  assert.equal(s.rationale, 'Three initiatives touch healthcare regulation; no topic exists.');
  const payload = s.payload as { name: string; description: string; tags: string[] };
  assert.equal(payload.name, 'GLP-1 regulation');
  assert.deepEqual(payload.tags, ['pharma']);
});

test('createSuggestion: round-trip brief kind', () => {
  const ws = freshWorkspace();
  const s = createSuggestion({
    workspace_id: ws,
    kind: 'brief',
    payload: {
      title: 'WebGPU survey',
      prompt: 'Survey browser support',
      template: 'general_brief',
    },
  });
  assert.equal(s.kind, 'brief');
  const payload = s.payload as { title: string; prompt: string };
  assert.equal(payload.title, 'WebGPU survey');
});

test('createSuggestion: rejects empty workspace_id', () => {
  assert.throws(
    () => createSuggestion({
      workspace_id: '   ',
      kind: 'topic',
      payload: { name: 'x', description: '', tags: [] },
    }),
    SuggestionValidationError,
  );
});

test('createSuggestion: rejects topic without name', () => {
  const ws = freshWorkspace();
  assert.throws(
    () => createSuggestion({
      workspace_id: ws,
      kind: 'topic',
      payload: { name: '   ', description: '', tags: [] },
    }),
    SuggestionValidationError,
  );
});

test('createSuggestion: rejects brief without title or prompt', () => {
  const ws = freshWorkspace();
  assert.throws(
    () => createSuggestion({
      workspace_id: ws,
      kind: 'brief',
      payload: { title: '', prompt: 'x', template: 'general_brief' },
    }),
    SuggestionValidationError,
  );
  assert.throws(
    () => createSuggestion({
      workspace_id: ws,
      kind: 'brief',
      payload: { title: 'x', prompt: '', template: 'general_brief' },
    }),
    SuggestionValidationError,
  );
});

test('listSuggestions: workspace-scoped, filters by kind/status', () => {
  const wsA = freshWorkspace();
  const wsB = freshWorkspace();
  createSuggestion({
    workspace_id: wsA,
    kind: 'topic',
    payload: { name: 'A1', description: '', tags: [] },
  });
  const sBrief = createSuggestion({
    workspace_id: wsA,
    kind: 'brief',
    payload: { title: 'A2', prompt: 'p', template: 'general_brief' },
  });
  createSuggestion({
    workspace_id: wsB,
    kind: 'topic',
    payload: { name: 'B1', description: '', tags: [] },
  });

  const allA = listSuggestions(wsA);
  assert.equal(allA.length, 2);

  const topicsA = listSuggestions(wsA, { kind: 'topic' });
  assert.equal(topicsA.length, 1);

  const briefsA = listSuggestions(wsA, { kind: 'brief' });
  assert.equal(briefsA.length, 1);
  assert.equal(briefsA[0].id, sBrief.id);

  const allB = listSuggestions(wsB);
  assert.equal(allB.length, 1);
  assert.equal((allB[0].payload as { name: string }).name, 'B1');
});

test('markAccepted: transitions pending → accepted with accepted_as_id', () => {
  const ws = freshWorkspace();
  const s = createSuggestion({
    workspace_id: ws,
    kind: 'topic',
    payload: { name: 't', description: '', tags: [] },
  });
  const updated = markAccepted(s.id, 'real-topic-id');
  assert.equal(updated?.status, 'accepted');
  assert.equal(updated?.accepted_as_id, 'real-topic-id');
  assert.ok(updated?.decided_at);
});

test('markAccepted: no-op when already terminal', () => {
  const ws = freshWorkspace();
  const s = createSuggestion({
    workspace_id: ws,
    kind: 'topic',
    payload: { name: 't', description: '', tags: [] },
  });
  markRejected(s.id);
  const reAccepted = markAccepted(s.id, 'x');
  assert.equal(reAccepted?.status, 'rejected');
});

test('markRejected + markDismissed lifecycle', () => {
  const ws = freshWorkspace();
  const s1 = createSuggestion({
    workspace_id: ws,
    kind: 'topic',
    payload: { name: 't1', description: '', tags: [] },
  });
  const s2 = createSuggestion({
    workspace_id: ws,
    kind: 'topic',
    payload: { name: 't2', description: '', tags: [] },
  });
  assert.equal(markRejected(s1.id)?.status, 'rejected');
  assert.equal(markDismissed(s2.id)?.status, 'dismissed');
});

test('dismissPendingForWorkspaceKind: bulk-dismisses pending in scope', () => {
  const ws = freshWorkspace();
  // Two pending topics, one accepted topic, one pending brief.
  const t1 = createSuggestion({
    workspace_id: ws,
    kind: 'topic',
    payload: { name: 'a', description: '', tags: [] },
  });
  const t2 = createSuggestion({
    workspace_id: ws,
    kind: 'topic',
    payload: { name: 'b', description: '', tags: [] },
  });
  const t3 = createSuggestion({
    workspace_id: ws,
    kind: 'topic',
    payload: { name: 'c', description: '', tags: [] },
  });
  markAccepted(t3.id, 'x');
  const b1 = createSuggestion({
    workspace_id: ws,
    kind: 'brief',
    payload: { title: 'br', prompt: 'p', template: 'general_brief' },
  });

  const changed = dismissPendingForWorkspaceKind(ws, 'topic');
  assert.equal(changed, 2);
  assert.equal(getSuggestion(t1.id)?.status, 'dismissed');
  assert.equal(getSuggestion(t2.id)?.status, 'dismissed');
  assert.equal(getSuggestion(t3.id)?.status, 'accepted'); // unchanged
  assert.equal(getSuggestion(b1.id)?.status, 'pending');  // wrong kind, unchanged
});

test('FK cascade: deleting workspace removes its suggestions', () => {
  const ws = freshWorkspace();
  const s = createSuggestion({
    workspace_id: ws,
    kind: 'topic',
    payload: { name: 't', description: '', tags: [] },
  });
  run(`DELETE FROM workspaces WHERE id = ?`, [ws]);
  assert.equal(getSuggestion(s.id), null);
});

test('payload JSON survives round-trip', () => {
  const ws = freshWorkspace();
  const s = createSuggestion({
    workspace_id: ws,
    kind: 'brief',
    payload: {
      title: 'WebGPU support',
      prompt: 'Survey browser support; quote spec authors where relevant.',
      topic_id: 'some-topic-uuid',
      template: 'general_brief',
    },
  });
  const reloaded = getSuggestion(s.id);
  const p = reloaded?.payload as { title: string; prompt: string; topic_id: string };
  assert.equal(p.title, 'WebGPU support');
  assert.equal(p.topic_id, 'some-topic-uuid');
  assert.match(p.prompt, /quote spec authors/);
});
