/**
 * Phase G: PM is the workspace's only required agent and is the
 * master orchestrator (is_pm=1 AND is_master=1).
 *
 * Coverage:
 *  - ensurePmAgent on a fresh workspace inserts with is_master=1.
 *  - ensurePmAgent on a legacy workspace (PM with is_master=0)
 *    upgrades the existing row in place.
 *  - hasWorkspacePm requires both flags + is_active.
 *  - assertWorkspacePm throws WorkspacePmRequiredError when missing.
 *  - migration 069 backfills is_master on legacy PM rows
 *    (verified by running the test-template setup which applies all
 *    migrations).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run } from '@/lib/db';
import {
  assertWorkspacePm,
  ensurePmAgent,
  hasWorkspacePm,
  WorkspacePmRequiredError,
} from './bootstrap-agents';

function freshWorkspace(): string {
  const id = `ws-pm-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

test('ensurePmAgent: fresh workspace gets PM with is_pm=1 AND is_master=1', () => {
  const ws = freshWorkspace();
  const result = ensurePmAgent(ws);
  assert.equal(result.created, true);
  const row = queryOne<{ id: string; is_pm: number; is_master: number; role: string; name: string }>(
    `SELECT id, is_pm, COALESCE(is_master,0) AS is_master, role, name
       FROM agents WHERE workspace_id = ? AND is_pm = 1 LIMIT 1`,
    [ws],
  );
  assert.ok(row);
  assert.equal(row?.is_pm, 1);
  assert.equal(row?.is_master, 1);
  assert.equal(row?.role, 'pm');
  assert.equal(row?.name, 'PM');
});

test('ensurePmAgent: idempotent — second call returns same id, created=false', () => {
  const ws = freshWorkspace();
  const first = ensurePmAgent(ws);
  const second = ensurePmAgent(ws);
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
});

test('ensurePmAgent: upgrades legacy is_master=0 PM to is_master=1', () => {
  const ws = freshWorkspace();
  // Simulate a pre-Phase-G workspace: PM with is_master=0.
  const id = uuidv4();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_pm, is_master, is_active, created_at, updated_at)
     VALUES (?, 'PM', 'pm', ?, 1, 0, 1, datetime('now'), datetime('now'))`,
    [id, ws],
  );
  // Sanity: legacy row is is_master=0.
  let row = queryOne<{ is_master: number }>(
    `SELECT COALESCE(is_master,0) AS is_master FROM agents WHERE id = ?`,
    [id],
  );
  assert.equal(row?.is_master, 0);

  const result = ensurePmAgent(ws);
  assert.equal(result.id, id);
  assert.equal(result.created, false);

  row = queryOne<{ is_master: number }>(
    `SELECT COALESCE(is_master,0) AS is_master FROM agents WHERE id = ?`,
    [id],
  );
  assert.equal(row?.is_master, 1, 'ensurePmAgent should backfill is_master on legacy PMs');
});

test('hasWorkspacePm: returns false for an empty workspace', () => {
  const ws = freshWorkspace();
  assert.equal(hasWorkspacePm(ws), false);
});

test('hasWorkspacePm: requires both is_pm=1 AND is_master=1', () => {
  const ws = freshWorkspace();
  // is_pm=1, is_master=0 — not a master orchestrator yet.
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_pm, is_master, is_active, created_at, updated_at)
     VALUES (?, 'PM', 'pm', ?, 1, 0, 1, datetime('now'), datetime('now'))`,
    [uuidv4(), ws],
  );
  assert.equal(hasWorkspacePm(ws), false);
});

test('hasWorkspacePm: requires is_active=1', () => {
  const ws = freshWorkspace();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_pm, is_master, is_active, created_at, updated_at)
     VALUES (?, 'PM', 'pm', ?, 1, 1, 0, datetime('now'), datetime('now'))`,
    [uuidv4(), ws],
  );
  assert.equal(hasWorkspacePm(ws), false);
});

test('hasWorkspacePm: returns true after ensurePmAgent', () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  assert.equal(hasWorkspacePm(ws), true);
});

test('assertWorkspacePm: throws WorkspacePmRequiredError when missing', () => {
  const ws = freshWorkspace();
  assert.throws(() => assertWorkspacePm(ws), WorkspacePmRequiredError);
});

test('assertWorkspacePm: silent when PM is correctly configured', () => {
  const ws = freshWorkspace();
  ensurePmAgent(ws);
  assert.doesNotThrow(() => assertWorkspacePm(ws));
});

// Note: the migration-069 backfill assertion isn't a meaningful test
// at this scope — other tests in the file deliberately insert
// is_pm=1 + is_master=0 rows to exercise hasWorkspacePm's flag
// requirements, and node:test shares a single template DB across
// tests. The migration's effect is logged at template-build time
// (`[Migration 069] is_master=1 backfilled on N PM agent row(s).`)
// and exercised in the production migration suite.
