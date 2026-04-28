/**
 * DB checkpoint helper for the preview-based test flow.
 *
 *   yarn db:checkpoint <name>          — save a snapshot of the live DB
 *   yarn db:checkpoint:restore <name>  — restore a snapshot to the live DB
 *   yarn db:checkpoint:list            — show available snapshots
 *
 * Snapshots live under `.tmp/checkpoints/<name>.db`. We force a WAL
 * checkpoint on the source so the snapshot is self-contained; on
 * restore we delete -shm/-wal sidecars that belong to the previous
 * runtime so SQLite doesn't see a stale write-ahead log.
 *
 * The dev server should be stopped while restoring — running it would
 * either crash on the missing WAL or quietly corrupt the new file.
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync, rmSync, statSync } from 'fs';
import { join, basename } from 'path';
import Database from 'better-sqlite3';

const ROOT = process.cwd();
const LIVE_DB = join(ROOT, 'mission-control.db');
const CHECKPOINT_DIR = join(ROOT, '.tmp', 'checkpoints');

function usage(): never {
  console.error('Usage: tsx scripts/db-checkpoint.ts <save|restore|list> [name]');
  process.exit(1);
}

function ensureCheckpointDir(): void {
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
}

function checkpointPath(name: string): string {
  return join(CHECKPOINT_DIR, `${name}.db`);
}

function save(name: string): void {
  if (!existsSync(LIVE_DB)) {
    console.error(`No live DB at ${LIVE_DB}.`);
    process.exit(1);
  }
  ensureCheckpointDir();
  // Force a WAL checkpoint so the saved file is self-contained — no
  // stale -wal/-shm needed.
  const db = new Database(LIVE_DB);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  const dest = checkpointPath(name);
  copyFileSync(LIVE_DB, dest);
  const size = statSync(dest).size;
  console.log(`✅ saved ${dest} (${(size / 1024).toFixed(1)} KB)`);
}

function restore(name: string): void {
  const src = checkpointPath(name);
  if (!existsSync(src)) {
    console.error(`No checkpoint at ${src}.`);
    process.exit(1);
  }
  // Drop sidecars that belong to a previous runtime — leaving them
  // around makes SQLite think the new file is mid-transaction.
  for (const suffix of ['-wal', '-shm']) {
    const p = LIVE_DB + suffix;
    if (existsSync(p)) rmSync(p);
  }
  copyFileSync(src, LIVE_DB);
  console.log(`✅ restored ${LIVE_DB} from ${src}`);
  console.log('   (restart the dev server before using the UI)');
}

function list(): void {
  if (!existsSync(CHECKPOINT_DIR)) {
    console.log('(no checkpoints yet — run `yarn db:checkpoint <name>`)');
    return;
  }
  const rows = readdirSync(CHECKPOINT_DIR)
    .filter(f => f.endsWith('.db'))
    .map(f => {
      const p = join(CHECKPOINT_DIR, f);
      const s = statSync(p);
      return { name: basename(f, '.db'), size_kb: (s.size / 1024).toFixed(1), mtime: s.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
  if (rows.length === 0) {
    console.log('(no checkpoints yet — run `yarn db:checkpoint <name>`)');
    return;
  }
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(30)} ${r.size_kb.padStart(8)} KB  ${r.mtime}`);
  }
}

const cmd = process.argv[2];
const name = process.argv[3];

if (cmd === 'list') list();
else if (cmd === 'save') {
  if (!name) usage();
  save(name);
} else if (cmd === 'restore') {
  if (!name) usage();
  restore(name);
} else {
  usage();
}
