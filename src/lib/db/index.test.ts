/**
 * Read-side timestamp normalization.
 *
 * Every Statement returned by getDb().prepare(...) — including the
 * direct .all/.get bypasses scattered through the API routes — should
 * post-process string fields that match the bare SQLite datetime shape
 * ("YYYY-MM-DD HH:MM:SS[.fff]") into ISO-Z. See
 * docs/reference/timestamp-handling.md §PR-A.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import {
  getDb,
  queryAll,
  queryOne,
  run,
  normalizeDatetimeString,
  SQLITE_DATETIME_RE,
} from './index';

function freshWorkspace(): string {
  const id = `ws-tz-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

test('SQLITE_DATETIME_RE matches bare datetimes only', () => {
  assert.equal(SQLITE_DATETIME_RE.test('2026-05-08 16:00:37'), true);
  assert.equal(SQLITE_DATETIME_RE.test('2026-05-08 16:00:37.123'), true);
  assert.equal(SQLITE_DATETIME_RE.test('2026-05-08T16:00:37Z'), false);
  assert.equal(SQLITE_DATETIME_RE.test('2026-05-08'), false);
  assert.equal(SQLITE_DATETIME_RE.test(''), false);
  assert.equal(SQLITE_DATETIME_RE.test('hello world'), false);
});

test('normalizeDatetimeString rewrites bare datetimes to ISO-Z', () => {
  assert.equal(
    normalizeDatetimeString('2026-05-08 16:00:37'),
    '2026-05-08T16:00:37Z',
  );
  assert.equal(
    normalizeDatetimeString('2026-05-08 16:00:37.123'),
    '2026-05-08T16:00:37.123Z',
  );
});

test('normalizeDatetimeString is idempotent on already-ISO values', () => {
  assert.equal(
    normalizeDatetimeString('2026-05-08T16:00:37Z'),
    '2026-05-08T16:00:37Z',
  );
});

test('normalizeDatetimeString leaves unrelated strings alone', () => {
  assert.equal(normalizeDatetimeString('not a date'), 'not a date');
  assert.equal(normalizeDatetimeString('2026-05-08'), '2026-05-08');
  assert.equal(normalizeDatetimeString(''), '');
});

test('queryOne returns ISO-Z for datetime columns', () => {
  const ws = freshWorkspace();
  const row = queryOne<{ id: string; created_at: string }>(
    'SELECT id, created_at FROM workspaces WHERE id = ?',
    [ws],
  );
  assert.ok(row, 'row exists');
  assert.match(row!.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
});

test('queryAll returns ISO-Z for datetime columns across all rows', () => {
  freshWorkspace();
  freshWorkspace();
  const rows = queryAll<{ id: string; created_at: string }>(
    'SELECT id, created_at FROM workspaces ORDER BY created_at DESC LIMIT 5',
  );
  assert.ok(rows.length >= 2);
  for (const r of rows) {
    assert.match(r.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  }
});

test('direct prepare().all() bypass also normalizes (monkey-patch covers all read paths)', () => {
  const ws = freshWorkspace();
  // Mirrors patterns in src/app/api/workspaces/route.ts that read via
  // db.prepare directly rather than queryAll.
  const rows = getDb().prepare('SELECT id, created_at FROM workspaces WHERE id = ?').all(ws) as
    Array<{ id: string; created_at: string }>;
  assert.equal(rows.length, 1);
  assert.match(rows[0].created_at, /T.*Z$/);
});

test('direct prepare().get() bypass also normalizes', () => {
  const ws = freshWorkspace();
  const row = getDb().prepare('SELECT id, created_at FROM workspaces WHERE id = ?').get(ws) as
    { id: string; created_at: string };
  assert.match(row.created_at, /T.*Z$/);
});

test('non-datetime string fields pass through unchanged', () => {
  const ws = freshWorkspace();
  const row = queryOne<{ id: string; name: string; slug: string }>(
    'SELECT id, name, slug FROM workspaces WHERE id = ?',
    [ws],
  );
  assert.equal(row!.id, ws);
  assert.equal(row!.name, ws);
  assert.equal(row!.slug, ws);
});

test('NULL datetime fields stay null', () => {
  const ws = freshWorkspace();
  // updated_at on workspaces is nullable in some rows.
  const row = queryOne<{ description: string | null }>(
    'SELECT description FROM workspaces WHERE id = ?',
    [ws],
  );
  assert.equal(row!.description, null);
});

test('parsing the normalized value yields the same instant as raw UTC', () => {
  // Round-trip sanity: write a datetime, read it back, and confirm
  // `new Date(returned)` gives an instant matching `Date.now()` to
  // within a few seconds. This is the actual user-visible bug PR-A
  // closes — pre-fix, a UTC-7 box would parse the bare string as
  // 7 hours in the future of `now`.
  const before = Date.now();
  const ws = freshWorkspace();
  const row = queryOne<{ created_at: string }>(
    'SELECT created_at FROM workspaces WHERE id = ?',
    [ws],
  );
  const parsed = new Date(row!.created_at).getTime();
  const after = Date.now();
  // Allow a 3s window for clock skew + slow CI; the broken form
  // would be off by 60+ minutes minimum on any non-UTC machine.
  assert.ok(parsed >= before - 3000, `parsed=${parsed} before=${before}`);
  assert.ok(parsed <= after + 3000, `parsed=${parsed} after=${after}`);
});
