/**
 * Migration 095 (`pm_convoy_mandate_convoys_acceptance_criteria`).
 *
 * Schema-only check: after the shared test DB applies all migrations on
 * boot, the `convoys` table must expose an `acceptance_criteria` column.
 * Populated by the create_convoy_under_initiative apply-pass (slice 2);
 * read at parent review→done by the AC gate (slice 5). See
 * docs/reference/pm-convoy-mandate.md.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '@/lib/db';

test('migration 095: convoys.acceptance_criteria column exists', () => {
  const db = getDb();
  const cols = db.prepare(`PRAGMA table_info(convoys)`).all() as Array<{ name: string; type: string }>;
  const col = cols.find((c) => c.name === 'acceptance_criteria');
  assert.ok(col, 'expected convoys.acceptance_criteria column to exist after migrations run');
  assert.equal(col!.type.toUpperCase(), 'TEXT', 'acceptance_criteria should be TEXT (JSON-encoded string[])');
});

test('migration 095: acceptance_criteria is nullable (NULL = back-compat coordinator-spawned convoy)', () => {
  const db = getDb();
  const cols = db.prepare(`PRAGMA table_info(convoys)`).all() as Array<{ name: string; notnull: number }>;
  const col = cols.find((c) => c.name === 'acceptance_criteria');
  assert.ok(col);
  assert.equal(col!.notnull, 0, 'acceptance_criteria must remain nullable for back-compat');
});

test('migration 095: re-running ALTER would fail — migration must be idempotent', () => {
  // Sanity-check our idempotency guard: if we tried to ALTER again, sqlite
  // would error with "duplicate column name". The migration's PRAGMA check
  // skips that path; here we simulate the second-run case directly.
  const db = getDb();
  const cols = db.prepare(`PRAGMA table_info(convoys)`).all() as Array<{ name: string }>;
  const hasCol = cols.some((c) => c.name === 'acceptance_criteria');
  assert.equal(hasCol, true);
  if (hasCol) {
    assert.throws(
      () => db.exec(`ALTER TABLE convoys ADD COLUMN acceptance_criteria TEXT`),
      /duplicate column name/i,
      'second ALTER should fail; migration 095 guards against this with PRAGMA check',
    );
  }
});
