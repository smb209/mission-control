#!/usr/bin/env node
/**
 * Seeder for scripts/mcp-next-e2e.mjs.
 *
 * Opens the tmpfile DB (path in $DATABASE_PATH), runs the app's migrations
 * via getDb(), inserts a piloted agent + an outsider + a task, then
 * closes the handle. Called by the main harness via `tsx` so TypeScript
 * path aliases resolve.
 */

import { getDb, run, closeDb } from '../src/lib/db/index';

// Touch getDb() so migrations run before we INSERT.
getDb();

const agentId = process.env.SEED_AGENT_ID;
const outsiderId = process.env.SEED_OUTSIDER_ID;
const taskId = process.env.SEED_TASK_ID;

if (!agentId || !outsiderId || !taskId) {
  console.error('SEED_AGENT_ID, SEED_OUTSIDER_ID, SEED_TASK_ID are required');
  process.exit(2);
}

run(
  `INSERT INTO agents (id, name, role, workspace_id, is_active, gateway_agent_id, created_at, updated_at)
   VALUES (?, 'Builder (E2E)', 'builder', 'default', 1, 'mc-e2e-builder', datetime('now'), datetime('now'))`,
  [agentId],
);

run(
  `INSERT INTO agents (id, name, role, workspace_id, is_active, gateway_agent_id, created_at, updated_at)
   VALUES (?, 'Outsider (E2E)', 'tester', 'default', 1, 'mc-e2e-outsider', datetime('now'), datetime('now'))`,
  [outsiderId],
);

run(
  `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at)
   VALUES (?, 'E2E task', 'in_progress', 'normal', 'default', 'default', ?, datetime('now'), datetime('now'))`,
  [taskId, agentId],
);

closeDb();
console.log(`[next-e2e.seed] seeded agent=${agentId}, outsider=${outsiderId}, task=${taskId}`);
