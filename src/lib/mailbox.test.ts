/**
 * Tests for formatMailForDispatch roll_call collapsing + cap behavior.
 *
 * Regression: a "favorite color" test task was getting 10 queued
 * `roll_call:...` blocks concatenated into its dispatch prompt because
 * the old formatter inlined every unread row and only marked them read
 * (never deleted). Roll-calls are single-use — the durable record lives
 * in `rollcall_entries` — so this module now deletes them on read and
 * only renders the newest.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { formatMailForDispatch, getUnreadMail } from './mailbox';

function seedAgent(name: string): string {
  const id = uuidv4();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_active, created_at, updated_at)
     VALUES (?, ?, 'builder', 'default', 1, datetime('now'), datetime('now'))`,
    [id, name],
  );
  return id;
}

function insertMail(opts: {
  toAgentId: string;
  fromAgentId: string;
  subject: string | null;
  body: string;
  createdAt?: string;
}): string {
  const id = uuidv4();
  run(
    `INSERT INTO agent_mailbox (id, from_agent_id, to_agent_id, subject, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, opts.fromAgentId, opts.toAgentId, opts.subject, opts.body, opts.createdAt ?? new Date().toISOString()],
  );
  return id;
}

test('formatMailForDispatch collapses multiple roll_call messages and deletes them', () => {
  const to = seedAgent('recipient-rc');
  const from = seedAgent('sender-rc');

  // Seed 4 roll_call messages — oldest first.
  const oldIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    oldIds.push(insertMail({
      toAgentId: to,
      fromAgentId: from,
      subject: `roll_call:${uuidv4()}`,
      body: `ROLL CALL — please check in (#${i})`,
      createdAt: new Date(Date.now() - (10 - i) * 1000).toISOString(),
    }));
  }
  const newestId = insertMail({
    toAgentId: to,
    fromAgentId: from,
    subject: `roll_call:${uuidv4()}`,
    body: 'ROLL CALL — newest',
    createdAt: new Date().toISOString(),
  });

  const section = formatMailForDispatch(to);
  assert.ok(section, 'section should be rendered');
  assert.match(section!, /ROLL CALL — newest/);
  assert.match(section!, /3 older roll_call request\(s\) collapsed/);
  // Older roll_call bodies must not appear verbatim.
  assert.doesNotMatch(section!, /please check in \(#0\)/);

  // Every roll_call row should be deleted (not just marked read) so a
  // second dispatch can't re-surface them.
  for (const id of [...oldIds, newestId]) {
    const row = queryOne('SELECT id FROM agent_mailbox WHERE id = ?', [id]);
    assert.equal(row, undefined, `roll_call mail ${id} should have been deleted`);
  }
  assert.equal(getUnreadMail(to).length, 0);
});

test('formatMailForDispatch caps non-roll_call mail at 5 and defers overflow', () => {
  const to = seedAgent('recipient-cap');
  const from = seedAgent('sender-cap');

  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    ids.push(insertMail({
      toAgentId: to,
      fromAgentId: from,
      subject: `subj-${i}`,
      body: `body-${i}`,
      createdAt: new Date(Date.now() + i * 1000).toISOString(),
    }));
  }

  const section = formatMailForDispatch(to);
  assert.ok(section);
  assert.match(section!, /3 older message\(s\) omitted/);
  // Newest 5 (indices 3..7) should be present, oldest 3 (0..2) should not.
  for (let i = 3; i < 8; i++) assert.match(section!, new RegExp(`body-${i}`));
  for (let i = 0; i < 3; i++) assert.doesNotMatch(section!, new RegExp(`body-${i}`));

  // Overflow stays unread for the next dispatch; rendered rows are read.
  const remaining = queryAll<{ id: string; read_at: string | null }>(
    'SELECT id, read_at FROM agent_mailbox WHERE to_agent_id = ? ORDER BY created_at ASC',
    [to],
  );
  assert.equal(remaining.length, 8, 'non-roll_call rows are not deleted');
  const unread = remaining.filter(r => r.read_at === null);
  assert.equal(unread.length, 3, 'oldest 3 remain unread');
});

test('formatMailForDispatch returns null when nothing is unread', () => {
  const to = seedAgent('empty');
  assert.equal(formatMailForDispatch(to), null);
});
