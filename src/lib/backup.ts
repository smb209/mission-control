/**
 * Database Backup Service
 *
 * Single source of truth for SQLite backups: on-demand via the admin API,
 * scheduled via instrumentation.ts, manual via `yarn db:backup`. All
 * three paths land in the same directory with the same filename
 * convention so the operator never has to wonder which system wrote a
 * particular file.
 *
 * Filename: mc-backup-{ISO-timestamp}-v{migration-version}.db
 * Timestamps use dashes instead of colons (filesystem-safe + sortable).
 * Migration version is the highest applied id at backup time so a
 * restore-across-schema-changes is recognizable from the filename alone.
 *
 * Path: {dirname(DATABASE_PATH)}/backups/. In docker that resolves to
 * /app/data/backups, which is bind-mounted to the host — backups are
 * always visible from the host filesystem. (Earlier the path defaulted
 * to process.cwd()/backups which lived inside the container only.)
 *
 * Atomicity: createBackup() uses better-sqlite3's online .backup() API
 * (page-by-page copy, doesn't block readers/writers, internally
 * consistent regardless of WAL state). We `wal_checkpoint(TRUNCATE)`
 * first so the resulting file is self-contained (no -shm/-wal sidecars).
 *
 * Retention: enforceRetention(N) keeps the newest N matching files.
 * Recognizes both the canonical mc-backup-* pattern AND the legacy
 * mission-control-* pattern from PR #96 so transitional rolling files
 * roll off cleanly instead of accumulating forever.
 *
 * Safety: restoreBackup() always creates a pre-restore-* safety backup
 * before overwriting the live DB.
 */

import fs from 'fs';
import path from 'path';
import { getDb, closeDb } from '@/lib/db';
import { getMigrationStatus } from '@/lib/db/migrations';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackupMetadata {
  filename: string;
  filepath: string;
  size: number;
  timestamp: string;        // ISO-8601 original timestamp
  migrationVersion: string; // e.g. "021"
  location: 'local' | 's3' | 'both';
  createdAt: string;        // ISO-8601 file creation time
}

export interface BackupResult {
  backup: BackupMetadata;
  s3Uploaded: boolean;
  s3Error?: string;
}

export interface RestoreResult {
  restored: string;
  safetyBackup: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getDbPath(): string {
  return process.env.DATABASE_PATH || path.join(process.cwd(), 'mission-control.db');
}

function getBackupDir(): string {
  // Co-locate with the DB so docker bind mounts pick the directory up
  // automatically. Override via MC_BACKUP_DIR for testing or unusual
  // deployments. Earlier this defaulted to process.cwd()/backups which
  // lived inside the container only — admin-API backups vanished from
  // the host's POV.
  if (process.env.MC_BACKUP_DIR) return process.env.MC_BACKUP_DIR;
  return path.join(path.dirname(path.resolve(getDbPath())), 'backups');
}

function ensureBackupDir(): string {
  const dir = getBackupDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Backup filename parsing
// ---------------------------------------------------------------------------

// Canonical filename: mc-backup-{ISO-ts}-v{migration-version}.db
const BACKUP_PATTERN = /^mc-backup-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-v(\d+)\.db$/;
// Legacy filename from PR #96 — recognized so rolling files written
// before the consolidation roll off via retention instead of leaking.
const LEGACY_PATTERN = /^mission-control-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})Z\.db$/;
// Pre-restore safety backups, written by restoreBackup().
const PRE_RESTORE_PATTERN = /^pre-restore-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.db$/;

