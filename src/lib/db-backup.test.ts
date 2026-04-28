import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import {
  backupDatabase,
  enforceRetention,
  listBackups,
  resolveBackupConfig,
  runScheduledBackup,
} from './db-backup';

let workdir: string;
let dbPath: string;
let backupDir: string;
let db: Database.Database;

before(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-backup-test-'));
  dbPath = path.join(workdir, 'src.db');
  backupDir = path.join(workdir, 'backups');
  db = new Database(dbPath);
  // Some real content so the backup file isn't trivially empty.
  db.exec(`CREATE TABLE foo (id INTEGER PRIMARY KEY, body TEXT);`);
  const insert = db.prepare(`INSERT INTO foo (body) VALUES (?)`);
  for (let i = 0; i < 100; i++) insert.run(`row ${i}`);
});

after(async () => {
  db.close();
  await fs.rm(workdir, { recursive: true, force: true });
});

describe('backupDatabase', () => {
  it('writes a SQLite file with the expected filename pattern', async () => {
    const result = await backupDatabase(db, { dbPath, backupDir });
    assert.match(
      path.basename(result.backupPath),
      /^mission-control-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.db$/,
    );
    assert.ok(result.bytes > 0, 'backup file should not be empty');

    // Verify the snapshot is a usable SQLite DB with the source data.
    const restored = new Database(result.backupPath, { readonly: true });
    try {
      const count = (restored.prepare('SELECT count(*) as n FROM foo').get() as { n: number }).n;
      assert.equal(count, 100);
    } finally {
      restored.close();
    }
  });
});

describe('enforceRetention', () => {
  let retentionDir: string;

  before(async () => {
    retentionDir = await fs.mkdtemp(path.join(workdir, 'retain-'));
    // Seed 5 backup-shaped files with distinct timestamps so newest-first
    // ordering is deterministic.
    const stamps = [
      '2026-04-20T10-00-00Z',
      '2026-04-21T10-00-00Z',
      '2026-04-22T10-00-00Z',
      '2026-04-23T10-00-00Z',
      '2026-04-24T10-00-00Z',
    ];
    for (const s of stamps) {
      await fs.writeFile(path.join(retentionDir, `mission-control-${s}.db`), 'x');
    }
    // Plus a non-matching operator file that should never be touched.
    await fs.writeFile(path.join(retentionDir, 'manual-snapshot.db'), 'y');
  });

  it('keeps the newest N and deletes the rest', async () => {
    const result = await enforceRetention({ backupDir: retentionDir, retain: 3 });
    assert.equal(result.kept.length, 3);
    assert.equal(result.deleted.length, 2);
    // Newest preserved first.
    assert.deepEqual(result.kept, [
      'mission-control-2026-04-24T10-00-00Z.db',
      'mission-control-2026-04-23T10-00-00Z.db',
      'mission-control-2026-04-22T10-00-00Z.db',
    ]);
    // Oldest pruned.
    assert.deepEqual(result.deleted.sort(), [
      'mission-control-2026-04-20T10-00-00Z.db',
      'mission-control-2026-04-21T10-00-00Z.db',
    ]);
    // Non-matching operator file untouched.
    const remaining = await fs.readdir(retentionDir);
    assert.ok(remaining.includes('manual-snapshot.db'));
  });

  it('does nothing when there are fewer files than the retention cap', async () => {
    const result = await enforceRetention({ backupDir: retentionDir, retain: 10 });
    assert.equal(result.deleted.length, 0);
  });

  it('lists the backup files newest-first', async () => {
    const all = await listBackups(retentionDir);
    assert.deepEqual(all[0], 'mission-control-2026-04-24T10-00-00Z.db');
    assert.equal(all.includes('manual-snapshot.db'), false);
  });

  it('listBackups returns [] when the dir does not exist', async () => {
    const all = await listBackups(path.join(workdir, 'does-not-exist'));
    assert.deepEqual(all, []);
  });
});

describe('runScheduledBackup', () => {
  it('writes a backup AND enforces retention in one call', async () => {
    const dir = await fs.mkdtemp(path.join(workdir, 'sched-'));
    // Pre-seed so we know retention pruned something.
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(
        path.join(dir, `mission-control-2026-04-1${i}T10-00-00Z.db`),
        'x',
      );
    }
    const result = await runScheduledBackup(db, {
      dbPath,
      backupDir: dir,
      retain: 2,
    });
    // 1 fresh backup + retention picked the newest 2 of the 4 (3 seeded + 1 fresh).
    assert.equal(result.kept.length, 2);
    // Newest is the freshly-written file.
    assert.equal(result.kept[0], path.basename(result.backupPath));
  });
});

describe('resolveBackupConfig', () => {
  it('uses defaults grounded in DATABASE_PATH', () => {
    const cfg = resolveBackupConfig({ DATABASE_PATH: '/data/mission-control.db' });
    assert.equal(cfg.dbPath, '/data/mission-control.db');
    assert.equal(cfg.backupDir, '/data/backups');
    assert.equal(cfg.intervalHours, 24);
    assert.equal(cfg.retain, 14);
    assert.equal(cfg.enabled, true);
  });

  it('honors MC_BACKUP_DIR override', () => {
    const cfg = resolveBackupConfig({
      DATABASE_PATH: '/data/mission-control.db',
      MC_BACKUP_DIR: '/elsewhere/snaps',
    });
    assert.equal(cfg.backupDir, '/elsewhere/snaps');
  });

  it('disables when MC_BACKUP_DISABLED=1', () => {
    const cfg = resolveBackupConfig({
      DATABASE_PATH: '/data/x.db',
      MC_BACKUP_DISABLED: '1',
    });
    assert.equal(cfg.enabled, false);
  });

  it('disables when interval is non-positive', () => {
    const cfg = resolveBackupConfig({
      DATABASE_PATH: '/data/x.db',
      MC_BACKUP_INTERVAL_HOURS: '0',
    });
    assert.equal(cfg.enabled, false);
  });
});
