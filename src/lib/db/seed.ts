// Database seed script.
//
// Historically this seeded a sample team (Orchestrator + Developer/Researcher/
// Writer/Designer) plus example tasks and a welcome message, so a fresh
// install had something to look at. Agents are now primarily gateway-synced
// (openclaw is the source of truth), and the core PM/Coordinator/Builder
// triumvirate is bootstrapped via migrations 045/046/049 against the 'default'
// workspace at first DB init. Seeding example agents here just produced
// duplicate / ghost rows once gateway sync ran.
//
// What's left: the `default` business row, which other code paths still
// expect to exist. Everything else is a no-op.

import { getDb, closeDb } from './index';

async function seed() {
  console.log('🌱 Seeding database...');

  const db = getDb();
  const now = new Date().toISOString();

  // Default business row — referenced by tasks.business_id FK in older
  // code paths. Idempotent.
  db.prepare(
    `INSERT OR IGNORE INTO businesses (id, name, description, created_at) VALUES (?, ?, ?, ?)`,
  ).run('default', 'Mission Control HQ', 'Default workspace for all operations', now);

  console.log('✅ Database seed complete (agents are gateway-synced; nothing else to seed).');
  closeDb();
}

seed().catch(console.error);
