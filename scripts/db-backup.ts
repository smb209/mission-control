#!/usr/bin/env -S tsx
/**
 * db-backup.ts — CLI wrapper around src/lib/backup.ts.
 *
 * Replaces the original `sqlite3 ... PRAGMA wal_checkpoint && cp` shell
 * line with a thin wrapper over the same `createBackup` / `listBackups`
 * / retention helpers the admin UI and scheduled cron use. One system,
 * one filename convention (`mc-backup-{ts}-v{migration}.db`), one
 * directory (defaults to `${dirname(DATABASE_PATH)}/backups/`).
 *
 * Usage:
 *   yarn db:backup                  # one-off backup, retention applied
 *   yarn db:backup -- --list        # list existing backups (newest first)
 *   yarn db:backup -- --retain=N    # override retention for this run
 *
 * Env vars (overridden by flags):
 *   DATABASE_PATH        source DB
 *   MC_BACKUP_DIR        destination dir (default `<dbdir>/backups`)
 *   MC_BACKUP_RETAIN     keep newest N (default 14)
 */

import path from 'node:path';
import process from 'node:process';
import {
  createBackup,
  enforceRetention,
  listBackups,
  resolveBackupConfig,
  formatBytes,
} from '../src/lib/backup.js';

interface Args {
  list?: boolean;
  retain?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (const a of argv.slice(2)) {
    if (a === '--list') args.list = true;
    else if (a.startsWith('--retain=')) args.retain = Number(a.split('=', 2)[1]);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: yarn tsx scripts/db-backup.ts [--list] [--retain=N]');
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

  if (args.list) {
    const all = await listBackups();
    if (all.length === 0) {
      console.log(`No backups found in ${cfg.backupDir}`);
      return;
    }
    console.log(`Backups in ${cfg.backupDir} (newest first):`);
    for (const b of all) {
      console.log(`  ${b.filename}  ${formatBytes(b.size).padStart(8)}  v${b.migrationVersion}`);
    }
    return;
  }

  const result = await createBackup();
  console.log(
    `Wrote ${result.backup.filename} (${formatBytes(result.backup.size)}, v${result.backup.migrationVersion})`,
  );
  const retention = await enforceRetention(cfg.backupDir, args.retain ?? cfg.retain);
  if (retention.deleted.length > 0) {
    console.log(`Pruned ${retention.deleted.length} old backup(s):`);
    for (const name of retention.deleted) console.log(`  - ${name}`);
  }
  console.log(`Retention: ${retention.kept.length}/${args.retain ?? cfg.retain} (path: ${path.resolve(cfg.backupDir)})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
