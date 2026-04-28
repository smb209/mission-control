#!/usr/bin/env -S tsx
/**
 * db-backup.ts — CLI wrapper around src/lib/db-backup.ts.
 *
 * Replaces the older `sqlite3 mission-control.db PRAGMA wal_checkpoint
 * && cp` shell line with the proper online-backup API + rolling
 * retention. Same lib that powers the scheduled backup, so a manual
 * run produces an identically-shaped artifact and respects retention.
 *
 * Usage:
 *   yarn db:backup                    # one-off backup, retention applied
 *   yarn db:backup -- --list          # list existing backups (newest first)
 *   yarn db:backup -- --retain=N      # override retention for this run
 *   yarn db:backup -- --db=PATH       # override DATABASE_PATH for this run
 *   yarn db:backup -- --dir=PATH      # override backup dir for this run
 *
 * Env vars (overridden by flags above):
 *   DATABASE_PATH              source DB
 *   MC_BACKUP_DIR              destination dir (default `<dbdir>/backups`)
 *   MC_BACKUP_RETAIN           keep newest N (default 14)
 */

import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import {
  backupDatabase,
  enforceRetention,
  listBackups,
  resolveBackupConfig,
} from '../src/lib/db-backup.js';

interface Args {
  list?: boolean;
  dbPath?: string;
  backupDir?: string;
  retain?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (const a of argv.slice(2)) {
    if (a === '--list') args.list = true;
    else if (a.startsWith('--db=')) args.dbPath = a.split('=', 2)[1];
    else if (a.startsWith('--dir=')) args.backupDir = a.split('=', 2)[1];
    else if (a.startsWith('--retain=')) args.retain = Number(a.split('=', 2)[1]);
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: yarn tsx scripts/db-backup.ts [--list] [--db=PATH] [--dir=PATH] [--retain=N]',
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = resolveBackupConfig();

  const dbPath = path.resolve(args.dbPath ?? cfg.dbPath);
  const backupDir = path.resolve(args.backupDir ?? cfg.backupDir);
  const retain = args.retain ?? cfg.retain;

  if (args.list) {
    const all = await listBackups(backupDir);
    if (all.length === 0) {
      console.log(`No backups found in ${backupDir}`);
      return;
    }
    console.log(`Backups in ${backupDir} (newest first):`);
    for (const name of all) console.log(`  ${name}`);
    return;
  }

  // Open read/write so .backup() can use the WAL checkpoint pragma.
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    const result = await backupDatabase(db, { dbPath, backupDir });
    console.log(
      `Wrote ${path.basename(result.backupPath)} ` +
        `(${(result.bytes / 1024 / 1024).toFixed(2)} MB, ${result.durationMs}ms)`,
    );
    const retention = await enforceRetention({ backupDir, retain });
    if (retention.deleted.length > 0) {
      console.log(`Pruned ${retention.deleted.length} old backup(s):`);
      for (const name of retention.deleted) console.log(`  - ${name}`);
    }
    console.log(`Retention: ${retention.kept.length}/${retain}`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
