import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { schema } from './schema';
import { runMigrations } from './migrations';
import { ensureCatalogSyncScheduled } from '@/lib/agent-catalog-sync';

/**
 * Resolve the database path for the current process.
 *
 * Production: honor `DATABASE_PATH` (or default to `mission-control.db` next to
 * the cwd). One file, one process, no surprises.
 *
 * Tests: each `tsx --test` worker process gets its OWN sqlite file under
 * `.tmp/test-dbs/` so concurrent test files don't trip over a shared writer
 * lock (`SQLITE_BUSY` / `database is locked`). The unique key is the process
 * pid plus a random suffix — pid alone would clash if Node recycled a pid
 * across `xargs` invocations on a fast machine.
 *
 * The test DB itself is bootstrapped from a pre-built template (created once
 * per `npm test` invocation by `scripts/build-test-template.ts`). Copying a
 * file is dramatically faster than replaying ~50 migrations on every test
 * file. If the template doesn't exist (e.g. someone ran a test file directly
 * without the wrapper script), we fall back to running migrations from
 * scratch — still correct, just slower.
 */
function resolveDbPath(): string {
  if (process.env.NODE_ENV === 'test') {
    const dir = process.env.TEST_DB_DIR || path.join(process.cwd(), '.tmp', 'test-dbs');
    fs.mkdirSync(dir, { recursive: true });
    const unique = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    return path.join(dir, `mc-test-${unique}.db`);
  }
  return process.env.DATABASE_PATH || path.join(process.cwd(), 'mission-control.db');
}

const DB_PATH = resolveDbPath();

let db: Database.Database | null = null;

/**
 * If a migrated test template exists, copy it to the per-process DB path.
 * Returns true if the copy happened (and migrations can be skipped), false
 * otherwise.
 */
function tryHydrateFromTestTemplate(targetPath: string): boolean {
  if (process.env.NODE_ENV !== 'test') return false;
  const template =
    process.env.TEST_TEMPLATE_DB ||
    path.join(process.cwd(), '.tmp', 'test-template.db');
  if (!fs.existsSync(template)) return false;
  // copyFileSync is atomic enough for our purposes: each test process writes
  // to a UNIQUE target path, so there's no contention.
  fs.copyFileSync(template, targetPath);
  return true;
}

export function getDb(): Database.Database {
  if (!db) {
    const isTest = process.env.NODE_ENV === 'test';
    const hydratedFromTemplate = tryHydrateFromTestTemplate(DB_PATH);
    const isNewDb = !fs.existsSync(DB_PATH);

    const instance = new Database(DB_PATH);
    instance.pragma('journal_mode = WAL');
    instance.pragma('foreign_keys = ON');

    // Seed the full schema only for brand-new databases. Running schema.exec
    // against an existing DB is redundant (everything is CREATE ... IF NOT
    // EXISTS) and can actively *block* migrations: if schema.ts adds an index
    // or constraint referencing a column that a pending migration will add,
    // SQLite throws mid-exec — and because `db` would already be assigned,
    // the half-initialized handle gets cached and migrations never run. For
    // existing DBs, migrations are the sole source of schema truth.
    //
    // Hydrated-from-template DBs have already had schema + migrations applied
    // by the template builder, so we skip both steps here.
    if (!hydratedFromTemplate && isNewDb) {
      instance.exec(schema);
    }

    if (!hydratedFromTemplate) {
      // Run migrations for schema updates (handles both new and existing DBs).
      runMigrations(instance);
    }

    // Only publish the singleton after init fully succeeds. If anything above
    // throws, `db` stays null and the next call retries cleanly instead of
    // returning a poisoned handle.
    db = instance;

    if (!isTest) {
      // Recover orphaned autopilot cycles from prior crash/restart
      import('@/lib/autopilot/recovery').then(({ recoverOrphanedCycles }) =>
        recoverOrphanedCycles().catch(err => console.warn('[Recovery] Failed:', err))
      );

      // Keep Mission Control's agent catalog synced with OpenClaw-installed agents
      ensureCatalogSyncScheduled();

      if (isNewDb) {
        console.log('[DB] New database created at:', DB_PATH);
      }
    }
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Type-safe query helpers
export function queryAll<T>(sql: string, params: unknown[] = []): T[] {
  const stmt = getDb().prepare(sql);
  return stmt.all(...params) as T[];
}

export function queryOne<T>(sql: string, params: unknown[] = []): T | undefined {
  const stmt = getDb().prepare(sql);
  return stmt.get(...params) as T | undefined;
}

export function run(sql: string, params: unknown[] = []): Database.RunResult {
  const stmt = getDb().prepare(sql);
  return stmt.run(...params);
}

export function transaction<T>(fn: () => T): T {
  const db = getDb();
  return db.transaction(fn)();
}

// Export migration utilities for CLI use
export { runMigrations, getMigrationStatus } from './migrations';
