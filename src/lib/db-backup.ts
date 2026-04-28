/**
 * db-backup — atomic SQLite backups with rolling retention.
 *
 * Backups use better-sqlite3's online `.backup()` API: a page-by-page
 * copy that doesn't block readers/writers and produces an internally
 * consistent snapshot regardless of WAL state. We checkpoint the WAL
 * first so the snapshot reflects everything that's been committed.
 *
 * Filenames are `mission-control-YYYY-MM-DDTHH-mm-ssZ.db` so they sort
 * chronologically and a `ls -1` enumerates the rotation order. Retention
 * keeps the newest N (default 14); older ones are deleted after each
 * successful backup.
 *
 * Used by:
 *   - the scheduled job registered in `instrumentation.ts` (once on boot
 *     after a 30s grace, then every MC_BACKUP_INTERVAL_HOURS hours)
 *   - the `yarn db:backup` CLI in `scripts/db-backup.ts`
 *
 * Env knobs (all optional):
 *   MC_BACKUP_DIR             default `${dirname(DATABASE_PATH)}/backups`
 *   MC_BACKUP_INTERVAL_HOURS  default 24
 *   MC_BACKUP_RETAIN          default 14
 *   MC_BACKUP_DISABLED=1      off switch (CI / tests)
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

const FILENAME_PREFIX = 'mission-control-';
const FILENAME_SUFFIX = '.db';
const FILENAME_RE =
  /^mission-control-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.db$/;

export interface BackupOptions {
  dbPath: string;
  backupDir: string;
  /** Defaults to current time. Override only for testing determinism. */
  now?: Date;
}

export interface RetentionOptions {
  backupDir: string;
  retain: number;
}

export interface BackupResult {
  backupPath: string;
  bytes: number;
  durationMs: number;
}

export interface RetentionResult {
  kept: string[];
  deleted: string[];
}

function timestampForFilename(d: Date): string {
  // ISO8601 minus the dots/colons that break case-insensitive filesystems
  // and `ls` parsing.  e.g. 2026-04-28T23-15-04Z
  return d.toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Run an online backup against a target file, then return its path +
 * byte count + duration. Caller is responsible for ensuring the source
 * DB is the live one (it is, when invoked via getDb()).
 *
 * Checkpoints WAL first so the resulting snapshot doesn't depend on a
 * separate `mission-control.db-wal` file.
 */
export async function backupDatabase(
  db: Database.Database,
  opts: BackupOptions,
): Promise<BackupResult> {
  await fs.mkdir(opts.backupDir, { recursive: true });

  // Force WAL contents to the main DB file so the backup is self-
  // contained. TRUNCATE shrinks the WAL after checkpointing — keeps
  // disk pressure low during the rotation window.
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // Best-effort. A failed checkpoint doesn't make the backup unsafe;
    // the .backup() API still produces a consistent snapshot.
  }

  const ts = timestampForFilename(opts.now ?? new Date());
  const backupPath = path.join(
    opts.backupDir,
    `${FILENAME_PREFIX}${ts}${FILENAME_SUFFIX}`,
  );

  const start = Date.now();
  // better-sqlite3's .backup() returns a Promise<{totalPages, ...}>.
  await db.backup(backupPath);
  const durationMs = Date.now() - start;

  const stat = await fs.stat(backupPath);
  return { backupPath, bytes: stat.size, durationMs };
}

/**
 * List backup files in `backupDir`, newest first, sorted by filename
 * (which encodes timestamp). Files not matching the expected pattern
 * are ignored — operator-managed copies in the same dir don't get
 * caught up in retention.
 */
export async function listBackups(backupDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(backupDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((name) => FILENAME_RE.test(name))
    .sort()
    .reverse();
}

/**
 * Keep the newest `retain` matching files in `backupDir`; delete the
 * rest. Files that don't match the backup-filename pattern are left
 * untouched (operator copies, archives, etc.).
 */
export async function enforceRetention(
  opts: RetentionOptions,
): Promise<RetentionResult> {
  const all = await listBackups(opts.backupDir);
  const kept = all.slice(0, Math.max(0, opts.retain));
  const toDelete = all.slice(Math.max(0, opts.retain));

  for (const name of toDelete) {
    await fs.unlink(path.join(opts.backupDir, name));
  }

  return { kept, deleted: toDelete };
}

/**
 * Resolve effective config from env vars, with sensible defaults
 * grounded in DATABASE_PATH. Pure function — no side effects.
 */
export function resolveBackupConfig(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  dbPath: string;
  backupDir: string;
  intervalHours: number;
  retain: number;
} {
  const dbPath = env.DATABASE_PATH ?? './mission-control.db';
  const backupDir =
    env.MC_BACKUP_DIR ?? path.join(path.dirname(path.resolve(dbPath)), 'backups');
  const intervalHours = Number(env.MC_BACKUP_INTERVAL_HOURS ?? 24);
  const retain = Number(env.MC_BACKUP_RETAIN ?? 14);
  const enabled = env.MC_BACKUP_DISABLED !== '1' && intervalHours > 0;
  return { enabled, dbPath, backupDir, intervalHours, retain };
}

/**
 * One-shot backup + retention pass. Used by both the scheduler and the
 * CLI. Returns a small structured result for logging.
 */
export async function runScheduledBackup(
  db: Database.Database,
  opts: BackupOptions & { retain: number },
): Promise<BackupResult & RetentionResult> {
  const backup = await backupDatabase(db, opts);
  const retention = await enforceRetention({
    backupDir: opts.backupDir,
    retain: opts.retain,
  });
  return { ...backup, ...retention };
}

/**
 * Register the periodic backup tick. Idempotent (safe to call twice in
 * dev's HMR / multi-import context). No-ops in tests and when
 * MC_BACKUP_DISABLED is set.
 */
export function registerBackupSchedule(getLiveDb: () => Database.Database): void {
  if (process.env.NODE_ENV === 'test') return;
  const cfg = resolveBackupConfig();
  if (!cfg.enabled) {
    console.log('[Backup] disabled (MC_BACKUP_DISABLED or interval ≤ 0)');
    return;
  }

  const g = globalThis as unknown as { __mcBackupTimer?: NodeJS.Timeout; __mcBackupBoot?: NodeJS.Timeout };
  if (g.__mcBackupTimer) return;

  const tick = async (reason: 'boot' | 'scheduled') => {
    try {
      const result = await runScheduledBackup(getLiveDb(), {
        dbPath: cfg.dbPath,
        backupDir: cfg.backupDir,
        retain: cfg.retain,
      });
      console.log(
        `[Backup] ${reason}: wrote ${path.basename(result.backupPath)} ` +
          `(${(result.bytes / 1024 / 1024).toFixed(2)} MB, ${result.durationMs}ms); ` +
          `kept=${result.kept.length}, pruned=${result.deleted.length}`,
      );
    } catch (err) {
      console.warn(`[Backup] ${reason} failed:`, (err as Error).message);
    }
  };

  // First backup ~30s after boot — lets migrations + any startup writes
  // settle so the first snapshot reflects a steady state, not a partial
  // one. Then every intervalHours.
  g.__mcBootTimer = undefined;
  g.__mcBackupBoot = setTimeout(() => {
    void tick('boot');
  }, 30_000);

  g.__mcBackupTimer = setInterval(
    () => {
      void tick('scheduled');
    },
    cfg.intervalHours * 60 * 60 * 1000,
  );

  console.log(
    `[Backup] scheduled: dir=${cfg.backupDir}, every ${cfg.intervalHours}h, retain=${cfg.retain}`,
  );
}
