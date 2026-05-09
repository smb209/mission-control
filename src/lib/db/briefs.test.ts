/**
 * briefs DAO tests.
 *
 * Covers: createBriefWithRun (transactional with agent_runs), topic
 * validation (cross-workspace + archived), get/list, setBriefResult /
 * setBriefError, citation JSON round-trip, FK cascades, workspace
 * isolation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '@/lib/db';
import {
  archiveTopic,
  createTopic,
} from './topics';
import { getAgentRun } from './agent-runs';
import {
  BriefValidationError,
  createBriefWithRun,
  getBrief,
  getBriefByAgentRun,
  listBriefs,
  setBriefError,
  setBriefResult,
} from './briefs';

function freshWorkspace(): string {
  const id = `ws-br-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

const baseInput = (workspaceId: string, overrides: Partial<Parameters<typeof createBriefWithRun>[0]> = {}) => ({
  workspace_id: workspaceId,
  template: 'general_brief' as const,
  title: 'WebGPU support survey',
  prompt: 'Summarize WebGPU browser support today.',
  ...overrides,
});

test('createBriefWithRun: inserts brief + agent_run together', () => {
  const ws = freshWorkspace();
  const { brief, agent_run } = createBriefWithRun(baseInput(ws));
  assert.equal(brief.workspace_id, ws);
  assert.equal(brief.template, 'general_brief');
  assert.equal(brief.title, 'WebGPU support survey');
  assert.equal(brief.requested_by, 'manual');
  assert.equal(brief.topic_id, null);
  assert.equal(brief.result_md, null);
  assert.deepEqual(brief.citations, []);
  assert.equal(brief.error_md, null);

  assert.equal(agent_run.kind, 'brief');
  assert.equal(agent_run.status, 'queued');
  assert.equal(agent_run.workspace_id, ws);

  // 1:1 linkage.
  assert.equal(brief.agent_run_id, agent_run.id);
  assert.equal(getBriefByAgentRun(agent_run.id)?.id, brief.id);
});

test('createBriefWithRun: rejects blank title / prompt / workspace', () => {
  const ws = freshWorkspace();
  assert.throws(
    () => createBriefWithRun(baseInput(ws, { title: '   ' })),
    BriefValidationError,
  );
  assert.throws(
    () => createBriefWithRun(baseInput(ws, { prompt: '' })),
    BriefValidationError,
  );
  assert.throws(
    () => createBriefWithRun(baseInput('   ')),
    BriefValidationError,
  );
});

test('createBriefWithRun: links to topic in same workspace', () => {
  const ws = freshWorkspace();
  const topic = createTopic({ workspace_id: ws, name: 'GLP-1' });
  const { brief } = createBriefWithRun(baseInput(ws, { topic_id: topic.id }));
  assert.equal(brief.topic_id, topic.id);
});

test('createBriefWithRun: rejects unknown topic_id', () => {
  const ws = freshWorkspace();
  assert.throws(
    () => createBriefWithRun(baseInput(ws, { topic_id: 'not-a-real-topic' })),
    BriefValidationError,
  );
});

test('createBriefWithRun: rejects topic from another workspace', () => {
  const wsA = freshWorkspace();
  const wsB = freshWorkspace();
  const topicB = createTopic({ workspace_id: wsB, name: 'B-topic' });
  assert.throws(
    () => createBriefWithRun(baseInput(wsA, { topic_id: topicB.id })),
    BriefValidationError,
  );
});

test('createBriefWithRun: rejects archived topic', () => {
  const ws = freshWorkspace();
  const topic = createTopic({ workspace_id: ws, name: 'Stale' });
  archiveTopic(topic.id);
  assert.throws(
    () => createBriefWithRun(baseInput(ws, { topic_id: topic.id })),
    BriefValidationError,
  );
});

test('createBriefWithRun: failed topic validation does not insert agent_run', () => {
  const ws = freshWorkspace();
  const beforeCount = queryOne<{ c: number }>(
    `SELECT COUNT(*) as c FROM agent_runs WHERE workspace_id = ?`,
    [ws],
  )?.c ?? 0;
  assert.throws(
    () => createBriefWithRun(baseInput(ws, { topic_id: 'nope' })),
    BriefValidationError,
  );
  const afterCount = queryOne<{ c: number }>(
    `SELECT COUNT(*) as c FROM agent_runs WHERE workspace_id = ?`,
    [ws],
  )?.c ?? 0;
  assert.equal(afterCount, beforeCount);
});

test('listBriefs: workspace-scoped, newest first, optional topic filter', () => {
  const wsA = freshWorkspace();
  const wsB = freshWorkspace();
  const topic = createTopic({ workspace_id: wsA, name: 't' });
  createBriefWithRun(baseInput(wsA, { title: 'first' }));
  createBriefWithRun(baseInput(wsA, { title: 'second', topic_id: topic.id }));
  createBriefWithRun(baseInput(wsB, { title: 'B-only' }));

  const allA = listBriefs(wsA);
  assert.equal(allA.length, 2);
  // Newest first.
  assert.equal(allA[0].title, 'second');
  assert.equal(allA[1].title, 'first');

  const onTopic = listBriefs(wsA, { topic_id: topic.id });
  assert.equal(onTopic.length, 1);
  assert.equal(onTopic[0].title, 'second');

  const allB = listBriefs(wsB);
  assert.equal(allB.length, 1);
  assert.equal(allB[0].title, 'B-only');
});

test('setBriefResult: persists markdown + citations', () => {
  const ws = freshWorkspace();
  const { brief } = createBriefWithRun(baseInput(ws));
  const updated = setBriefResult(brief.id, {
    result_md: '# Summary\n\nSome findings.',
    citations: [
      { url: 'https://example.com/a', title: 'A' },
      { url: 'https://example.com/b' },
    ],
  });
  assert.equal(updated?.result_md, '# Summary\n\nSome findings.');
  assert.equal(updated?.citations.length, 2);
  assert.equal(updated?.citations[0].url, 'https://example.com/a');
  assert.equal(updated?.citations[1].url, 'https://example.com/b');
});

test('setBriefResult: returns null for unknown id', () => {
  assert.equal(setBriefResult('nope', { result_md: 'x' }), null);
});

test('setBriefError: persists error markdown', () => {
  const ws = freshWorkspace();
  const { brief } = createBriefWithRun(baseInput(ws));
  const updated = setBriefError(brief.id, 'gateway timed out');
  assert.equal(updated?.error_md, 'gateway timed out');
});

test('citations JSON round-trip drops malformed entries', () => {
  const ws = freshWorkspace();
  const { brief } = createBriefWithRun(baseInput(ws));
  // Manually corrupt the citations JSON.
  run(
    `UPDATE briefs SET citations_json = ? WHERE id = ?`,
    [
      JSON.stringify([
        { url: 'https://ok.example' },
        { title: 'no-url' },
        null,
        'string-not-object',
        { url: 'https://also-ok.example', title: 'B' },
      ]),
      brief.id,
    ],
  );
  const reloaded = getBrief(brief.id);
  assert.equal(reloaded?.citations.length, 2);
  assert.equal(reloaded?.citations[0].url, 'https://ok.example');
  assert.equal(reloaded?.citations[1].url, 'https://also-ok.example');
});

test('FK cascade: deleting agent_run cascades to brief', () => {
  const ws = freshWorkspace();
  const { brief, agent_run } = createBriefWithRun(baseInput(ws));
  run(`DELETE FROM agent_runs WHERE id = ?`, [agent_run.id]);
  assert.equal(getBrief(brief.id), null);
});

test('FK cascade: deleting workspace removes briefs and their agent_runs', () => {
  const ws = freshWorkspace();
  const { brief, agent_run } = createBriefWithRun(baseInput(ws));
  run(`DELETE FROM workspaces WHERE id = ?`, [ws]);
  assert.equal(getBrief(brief.id), null);
  assert.equal(getAgentRun(agent_run.id), null);
});

test('FK SET NULL: archiving topic does not affect existing briefs; deleting topic nulls topic_id', () => {
  const ws = freshWorkspace();
  const topic = createTopic({ workspace_id: ws, name: 't' });
  const { brief } = createBriefWithRun(baseInput(ws, { topic_id: topic.id }));
  // Archive: brief still has the topic_id (archive is soft).
  archiveTopic(topic.id);
  assert.equal(getBrief(brief.id)?.topic_id, topic.id);
  // Hard delete: topic_id should null out per FK ON DELETE SET NULL.
  run(`DELETE FROM topics WHERE id = ?`, [topic.id]);
  assert.equal(getBrief(brief.id)?.topic_id, null);
});

test('deleteBrief: removes the brief and its agent_run via FK cascade', async () => {
  const { deleteBrief } = await import('./briefs');
  const ws = freshWorkspace();
  const { brief, agent_run } = createBriefWithRun(baseInput(ws));
  assert.equal(deleteBrief(brief.id), true);
  assert.equal(getBrief(brief.id), null);
  assert.equal(getAgentRun(agent_run.id), null);
});

test('deleteBrief: returns false for unknown id', async () => {
  const { deleteBrief } = await import('./briefs');
  assert.equal(deleteBrief('does-not-exist'), false);
});

test('createBriefWithRun: persists initiative_id when provided', async () => {
  const { findBriefChainRoot, setBriefSummary } = await import('./briefs');
  const ws = freshWorkspace();
  // Seed an initiative in this workspace.
  const initId = `init-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT INTO initiatives (id, workspace_id, kind, title, status, sort_order, created_at, updated_at)
     VALUES (?, ?, 'theme', 'Test theme', 'planned', 0, datetime('now'), datetime('now'))`,
    [initId, ws],
  );

  const { brief } = createBriefWithRun(baseInput(ws, { initiative_id: initId }));
  assert.equal(brief.initiative_id, initId);
  assert.equal(brief.summary, null);
  assert.equal(brief.source_ref, null);

  // Round-trip through getBrief.
  assert.equal(getBrief(brief.id)?.initiative_id, initId);

  // setBriefSummary persists.
  const updated = setBriefSummary(brief.id, 'WebGPU is broadly supported.');
  assert.equal(updated?.summary, 'WebGPU is broadly supported.');

  // Listing by initiative finds it.
  const byInit = listBriefs(ws, { initiative_id: initId });
  assert.equal(byInit.length, 1);
  assert.equal(byInit[0].id, brief.id);

  // Initiative-less briefs don't bleed into the filtered list.
  const { brief: other } = createBriefWithRun(baseInput(ws));
  assert.equal(other.initiative_id, null);
  assert.equal(listBriefs(ws, { initiative_id: initId }).length, 1);

  // ON DELETE SET NULL: deleting the initiative nulls out the FK.
  run(`DELETE FROM initiatives WHERE id = ?`, [initId]);
  assert.equal(getBrief(brief.id)?.initiative_id, null);

  // Chain root walk: a brief with no source_ref returns itself.
  assert.equal(findBriefChainRoot(brief.id), brief.id);
});

test('findBriefChainRoot: walks source_ref chain back to the original', async () => {
  const { findBriefChainRoot } = await import('./briefs');
  const ws = freshWorkspace();
  const original = createBriefWithRun(baseInput(ws));
  const rerun1 = createBriefWithRun(baseInput(ws, { source_ref: `brief:${original.brief.id}` }));
  const rerun2 = createBriefWithRun(baseInput(ws, { source_ref: `brief:${rerun1.brief.id}` }));

  assert.equal(findBriefChainRoot(rerun2.brief.id), original.brief.id);
  assert.equal(findBriefChainRoot(rerun1.brief.id), original.brief.id);
  assert.equal(findBriefChainRoot(original.brief.id), original.brief.id);
});
