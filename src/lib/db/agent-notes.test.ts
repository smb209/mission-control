/**
 * agent_notes spine — DB helper tests.
 *
 * Covers create/list/markConsumed/archive, validation rejection, kind
 * enforcement, body length cap, audience + kind filters,
 * not_consumed_by_stage filter, archived exclusion, importance ordering.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run, queryOne } from '@/lib/db';
import {
  AgentNoteValidationError,
  archiveNote,
  createNote,
  getNote,
  listNotes,
  markNoteConsumed,
  parseAttachedFiles,
  parseConsumedStages,
  NOTE_BODY_MAX,
} from './agent-notes';

function freshWorkspace(): string {
  const id = `ws-an-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

const baseInput = (workspaceId: string, overrides: Partial<Parameters<typeof createNote>[0]> = {}) => ({
  workspace_id: workspaceId,
  agent_id: null,
  scope_key: 'agent:mc-runner-dev:ws-x:task-y:builder:1',
  role: 'builder',
  run_group_id: 'rg-1',
  kind: 'discovery' as const,
  body: 'Found a dangling FK on agent_notes.agent_id',
  ...overrides,
});

test('createNote: round-trip with all fields', () => {
  const ws = freshWorkspace();
  const note = createNote(
    baseInput(ws, {
      task_id: null,
      initiative_id: null,
      audience: 'next-stage',
      attached_files: ['src/lib/db/agent-notes.ts', 'src/lib/db/migrations.ts'],
      importance: 2,
    }),
  );
  assert.equal(note.workspace_id, ws);
  assert.equal(note.kind, 'discovery');
  assert.equal(note.audience, 'next-stage');
  assert.equal(note.importance, 2);
  assert.equal(note.archived_at, null);
  assert.deepEqual(parseAttachedFiles(note), [
    'src/lib/db/agent-notes.ts',
    'src/lib/db/migrations.ts',
  ]);
  assert.deepEqual(parseConsumedStages(note), []);
  assert.ok(note.id);
  assert.ok(note.created_at);

  const fetched = getNote(note.id);
  assert.deepEqual(fetched, note);
});

test('createNote: rejects empty body', () => {
  const ws = freshWorkspace();
  assert.throws(
    () => createNote(baseInput(ws, { body: '' })),
    AgentNoteValidationError,
  );
});

test('createNote: rejects body over NOTE_BODY_MAX', () => {
  const ws = freshWorkspace();
  assert.throws(
    () => createNote(baseInput(ws, { body: 'a'.repeat(NOTE_BODY_MAX + 1) })),
    AgentNoteValidationError,
  );
});

test('createNote: rejects invalid kind', () => {
  const ws = freshWorkspace();
  assert.throws(
    () =>
      createNote(
        baseInput(ws, {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          kind: 'rumor' as any,
        }),
      ),
    AgentNoteValidationError,
  );
});

test('listNotes: filters by task_id', () => {
  const ws = freshWorkspace();
  const tA = `task-A-${uuidv4().slice(0, 6)}`;
  const tB = `task-B-${uuidv4().slice(0, 6)}`;
  // Bypass FK by inserting test task rows directly. (We don't depend on
  // tasks table semantics here — only that a non-NULL task_id round-trips.)
  for (const t of [tA, tB]) {
    run(
      `INSERT OR IGNORE INTO tasks (id, workspace_id, title, status, created_at, updated_at)
       VALUES (?, ?, ?, 'inbox', datetime('now'), datetime('now'))`,
      [t, ws, `seed task ${t}`],
    );
  }
  createNote(baseInput(ws, { task_id: tA, body: 'A1' }));
  createNote(baseInput(ws, { task_id: tA, body: 'A2' }));
  createNote(baseInput(ws, { task_id: tB, body: 'B1' }));

  const onlyA = listNotes({ task_id: tA });
  assert.equal(onlyA.length, 2);
  assert.ok(onlyA.every((n) => n.task_id === tA));

  const onlyB = listNotes({ task_id: tB });
  assert.equal(onlyB.length, 1);
  assert.equal(onlyB[0].body, 'B1');
});

test('listNotes: kinds filter', () => {
  const ws = freshWorkspace();
  createNote(baseInput(ws, { workspace_id: ws, body: 'd1', kind: 'discovery' }));
  createNote(baseInput(ws, { workspace_id: ws, body: 'b1', kind: 'blocker' }));
  createNote(baseInput(ws, { workspace_id: ws, body: 'q1', kind: 'question' }));

  const blockerOrDiscovery = listNotes({
    workspace_id: ws,
    kinds: ['blocker', 'discovery'],
  });
  assert.equal(blockerOrDiscovery.length, 2);
  assert.ok(blockerOrDiscovery.every((n) => n.kind === 'blocker' || n.kind === 'discovery'));
});

test('listNotes: audience filter accepts NULL or exact match', () => {
  const ws = freshWorkspace();
  createNote(baseInput(ws, { body: 'public', audience: null }));
  createNote(baseInput(ws, { body: 'for pm', audience: 'pm' }));
  createNote(baseInput(ws, { body: 'for tester', audience: 'tester' }));

  const pmView = listNotes({ workspace_id: ws, audience: 'pm' });
  // Includes the NULL-audience note (anyone) AND the pm-targeted one,
  // but NOT the tester-targeted one.
  const bodies = pmView.map((n) => n.body).sort();
  assert.deepEqual(bodies, ['for pm', 'public']);
});

test('listNotes: importance ordering — high importance first', () => {
  const ws = freshWorkspace();
  createNote(baseInput(ws, { body: 'low first', importance: 0 }));
  createNote(baseInput(ws, { body: 'high second', importance: 2 }));
  createNote(baseInput(ws, { body: 'mid third', importance: 1 }));

  const ordered = listNotes({ workspace_id: ws });
  // Importance DESC, then created_at ASC.
  assert.equal(ordered[0].importance, 2);
  assert.equal(ordered[1].importance, 1);
  assert.equal(ordered[2].importance, 0);
});

test('markNoteConsumed: appends stage slug idempotently', () => {
  const ws = freshWorkspace();
  const note = createNote(baseInput(ws));

  const after1 = markNoteConsumed(note.id, 'tester');
  assert.ok(after1);
  assert.deepEqual(parseConsumedStages(after1), ['tester']);

  // Second consumer.
  const after2 = markNoteConsumed(note.id, 'reviewer');
  assert.deepEqual(parseConsumedStages(after2!), ['tester', 'reviewer']);

  // Re-consume same stage — idempotent.
  const after3 = markNoteConsumed(note.id, 'tester');
  assert.deepEqual(parseConsumedStages(after3!), ['tester', 'reviewer']);
});

test('markNoteConsumed: returns null for missing note', () => {
  assert.equal(markNoteConsumed('nope', 'tester'), null);
});

test('listNotes: not_consumed_by_stage skips consumed notes', () => {
  const ws = freshWorkspace();
  const a = createNote(baseInput(ws, { body: 'unconsumed' }));
  const b = createNote(baseInput(ws, { body: 'consumed-by-tester' }));
  markNoteConsumed(b.id, 'tester');

  const fresh = listNotes({ workspace_id: ws, not_consumed_by_stage: 'tester' });
  const ids = fresh.map((n) => n.id).sort();
  assert.deepEqual(ids, [a.id].sort());
});

test('archiveNote: hides from default listing, keeps row', () => {
  const ws = freshWorkspace();
  const note = createNote(baseInput(ws, { body: 'stale observation' }));

  const archived = archiveNote(note.id, 'no longer relevant');
  assert.ok(archived);
  assert.ok(archived.archived_at);
  assert.equal(archived.archived_reason, 'no longer relevant');

  // Default listing excludes archived.
  const visible = listNotes({ workspace_id: ws });
  assert.equal(visible.length, 0);

  // include_archived: true brings them back.
  const all = listNotes({ workspace_id: ws, include_archived: true });
  assert.equal(all.length, 1);
  assert.equal(all[0].id, note.id);
});

test('archiveNote: idempotent', () => {
  const ws = freshWorkspace();
  const note = createNote(baseInput(ws));
  const first = archiveNote(note.id, 'reason 1');
  const second = archiveNote(note.id, 'reason 2');
  // First archive wins; second is a no-op.
  assert.equal(second?.archived_reason, first?.archived_reason);
});

test('archiveNote: returns null for missing note', () => {
  assert.equal(archiveNote('missing', 'irrelevant'), null);
});

test('listNotes: workspace deletion cascades agent_notes (FK)', () => {
  const ws = freshWorkspace();
  createNote(baseInput(ws, { body: 'will vanish' }));
  assert.equal(listNotes({ workspace_id: ws }).length, 1);

  run(`DELETE FROM workspaces WHERE id = ?`, [ws]);

  const after = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM agent_notes WHERE workspace_id = ?`,
    [ws],
  );
  assert.equal(after?.n, 0);
});