function parseBackupFilename(filename: string): { timestamp: string; version: string } | null {
  const m = filename.match(BACKUP_PATTERN);
  if (m) {
    // Convert dashes back to colons for valid ISO timestamp.
    const timestamp = m[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
    return { timestamp, version: m[2] };
  }
  const legacy = filename.match(LEGACY_PATTERN);
  if (legacy) {
    const timestamp = legacy[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3') + 'Z';
    return { timestamp, version: 'legacy' };
  }
  return null;
}

/** True for any filename that the retention pass should consider. */
function isManagedBackup(filename: string): boolean {
  return BACKUP_PATTERN.test(filename) || LEGACY_PATTERN.test(filename);
}

function formatTimestamp(date: Date): string {
  return date.toISOString()
    .replace(/:/g, '-')
    .replace(/\..+$/, '');
}

// ---------------------------------------------------------------------------
// Core: createBackup
// ---------------------------------------------------------------------------

export async function createBackup(): Promise<BackupResult> {
  const db = getDb();
  const backupDir = ensureBackupDir();

  // 1. Checkpoint WAL so the snapshot is self-contained (no -shm/-wal
  //    sidecars). Best-effort — a failed checkpoint doesn't make the
  //    backup unsafe; .backup() still produces a consistent snapshot.
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }

  // 2. Determine current migration version for the filename suffix.
  const { applied } = getMigrationStatus(db);
  const currentVersion = applied.length > 0 ? applied[applied.length - 1] : '000';

  // 3. Build filename.
  const timestamp = formatTimestamp(new Date());
  const filename = `mc-backup-${timestamp}-v${currentVersion}.db`;
  const filepath = path.join(backupDir, filename);

  // 4. Atomic online backup. Earlier this used `fs.copyFileSync(dbPath,
  //    filepath)` which races with WAL writers and can corrupt the
  //    snapshot. better-sqlite3's .backup() does a page-by-page copy
  //    that doesn't block readers/writers and produces an internally
  //    consistent file regardless of WAL state.
  await db.backup(filepath);

  // 5. Stat the backup
  const stat = fs.statSync(filepath);
  const parsed = parseBackupFilename(filename);

  const metadata: BackupMetadata = {
    filename,
    filepath,
    size: stat.size,
    timestamp: parsed?.timestamp || new Date().toISOString(),
    migrationVersion: currentVersion,
    location: 'local',
    createdAt: stat.birthtime.toISOString(),
  };

  // 6. Optional S3 upload
  let s3Uploaded = false;
  let s3Error: string | undefined;

  if (isS3Configured()) {
    try {
      await uploadToS3(filepath, filename);
      metadata.location = 'both';
      s3Uploaded = true;
    } catch (err) {
      s3Error = err instanceof Error ? err.message : String(err);
      console.warn('[Backup] S3 upload failed (local backup still created):', s3Error);
    }
  }

  console.log(`[Backup] Created: ${filename} (${formatBytes(stat.size)})`);

  return { backup: metadata, s3Uploaded, s3Error };
}

// ---------------------------------------------------------------------------
// Core: listBackups
// ---------------------------------------------------------------------------

export async function listBackups(): Promise<BackupMetadata[]> {
  const backupDir = getBackupDir();

  if (!fs.existsSync(backupDir)) {
    return [];
  }

  const files = fs.readdirSync(backupDir);
  const backups: BackupMetadata[] = [];

  for (const filename of files) {
    const parsed = parseBackupFilename(filename);
    // Also include pre-restore safety backups
    const isPreRestore = filename.startsWith('pre-restore-') && filename.endsWith('.db');

    if (!parsed && !isPreRestore) continue;

    const filepath = path.join(backupDir, filename);

    try {
      const stat = fs.statSync(filepath);
      backups.push({
        filename,
        filepath,
        size: stat.size,
        timestamp: parsed?.timestamp || stat.birthtime.toISOString(),
        migrationVersion: parsed?.version || 'unknown',
        location: 'local', // S3 status checked separately if needed
        createdAt: stat.birthtime.toISOString(),
      });
    } catch {
      // Skip files we can't stat
      continue;
    }
  }

  // Sort newest first
  backups.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return backups;
}

// ---------------------------------------------------------------------------
// Core: restoreBackup
// ---------------------------------------------------------------------------

export async function restoreBackup(filename: string): Promise<RestoreResult> {
  const backupDir = getBackupDir();
  const backupPath = path.join(backupDir, filename);

  // Validate the backup file exists
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${filename}`);
  }

  // Validate filename doesn't contain path traversal
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('Invalid backup filename');
  }

  const dbPath = getDbPath();

  // 1. Create safety backup of current database BEFORE restoring
  const safetyTimestamp = formatTimestamp(new Date());
  const safetyFilename = `pre-restore-${safetyTimestamp}.db`;
  const safetyPath = path.join(backupDir, safetyFilename);

  // Close the database first so we get a clean copy
  closeDb();

  try {
    // Copy current DB as safety backup
    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, safetyPath);
      console.log(`[Backup] Safety backup created: ${safetyFilename}`);
    }

    // 2. Restore: overwrite current DB with backup
    fs.copyFileSync(backupPath, dbPath);

    // 3. Remove WAL/SHM files if they exist (stale after restore)
    const walPath = dbPath + '-wal';
    const shmPath = dbPath + '-shm';
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);

    console.log(`[Backup] Restored from: ${filename}`);
  } catch (err) {
    // If restore fails, try to re-open the DB (which may use the safety backup)
    console.error('[Backup] Restore failed:', err);
    throw err;
  }

  // Next getDb() call will reinitialize the connection to the restored database

  return {
    restored: filename,
    safetyBackup: safetyFilename,
  };
}

// ---------------------------------------------------------------------------
// Core: deleteBackup
// ---------------------------------------------------------------------------

export async function deleteBackup(filename: string): Promise<void> {
  // Validate filename doesn't contain path traversal
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('Invalid backup filename');
  }

  const backupDir = getBackupDir();
  const filepath = path.join(backupDir, filename);

  if (!fs.existsSync(filepath)) {
    throw new Error(`Backup file not found: ${filename}`);
  }

  fs.unlinkSync(filepath);
  console.log(`[Backup] Deleted: ${filename}`);

  // Optionally delete from S3
  if (isS3Configured()) {
    try {
      await deleteFromS3(filename);
    } catch (err) {
      console.warn('[Backup] S3 delete failed (local deleted):', err);
    }
  }
}

// ---------------------------------------------------------------------------
// S3 integration (optional)
// ---------------------------------------------------------------------------

function getS3Config() {
  return {
    endpoint: process.env.S3_ENDPOINT,
    bucket: process.env.S3_BUCKET,
    accessKey: process.env.S3_ACCESS_KEY,
    secretKey: process.env.S3_SECRET_KEY,
    region: process.env.S3_REGION || 'us-east-1',
  };
}

export function isS3Configured(): boolean {
  const config = getS3Config();
  return !!(config.endpoint && config.bucket && config.accessKey && config.secretKey);
}

export function getS3Status(): { configured: boolean; endpoint?: string; bucket?: string } {
  const config = getS3Config();
  return {
    configured: isS3Configured(),
    endpoint: config.endpoint,
    bucket: config.bucket,
  };
}

async function getS3Client() {
  // Dynamic import to avoid requiring @aws-sdk/client-s3 when not configured
  try {
    const { S3Client } = await import('@aws-sdk/client-s3');
    const config = getS3Config();

    return new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKey!,
        secretAccessKey: config.secretKey!,
      },
      forcePathStyle: true, // Required for MinIO, Backblaze, etc.
    });
  } catch {
    throw new Error('@aws-sdk/client-s3 is not installed. Run: npm install @aws-sdk/client-s3');
  }
}

export async function uploadToS3(filepath: string, key: string): Promise<void> {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await getS3Client();
  const config = getS3Config();

  const fileBuffer = fs.readFileSync(filepath);

  await client.send(new PutObjectCommand({
    Bucket: config.bucket!,
    Key: `mission-control-backups/${key}`,
    Body: fileBuffer,
    ContentType: 'application/x-sqlite3',
  }));

  console.log(`[Backup] Uploaded to S3: ${key}`);
}

async function deleteFromS3(key: string): Promise<void> {
  const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await getS3Client();
  const config = getS3Config();

  await client.send(new DeleteObjectCommand({
    Bucket: config.bucket!,
    Key: `mission-control-backups/${key}`,
  }));

  console.log(`[Backup] Deleted from S3: ${key}`);
}

export async function listS3Backups(): Promise<BackupMetadata[]> {
  if (!isS3Configured()) return [];

  try {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const client = await getS3Client();
    const config = getS3Config();

    const response = await client.send(new ListObjectsV2Command({
      Bucket: config.bucket!,
      Prefix: 'mission-control-backups/',
    }));

    if (!response.Contents) return [];

    return response.Contents
      .filter(obj => obj.Key && obj.Key.endsWith('.db'))
      .map(obj => {
        const filename = obj.Key!.replace('mission-control-backups/', '');
        const parsed = parseBackupFilename(filename);
        return {
          filename,
          filepath: `s3://${config.bucket}/mission-control-backups/${filename}`,
          size: obj.Size || 0,
          timestamp: parsed?.timestamp || (obj.LastModified?.toISOString() ?? new Date().toISOString()),
          migrationVersion: parsed?.version || 'unknown',
          location: 's3' as const,
          createdAt: obj.LastModified?.toISOString() ?? new Date().toISOString(),
        };
      });
  } catch (err) {
    console.warn('[Backup] Failed to list S3 backups:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Retention + scheduling (rolling daily backups)
// ---------------------------------------------------------------------------

export interface RetentionResult {
  kept: string[];
  deleted: string[];
}

export interface ScheduledBackupResult extends RetentionResult {
  backup: BackupMetadata;
}

interface BackupConfig {
  enabled: boolean;
  backupDir: string;
  intervalHours: number;
  retain: number;
}

/**
 * Resolve env-driven schedule + retention config. Pure function — no
 * side effects. Defaults: 24h interval, retain newest 14, dir co-located
 * with the DB. Disable the schedule via MC_BACKUP_DISABLED=1 (or by
 * setting MC_BACKUP_INTERVAL_HOURS to a non-positive number).
 */
export function resolveBackupConfig(
  env: Record<string, string | undefined> = process.env,
): BackupConfig {
  const intervalHours = Number(env.MC_BACKUP_INTERVAL_HOURS ?? 24);
  return {
    enabled: env.MC_BACKUP_DISABLED !== '1' && intervalHours > 0,
    backupDir: env.MC_BACKUP_DIR ?? path.join(
      path.dirname(path.resolve(env.DATABASE_PATH ?? './mission-control.db')),
      'backups',
    ),
    intervalHours,
    retain: Number(env.MC_BACKUP_RETAIN ?? 14),
  };
}

/**
 * Keep the newest `retain` managed backups in `backupDir`; delete the
 * rest. Recognizes both the canonical mc-backup-* filename and the
 * legacy mission-control-* filename so transitional rolling files roll
 * off cleanly. Pre-restore safety backups and operator-managed copies
 * are left untouched.
 */
export async function enforceRetention(
  backupDir: string,
  retain: number,
): Promise<RetentionResult> {
  if (!fs.existsSync(backupDir)) return { kept: [], deleted: [] };

  // Sort newest-first by *parsed* timestamp, not raw filename — lex
  // sort puts legacy `mission-control-…` ahead of canonical
  // `mc-backup-…` (`i` > `c`) which would prune the wrong rows.
  const all = fs
    .readdirSync(backupDir)
    .filter(isManagedBackup)
    .sort((a, b) => {
      const ta = parseBackupFilename(a)?.timestamp ?? '';
      const tb = parseBackupFilename(b)?.timestamp ?? '';
      // Descending — newest first.
      return tb.localeCompare(ta);
    });
  const cap = Math.max(0, retain);
  const kept = all.slice(0, cap);
  const toDelete = all.slice(cap);
  for (const name of toDelete) {
    try { fs.unlinkSync(path.join(backupDir, name)); } catch { /* ignore */ }
  }
  return { kept, deleted: toDelete };
}

/**
 * One-shot backup + retention pass. Used by both the scheduled cron
 * and the `yarn db:backup` CLI so manual + scheduled runs produce
 * identical artifacts and respect retention.
 */
export async function runScheduledBackup(retain?: number): Promise<ScheduledBackupResult> {
  const cfg = resolveBackupConfig();
  const result = await createBackup();
  const retention = await enforceRetention(cfg.backupDir, retain ?? cfg.retain);
  return { backup: result.backup, ...retention };
}

/**
 * Register the periodic backup tick. Idempotent (safe across HMR /
 * multi-import). No-ops in tests and when MC_BACKUP_DISABLED=1.
 *
 * First backup runs ~30s after boot — lets migrations + any startup
 * writes settle so the first snapshot reflects a steady state. Then
 * every intervalHours.
 */
export function registerBackupSchedule(getLiveDb: () => Database.Database): void {
  if (process.env.NODE_ENV === 'test') return;
  const cfg = resolveBackupConfig();
  if (!cfg.enabled) {
    console.log('[Backup] disabled (MC_BACKUP_DISABLED or interval ≤ 0)');
    return;
  }

  const g = globalThis as unknown as {
    __mcBackupTimer?: NodeJS.Timeout;
    __mcBackupBoot?: NodeJS.Timeout;
  };
  if (g.__mcBackupTimer) return;

  // Touch the live DB once during init to make sure migrations etc.
  // are evaluated before the first backup runs. We don't keep the
  // reference; createBackup() pulls a fresh handle via getDb().
  try { getLiveDb(); } catch { /* swallow — backup tick will surface it */ }

  const tick = async (reason: 'boot' | 'scheduled') => {
    try {
      const result = await runScheduledBackup(cfg.retain);
      console.log(
        `[Backup] ${reason}: wrote ${result.backup.filename} ` +
          `(${formatBytes(result.backup.size)}); kept=${result.kept.length}, pruned=${result.deleted.length}`,
      );
    } catch (err) {
      console.warn(`[Backup] ${reason} failed:`, (err as Error).message);
    }
  };

  g.__mcBackupBoot = setTimeout(() => { void tick('boot'); }, 30_000);
  g.__mcBackupTimer = setInterval(
    () => { void tick('scheduled'); },
    cfg.intervalHours * 60 * 60 * 1000,
  );

  console.log(
    `[Backup] scheduled: dir=${cfg.backupDir}, every ${cfg.intervalHours}h, retain=${cfg.retain}`,
  );
}
