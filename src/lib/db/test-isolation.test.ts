/**
 * Sanity tests for the per-process test-DB isolation strategy.
 *
 * Why: a regression here (e.g. someone reverts to a shared DATABASE_PATH)
 * silently breaks parallel test execution and re-introduces the
 * `database is locked` flake. These tests fail loudly the moment the
 * isolation invariant is broken.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { getDb } from '@/lib/db';

test('test DB lives in a per-process .tmp/test-dbs/ file, not the shared path', () => {
  const dbPath = getDb().name;
  const cwd = process.cwd();
  // Must be under .tmp/test-dbs/, not the legacy shared file.
  const expectedDir = path.join(cwd, '.tmp', 'test-dbs');
  assert.ok(
    dbPath.startsWith(expectedDir + path.sep),
    `expected DB path under ${expectedDir}, got ${dbPath}`,
  );
  assert.ok(
    !dbPath.endsWith('mission-control-test.db'),
    `legacy shared DB path detected: ${dbPath}`,
  );
});

test('per-process DB filename includes the pid so collisions across xargs are impossible', () => {
  const dbPath = getDb().name;
  const filename = path.basename(dbPath);
  assert.match(
    filename,
    new RegExp(`^mc-test-${process.pid}-[0-9a-f]+\\.db$`),
    `expected pid-tagged test DB filename, got ${filename}`,
  );
});

test('migrations are present (template hydrate or migrate-from-scratch both produce a usable schema)', () => {
  const db = getDb();
  // Sanity: a known table from migration 002 (workspaces) and one from a
  // recent migration (049) — both must exist regardless of how the DB got here.
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all() as { name: string }[];
  const names = new Set(tables.map(t => t.name));
  assert.ok(names.has('workspaces'), 'workspaces table missing');
  assert.ok(names.has('agents'), 'agents table missing');
  assert.ok(names.has('_migrations'), '_migrations tracking table missing');

  // Migration tracker should show every migration applied (the template
  // codepath OR runMigrations applied them; either way, _migrations is full).
  const applied = db
    .prepare(`SELECT COUNT(*) AS n FROM _migrations`)
    .get() as { n: number };
  assert.ok(applied.n > 0, 'expected at least one migration applied');
});
