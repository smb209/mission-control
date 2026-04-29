import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, default as fsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  enforceRetention,
  resolveBackupConfig,
  formatBytes,
} from './backup';

let workdir: string;

before(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-backup-test-'));
});

after(async () => {
  await fs.rm(workdir, { recursive: true, force: true });
});

describe('resolveBackupConfig', () => {
  it('co-locates the backup dir with DATABASE_PATH by default', () => {
    const cfg = resolveBackupConfig({ DATABASE_PATH: '/data/mission-control.db' });
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

describe('enforceRetention', () => {
  let dir: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(workdir, 'retain-'));
    // Mix canonical (mc-backup-…-v###.db) and legacy (mission-control-…Z.db)
    // filenames so the test verifies BOTH are recognized for retention.
    // Plus one operator-managed file that should never be touched.
    const canonical = [
      'mc-backup-2026-04-22T10-00-00-v055.db',
      'mc-backup-2026-04-23T10-00-00-v056.db',
      'mc-backup-2026-04-24T10-00-00-v057.db',
    ];
    const legacy = [
      'mission-control-2026-04-20T10-00-00Z.db',
      'mission-control-2026-04-21T10-00-00Z.db',
    ];
    for (const n of [...canonical, ...legacy]) {
      await fs.writeFile(path.join(dir, n), 'x');
    }
    await fs.writeFile(path.join(dir, 'manual-snapshot.db'), 'y');
    await fs.writeFile(path.join(dir, 'pre-restore-2026-04-20T09-00-00.db'), 'z');
  });

  it('keeps newest N across BOTH canonical and legacy patterns; operator + pre-restore files untouched', async () => {
    const result = await enforceRetention(dir, 3);
    // Sorted descending lex (timestamp-driven) → canonical files win
    // because they're newer in this fixture.
    assert.deepEqual(result.kept, [
      'mc-backup-2026-04-24T10-00-00-v057.db',
      'mc-backup-2026-04-23T10-00-00-v056.db',
      'mc-backup-2026-04-22T10-00-00-v055.db',
    ]);
    // Both legacy files dropped.
    assert.deepEqual(result.deleted.sort(), [
      'mission-control-2026-04-20T10-00-00Z.db',
      'mission-control-2026-04-21T10-00-00Z.db',
    ]);
    // Sentinel files survive (not matched by either pattern).
    const remaining = await fs.readdir(dir);
    assert.ok(remaining.includes('manual-snapshot.db'));
    assert.ok(remaining.includes('pre-restore-2026-04-20T09-00-00.db'));
  });

  it('does nothing when there are fewer files than the retention cap', async () => {
    const result = await enforceRetention(dir, 100);
    assert.equal(result.deleted.length, 0);
  });

  it('returns empty when the dir does not exist', async () => {
    const result = await enforceRetention(path.join(workdir, 'does-not-exist'), 5);
    assert.deepEqual(result.kept, []);
    assert.deepEqual(result.deleted, []);
  });
});

describe('formatBytes', () => {
  it('formats bytes with sensible units', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(5_000_000), '4.8 MB');
  });
});

// Note: createBackup / runScheduledBackup / registerBackupSchedule are
// covered by the higher-level integration tests (admin-API + scheduled
// cron in dev preview). They require a real getDb()/migrations/etc.
// pipeline, which is hard to wire up cleanly inside a unit test. The
// unit tests above cover the pure logic (config, retention, filename
// patterns) — the integration surface is verified end-to-end.
//
// `fsSync` import retained for parity with the legacy test file in
// case future tests need a sync stat call alongside the async fs.
void fsSync;
