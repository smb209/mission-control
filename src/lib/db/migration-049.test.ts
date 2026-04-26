/**
 * Migration 049 (`pm_named_agent_link`) backfill behaviour.
 *
 * Verifies the SQL the migration runs against rows that look like
 * pre-049 PM seeds (source='local', gateway_agent_id=NULL). The shared
 * test DB has already applied 049, so we *simulate* a legacy row by
 * stripping the link off a freshly-ensured PM, then re-run the
 * migration's UPDATE statements verbatim.
 *
 * Real migration runs are exercised by the broader test harness (every
 * test that touches getDb() runs the full migration list at startup);
 * this file checks the backfill semantics specifically.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, queryOne, run } from '@/lib/db';
import { ensurePmAgent } from '@/lib/bootstrap-agents';

function freshWorkspace(): string {
  const id = `ws-mig049-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

test('migration 049: backfills pre-049 PM rows with gateway link + persona', () => {
  const ws = freshWorkspace();
  const r = ensurePmAgent(ws);

  // Simulate a legacy row: clear the gateway link, reset name, and put
  // source back to 'local' so it matches the migration 045 shape.
  run(
    `UPDATE agents
        SET gateway_agent_id = NULL,
            session_key_prefix = NULL,
            source = 'local',
            name = 'PM',
            avatar_emoji = '📋'
      WHERE id = ?`,
    [r.id],
  );

  // Replay migration 049's logic.
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, name FROM agents
        WHERE role = 'pm' AND gateway_agent_id IS NULL`,
    )
    .all() as { id: string; name: string }[];
  assert.ok(
    rows.some(x => x.id === r.id),
    'expected legacy PM row to be picked up by migration filter',
  );

  const updateLinked = db.prepare(
    `UPDATE agents
        SET gateway_agent_id = 'mc-project-manager',
            session_key_prefix = 'agent:mc-project-manager:main',
            source = 'gateway',
            updated_at = ?
      WHERE id = ?`,
  );
  const updateRenamed = db.prepare(
    `UPDATE agents
        SET name = 'Margaret "Maps" Hamilton',
            avatar_emoji = '🗺️',
            updated_at = ?
      WHERE id = ?`,
  );
  const now = new Date().toISOString();
  for (const row of rows) {
    updateLinked.run(now, row.id);
    if (row.name === 'PM') updateRenamed.run(now, row.id);
  }

  const after = queryOne<{
    name: string;
    avatar_emoji: string;
    source: string;
    gateway_agent_id: string;
    session_key_prefix: string;
  }>(
    `SELECT name, avatar_emoji, source, gateway_agent_id, session_key_prefix
       FROM agents WHERE id = ?`,
    [r.id],
  );
  assert.ok(after);
  assert.equal(after!.gateway_agent_id, 'mc-project-manager');
  assert.equal(after!.session_key_prefix, 'agent:mc-project-manager:main');
  assert.equal(after!.source, 'gateway');
  assert.equal(after!.name, 'Margaret "Maps" Hamilton');
  assert.equal(after!.avatar_emoji, '🗺️');
});

test('migration 049: preserves operator-customized PM name', () => {
  const ws = freshWorkspace();
  const r = ensurePmAgent(ws);

  // Operator-customized row: legacy state + a non-default name.
  run(
    `UPDATE agents
        SET gateway_agent_id = NULL,
            session_key_prefix = NULL,
            source = 'local',
            name = 'PM Bob',
            avatar_emoji = '🦊'
      WHERE id = ?`,
    [r.id],
  );

  // Replay only the rename guard.
  const db = getDb();
  const updateLinked = db.prepare(
    `UPDATE agents
        SET gateway_agent_id = 'mc-project-manager',
            session_key_prefix = 'agent:mc-project-manager:main',
            source = 'gateway',
            updated_at = ?
      WHERE id = ?`,
  );
  const updateRenamed = db.prepare(
    `UPDATE agents
        SET name = 'Margaret "Maps" Hamilton',
            avatar_emoji = '🗺️',
            updated_at = ?
      WHERE id = ?`,
  );
  const now = new Date().toISOString();
  updateLinked.run(now, r.id);
  // Replay the migration's name-guarded rename only when name === 'PM'.
  const cur = queryOne<{ name: string }>(`SELECT name FROM agents WHERE id = ?`, [r.id]);
  if (cur?.name === 'PM') updateRenamed.run(now, r.id);

  const after = queryOne<{ name: string; avatar_emoji: string; gateway_agent_id: string }>(
    `SELECT name, avatar_emoji, gateway_agent_id FROM agents WHERE id = ?`,
    [r.id],
  );
  assert.ok(after);
  // Gateway link applied …
  assert.equal(after!.gateway_agent_id, 'mc-project-manager');
  // … but operator-customized name + emoji preserved.
  assert.equal(after!.name, 'PM Bob');
  assert.equal(after!.avatar_emoji, '🦊');
});
