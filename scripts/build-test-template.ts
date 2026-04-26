/**
 * Build the shared test-template SQLite database.
 *
 * Runs once per `npm test` invocation, BEFORE we spawn any test workers.
 * Each test process then copies this file (a fast filesystem operation)
 * instead of replaying the full ~50-migration chain on every test file.
 *
 * Why a separate process: the migration runner has heavy import-time side
 * effects (autopilot recovery, agent catalog scheduling) when NODE_ENV is
 * not 'test'. We rely on `NODE_ENV=test` already being set when this runs
 * (see the npm script), which short-circuits those side effects in
 * `getDb()` — but we use an isolated `Database` handle here so we don't
 * pollute the test-process module cache with a singleton pointing at the
 * template path.
 *
 * If you change schema.ts or add migrations, this template is rebuilt
 * automatically because `npm test` deletes it before rebuilding.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { schema } from '../src/lib/db/schema';
import { runMigrations } from '../src/lib/db/migrations';

function main(): void {
  const t0 = Date.now();

  const tmpDir = path.join(process.cwd(), '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'test-dbs'), { recursive: true });

  const templatePath =
    process.env.TEST_TEMPLATE_DB || path.join(tmpDir, 'test-template.db');

  // Always rebuild from scratch so the template reflects current schema +
  // migrations. The npm script already removes the file, but be defensive.
  for (const suffix of ['', '-shm', '-wal']) {
    const p = templatePath + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  const db = new Database(templatePath);
  // Match the runtime PRAGMAs so the template's schema-time state mirrors
  // what each test process would produce on its own.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(schema);
  runMigrations(db);

  // Checkpoint WAL so the resulting .db file is fully self-contained — no
  // lingering -wal frames the test processes would need to replay. After
  // checkpoint we close the handle cleanly so file copies see consistent
  // bytes.
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();

  // Remove sidecars left behind by WAL mode; we want a single .db file the
  // test workers can copy atomically.
  for (const suffix of ['-shm', '-wal']) {
    const p = templatePath + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  const ms = Date.now() - t0;
  console.log(`[test-template] built ${templatePath} in ${ms}ms`);
}

main();
