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
  // Defense: if a Node test runner is loading this module without
  // NODE_ENV=test, we'd otherwise silently open the production DB and
  // every `freshWorkspace()` test fixture would leak rows into it.
  // The recurring_jobs test fixtures are particularly bad — leaked
  // rows get picked up by the production scheduler and fire on
  // cadence forever. Hard-fail here so the operator notices and runs
  // the suite via `yarn test` (or prefixes ad-hoc invocations with
  // `NODE_ENV=test`).
  if (process.env.NODE_TEST_CONTEXT) {
    throw new Error(
      'Refusing to open production DB from a Node test runner. Set ' +
      'NODE_ENV=test (e.g. `NODE_ENV=test npx tsx --test ...`) or use ' +
      '`yarn test`.',
    );
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

    // Wrap `prepare` so every Statement.all/get returned anywhere in
    // the codebase normalizes bare SQLite datetime strings to ISO-Z
    // before they reach JS. See docs/reference/timestamp-handling.md §PR-A.
    // This catches the queryAll/queryOne helpers AND the many sites
    // that call `db.prepare(sql).all/get(...)` directly.
    installDatetimeNormalization(instance);

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

// ── Timestamp normalization on read ─────────────────────────────────
//
// SQLite's `datetime('now')` returns "YYYY-MM-DD HH:MM:SS" — UTC by
// sqlite convention but with no timezone marker. Browsers parse such
// strings as *local* time, producing dates that drift by the local
// UTC offset. Rather than fix every read site, we monkey-patch
// `db.prepare` once at init so every Statement returned anywhere in
// the codebase normalizes string fields shaped like bare SQLite
// datetimes to ISO-Z ("YYYY-MM-DDTHH:MM:SSZ") before they reach JS.
// See docs/reference/timestamp-handling.md §PR-A.
//
// We rewrite only string fields that match the bare-SQLite-datetime
// shape. Subseconds are preserved; already-Z values are untouched
// (idempotent); unrelated strings, numbers, nulls, and `pluck()`
// scalar returns all pass through unchanged.
export const SQLITE_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

export function normalizeDatetimeString(v: string): string {
  return SQLITE_DATETIME_RE.test(v) ? `${v.replace(' ', 'T')}Z` : v;
}

// Format a Date as a bare-SQLite UTC datetime string ("YYYY-MM-DD HH:MM:SS")
// for use as a bound parameter against `created_at` / `updated_at` columns.
// SQLite's CURRENT_TIMESTAMP writes this exact shape, and SQLite compares
// datetime columns as text — so an ISO-Z parameter with `T` at byte 11 will
// always sort after a same-second stored value with a space, silently
// excluding rows that should match `>=`.
export function toSqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function normalizeRow<T>(row: T): T {
  if (!row || typeof row !== 'object') return row;
  // Mutate in place — the row is a fresh object per query, never shared.
  const r = row as Record<string, unknown>;
  for (const k in r) {
    const v = r[k];
    if (typeof v === 'string') {
      const nv = normalizeDatetimeString(v);
      if (nv !== v) r[k] = nv;
    }
  }
  return row;
}

function installDatetimeNormalization(instance: Database.Database): void {
  // Each statement holds its own .all / .get methods. We wrap them
  // lazily the first time the statement is used — this dodges the
  // edge case where better-sqlite3's bound functions check `this`.
  const origPrepare = instance.prepare.bind(instance);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (instance as any).prepare = function patchedPrepare(
    this: Database.Database,
    sql: string,
  ): Database.Statement {
    const stmt = origPrepare(sql);
    const origAll = stmt.all.bind(stmt);
    const origGet = stmt.get.bind(stmt);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stmt.all = ((...params: unknown[]) => {
      const rows = origAll(...(params as [])) as unknown;
      if (!Array.isArray(rows)) return rows as unknown;
      for (const row of rows) normalizeRow(row);
      return rows;
    }) as typeof stmt.all;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stmt.get = ((...params: unknown[]) => {
      const row = origGet(...(params as [])) as unknown;
      return row === undefined ? undefined : normalizeRow(row);
    }) as typeof stmt.get;
    return stmt;
  } as typeof instance.prepare;
}

// Type-safe query helpers. Normalization happens inside
// `installDatetimeNormalization`'s prepare wrapper, so these helpers
// stay thin.
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
