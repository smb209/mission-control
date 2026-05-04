/**
 * topics DAO tests.
 *
 * Covers: create / get / list / update / archive / unarchive,
 * tags JSON round-trip, soft-delete behavior, workspace isolation,
 * validation errors.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import {
  archiveTopic,
  createTopic,
  getTopic,
  listTopics,
  TopicValidationError,
  unarchiveTopic,
  updateTopic,
} from './topics';

function freshWorkspace(): string {
  const id = `ws-tp-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

test('createTopic: round-trip with defaults', () => {
  const ws = freshWorkspace();
  const t = createTopic({ workspace_id: ws, name: 'GLP-1 regulation' });
  assert.equal(t.workspace_id, ws);
  assert.equal(t.name, 'GLP-1 regulation');
  assert.equal(t.description, '');
  assert.deepEqual(t.tags, []);
  assert.equal(t.default_brief_template, null);
  assert.equal(t.archived_at, null);
});

test('createTopic: trims name, preserves tags + description', () => {
  const ws = freshWorkspace();
  const t = createTopic({
    workspace_id: ws,
    name: '  Acme competitor watch  ',
    description: 'Track product + pricing changes',
    tags: ['competitor', 'saas'],
    default_brief_template: 'general_brief',
  });
  assert.equal(t.name, 'Acme competitor watch');
  assert.equal(t.description, 'Track product + pricing changes');
  assert.deepEqual(t.tags, ['competitor', 'saas']);
  assert.equal(t.default_brief_template, 'general_brief');
});

test('createTopic: rejects blank name', () => {
  const ws = freshWorkspace();
  assert.throws(() => createTopic({ workspace_id: ws, name: '   ' }), TopicValidationError);
});

test('createTopic: rejects blank workspace_id', () => {
  assert.throws(
    () => createTopic({ workspace_id: '   ', name: 'x' }),
    TopicValidationError,
  );
});

test('listTopics: workspace-scoped, archived excluded by default', () => {
  const wsA = freshWorkspace();
  const wsB = freshWorkspace();
  const t1 = createTopic({ workspace_id: wsA, name: 'A1' });
  createTopic({ workspace_id: wsA, name: 'A2' });
  createTopic({ workspace_id: wsB, name: 'B1' });

  archiveTopic(t1.id);

  const liveA = listTopics(wsA);
  assert.equal(liveA.length, 1);
  assert.equal(liveA[0].name, 'A2');

  const allA = listTopics(wsA, { includeArchived: true });
  assert.equal(allA.length, 2);

  const liveB = listTopics(wsB);
  assert.equal(liveB.length, 1);
  assert.equal(liveB[0].name, 'B1');
});

test('updateTopic: partial updates only touch provided fields', () => {
  const ws = freshWorkspace();
  const t = createTopic({
    workspace_id: ws,
    name: 'Original',
    description: 'orig desc',
    tags: ['a'],
  });
  const updated = updateTopic(t.id, { description: 'new desc' });
  assert.equal(updated?.name, 'Original');
  assert.equal(updated?.description, 'new desc');
  assert.deepEqual(updated?.tags, ['a']);
});

test('updateTopic: rejects blank name', () => {
  const ws = freshWorkspace();
  const t = createTopic({ workspace_id: ws, name: 'x' });
  assert.throws(() => updateTopic(t.id, { name: '   ' }), TopicValidationError);
});

test('updateTopic: returns null for unknown id', () => {
  assert.equal(updateTopic('does-not-exist', { name: 'x' }), null);
});

test('archive + unarchive: round-trip', () => {
  const ws = freshWorkspace();
  const t = createTopic({ workspace_id: ws, name: 'ToArchive' });
  const archived = archiveTopic(t.id);
  assert.ok(archived?.archived_at);
  // Idempotent: archiving twice doesn't reset the timestamp.
  const archivedAt = archived?.archived_at;
  const archivedAgain = archiveTopic(t.id);
  assert.equal(archivedAgain?.archived_at, archivedAt);

  const restored = unarchiveTopic(t.id);
  assert.equal(restored?.archived_at, null);
});

test('tags JSON round-trip survives non-string entries', () => {
  const ws = freshWorkspace();
  const t = createTopic({ workspace_id: ws, name: 'x', tags: ['ok', 'fine'] });
  // Manually corrupt the JSON to include a non-string entry.
  run(
    `UPDATE topics SET tags_json = ? WHERE id = ?`,
    [JSON.stringify(['ok', 42, null, 'fine']), t.id],
  );
  const reloaded = getTopic(t.id);
  assert.deepEqual(reloaded?.tags, ['ok', 'fine']);
});

test('FK cascade: deleting workspace removes its topics', () => {
  const ws = freshWorkspace();
  const t = createTopic({ workspace_id: ws, name: 'Orphan' });
  assert.ok(getTopic(t.id));
  run(`DELETE FROM workspaces WHERE id = ?`, [ws]);
  assert.equal(getTopic(t.id), null);
});
