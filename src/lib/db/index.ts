import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { schema } from './schema';
import { runMigrations } from './migrations';
import { ensureCatalogSyncScheduled } from '@/lib/agent-catalog-sync';

const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), 'mission-control.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
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
    if (isNewDb) {
      instance.exec(schema);
    }

    // Run migrations for schema updates (handles both new and existing DBs).
    runMigrations(instance);

    // Only publish the singleton after init fully succeeds. If anything above
    // throws, `db` stays null and the next call retries cleanly instead of
    // returning a poisoned handle.
    db = instance;

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
