/**
 * Pending-notes queue helper tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import {
  enqueuePendingNote,
  getPendingNote,
  listPendingNotes,
  markDispatched,
  markFailed,
} from './pm-pending-notes';

function freshWorkspace(): string {
  const id = `ws-pn-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

test('enqueue + get + list round-trip', () => {
  const ws = freshWorkspace();
  const note = enqueuePendingNote({
    workspace_id: ws,
    agent_id: 'agent-x',
    notes_text: 'Plan a refactor of the payments service',
    scope_hint: { include_tasks: true },
  });
  assert.equal(note.status, 'pending');
  assert.equal(note.attempts, 0);
  assert.deepEqual(note.scope_hint, { include_tasks: true });

  const fetched = getPendingNote(note.id);
  assert.ok(fetched);
  assert.equal(fetched!.notes_text, 'Plan a refactor of the payments service');

  const pending = listPendingNotes();
  assert.ok(pending.some(n => n.id === note.id));
});

test('markDispatched flips status and stamps proposal_id', () => {
  const ws = freshWorkspace();
  const note = enqueuePendingNote({
    workspace_id: ws,
    agent_id: 'a',
    notes_text: 'x',
  });
  markDispatched(note.id, 'prop-123');
  const after = getPendingNote(note.id)!;
  assert.equal(after.status, 'dispatched');
  assert.equal(after.proposal_id, 'prop-123');
  assert.ok(after.dispatched_at);
});

test('markFailed increments attempts and captures error', () => {
  const ws = freshWorkspace();
  const note = enqueuePendingNote({
    workspace_id: ws,
    agent_id: 'a',
    notes_text: 'x',
  });
  markFailed(note.id, 'gateway timeout');
  markFailed(note.id, 'still timing out');
  const after = getPendingNote(note.id)!;
  assert.equal(after.attempts, 2);
  assert.equal(after.error, 'still timing out');
  assert.equal(after.status, 'pending');
});

test('listPendingNotes respects maxAttempts cap', () => {
  const ws = freshWorkspace();
  const note = enqueuePendingNote({
    workspace_id: ws,
    agent_id: 'a',
    notes_text: 'x',
  });
  for (let i = 0; i < 5; i++) markFailed(note.id, 'err');
  const stillVisible = listPendingNotes({ maxAttempts: 5 }).some(n => n.id === note.id);
  assert.equal(stillVisible, false);
  const visibleHigherCap = listPendingNotes({ maxAttempts: 10 }).some(n => n.id === note.id);
  assert.equal(visibleHigherCap, true);
});
