/**
 * Regression test: SQLite stores `created_at` as bare "YYYY-MM-DD HH:MM:SS"
 * (via `datetime('now')`) and compares datetime columns as text. If a query
 * binds an ISO-Z cutoff like "2026-05-08T00:00:00.000Z", the `T` (0x54) sorts
 * after the space (0x20) at byte 11 — silently excluding rows from the same
 * day. The fix is to bind the cutoff in the same bare-SQLite shape.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run, toSqliteUtc } from '@/lib/db';
import { getCostOverview } from './reporting';
import { checkCaps } from './caps';

function seedWorkspace(): string {
  const id = `ws-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
     VALUES (?, ?, 'test-ws', datetime('now'), datetime('now'))`,
    [id, id],
  );
  return id;
}

function seedCostEvent(opts: {
  workspaceId: string;
  productId?: string | null;
  costUsd: number;
  createdAt: string; // bare-SQLite shape, e.g. "2026-05-08 09:30:00"
}) {
  run(
    `INSERT INTO cost_events (id, workspace_id, product_id, event_type, cost_usd, created_at)
     VALUES (?, ?, ?, 'agent_dispatch', ?, ?)`,
    [uuidv4(), opts.workspaceId, opts.productId ?? null, opts.costUsd, opts.createdAt],
  );
}

test('toSqliteUtc emits bare-SQLite shape with no T or Z', () => {
  const d = new Date(Date.UTC(2026, 4, 8, 9, 30, 15));
  assert.equal(toSqliteUtc(d), '2026-05-08 09:30:15');
});

test('getCostOverview includes today\'s rows in daily total', () => {
  const wsId = seedWorkspace();

  // Seed two rows stamped at "now" — both unambiguously fall inside the
  // "today" window (local-day-start ≤ now < local-day-start + 24h). Under
  // the bug, the daily query binds an ISO-Z cutoff and excludes them
  // because "T" > " " at byte 11; with the fix it binds bare-SQLite shape
  // and the rows match.
  const nowBare = toSqliteUtc(new Date());
  seedCostEvent({ workspaceId: wsId, costUsd: 1.23, createdAt: nowBare });
  seedCostEvent({ workspaceId: wsId, costUsd: 2.5, createdAt: nowBare });

  const overview = getCostOverview(wsId);
  assert.ok(
    Math.abs(overview.today - 3.73) < 1e-9,
    `today total should be 3.73, got ${overview.today}`,
  );
  assert.ok(
    Math.abs(overview.this_month - 3.73) < 1e-9,
    `month total should be 3.73, got ${overview.this_month}`,
  );
});

test('checkCaps daily window includes today\'s rows', () => {
  const wsId = seedWorkspace();

  const capId = uuidv4();
  run(
    `INSERT INTO cost_caps (id, workspace_id, cap_type, limit_usd, status)
     VALUES (?, ?, 'daily', 5.0, 'active')`,
    [capId, wsId],
  );

  // Seed a same-second row that exceeds the cap. Under the bug, the daily
  // recalc misses it; with the fix the cap recalculates above the limit.
  seedCostEvent({ workspaceId: wsId, costUsd: 10.0, createdAt: toSqliteUtc(new Date()) });

  const result = checkCaps(wsId);
  assert.ok(
    result.exceeded.some(c => c.id === capId),
    'daily cap should be flagged as exceeded once today\'s rows are counted',
  );
});
