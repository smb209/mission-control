/**
 * Owner availability DB-helper tests (Phase 4).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import {
  createOwnerAvailability,
  deleteOwnerAvailability,
  getOwnerAvailability,
  listOwnerAvailability,
} from './owner-availability';

function seedAgent(workspace: string = 'default'): string {
  const id = uuidv4();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, created_at, updated_at)
     VALUES (?, 'A', 'worker', ?, datetime('now'), datetime('now'))`,
    [id, workspace],
  );
  return id;
}

test('createOwnerAvailability inserts a row with the given fields', () => {
  const a = seedAgent();
  const row = createOwnerAvailability({
    agent_id: a,
    unavailable_start: '2026-05-01',
    unavailable_end: '2026-05-05',
    reason: 'PTO',
  });
  assert.equal(row.agent_id, a);
  assert.equal(row.unavailable_start, '2026-05-01');
  assert.equal(row.unavailable_end, '2026-05-05');
  assert.equal(row.reason, 'PTO');
});

test('createOwnerAvailability rejects unknown agent', () => {
  assert.throws(
    () =>
      createOwnerAvailability({
        agent_id: 'nope',
        unavailable_start: '2026-05-01',
        unavailable_end: '2026-05-05',
      }),
    /Agent not found/,
  );
});

test('createOwnerAvailability rejects end < start', () => {
  const a = seedAgent();
  assert.throws(
    () =>
      createOwnerAvailability({
        agent_id: a,
        unavailable_start: '2026-05-10',
        unavailable_end: '2026-05-05',
      }),
    /unavailable_end must be/,
  );
});

test('listOwnerAvailability filters by agent', () => {
  const a = seedAgent();
  const b = seedAgent();
  createOwnerAvailability({ agent_id: a, unavailable_start: '2026-05-01', unavailable_end: '2026-05-05' });
  createOwnerAvailability({ agent_id: b, unavailable_start: '2026-05-01', unavailable_end: '2026-05-05' });
  const rows = listOwnerAvailability({ agent_id: a });
  assert.ok(rows.length >= 1);
  assert.ok(rows.every(r => r.agent_id === a));
});

test('listOwnerAvailability between filter does an overlap query', () => {
  const a = seedAgent();
  // Window 1: well before query range.
  const before = createOwnerAvailability({ agent_id: a, unavailable_start: '2026-01-01', unavailable_end: '2026-01-10' });
  // Window 2: overlaps the query range on the left edge.
  const overlapL = createOwnerAvailability({ agent_id: a, unavailable_start: '2026-04-25', unavailable_end: '2026-05-02' });
  // Window 3: fully within.
  const inside = createOwnerAvailability({ agent_id: a, unavailable_start: '2026-05-10', unavailable_end: '2026-05-15' });
  // Window 4: well after.
  const after = createOwnerAvailability({ agent_id: a, unavailable_start: '2026-08-01', unavailable_end: '2026-08-05' });

  const rows = listOwnerAvailability({
    agent_id: a,
    between_start: '2026-05-01',
    between_end: '2026-05-31',
  });
  const ids = rows.map(r => r.id);
  assert.ok(ids.includes(overlapL.id), 'overlapL window should be included');
  assert.ok(ids.includes(inside.id), 'inside window should be included');
  assert.ok(!ids.includes(before.id), 'before window should NOT be included');
  assert.ok(!ids.includes(after.id), 'after window should NOT be included');
});

test('deleteOwnerAvailability removes the row', () => {
  const a = seedAgent();
  const row = createOwnerAvailability({ agent_id: a, unavailable_start: '2026-05-01', unavailable_end: '2026-05-05' });
  deleteOwnerAvailability(row.id);
  assert.equal(getOwnerAvailability(row.id), undefined);
});

test('deleteOwnerAvailability throws for unknown id', () => {
  assert.throws(() => deleteOwnerAvailability('does-not-exist'), /not found/);
});
