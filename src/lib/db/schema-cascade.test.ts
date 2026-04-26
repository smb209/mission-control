/**
 * Schema FK cascade-coverage guardrail.
 *
 * Migration 048 hardened the FK graph by adding `ON DELETE CASCADE` /
 * `ON DELETE SET NULL` to every reference targeting a top-level entity
 * (workspaces, tasks, agents, initiatives, products, ideas, …). This
 * test scans the live schema (a fresh in-memory DB compiled from
 * `schema.ts`) and asserts that no FK to one of those parents has been
 * left as a plain reference.
 *
 * Any future schema addition that forgets a delete rule will fail this
 * test, forcing the author to make an intentional CASCADE-vs-SET-NULL
 * choice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { schema } from './schema';

/**
 * Parent tables whose FKs must always carry an explicit ON DELETE rule.
 * Adding to this list tightens coverage; removing weakens it.
 */
const GUARDED_PARENTS = new Set([
  'workspaces',
  'tasks',
  'agents',
  'initiatives',
  'products',
  'ideas',
  'convoys',
  'conversations',
  'research_cycles',
  'rollcall_sessions',
  'workflow_templates',
  'product_skills',
  'product_program_variants',
  'pm_proposals',
  'agent_mailbox',
]);

/**
 * Per-(table, fromColumn) explicit choice. The test asserts the FK has
 * the listed rule. If a child table truly needs a custom rule (e.g. NO
 * ACTION because the parent is never deleted), encode it here so the
 * intent is visible.
 *
 * Currently empty — the broad rule "must be CASCADE or SET NULL" is
 * sufficient for every guarded parent. Reserved as an extension point.
 */
const EXPLICIT_RULES: Record<string, 'CASCADE' | 'SET NULL'> = {};

interface FkRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

function compileSchemaDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  return db;
}

function listTables(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map(r => r.name);
}

function listForeignKeys(db: Database.Database, table: string): FkRow[] {
  // Use raw exec to avoid double-quoting the table name. Table names in
  // schema.ts are vetted source — no SQL injection surface here.
  return db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as FkRow[];
}

test('every FK to a guarded parent table has ON DELETE CASCADE or SET NULL', () => {
  const db = compileSchemaDb();
  const violations: string[] = [];

  for (const table of listTables(db)) {
    const fks = listForeignKeys(db, table);
    for (const fk of fks) {
      if (!GUARDED_PARENTS.has(fk.table)) continue;

      const rule = (fk.on_delete || '').toUpperCase().trim();
      const allowed = rule === 'CASCADE' || rule === 'SET NULL';
      if (!allowed) {
        violations.push(
          `${table}.${fk.from} -> ${fk.table}(${fk.to}): ON DELETE is "${fk.on_delete}" (need CASCADE or SET NULL)`,
        );
        continue;
      }

      // Honour any per-FK explicit rule overrides.
      const key = `${table}.${fk.from}`;
      const explicit = EXPLICIT_RULES[key];
      if (explicit && rule !== explicit) {
        violations.push(
          `${table}.${fk.from} -> ${fk.table}(${fk.to}): expected ON DELETE ${explicit} (per EXPLICIT_RULES), got ${rule}`,
        );
      }
    }
  }

  db.close();

  assert.equal(
    violations.length,
    0,
    `Schema FK guardrail violations:\n  ` + violations.join('\n  '),
  );
});

test('workspace_id columns cascade everywhere they appear', () => {
  // Tightened sub-rule: every FK named workspace_id to workspaces(id)
  // must be CASCADE (not SET NULL) — workspace-scoped rows are
  // meaningless without their workspace.
  const db = compileSchemaDb();
  const violations: string[] = [];

  for (const table of listTables(db)) {
    for (const fk of listForeignKeys(db, table)) {
      if (fk.table !== 'workspaces') continue;
      if (fk.from !== 'workspace_id') continue;
      const rule = (fk.on_delete || '').toUpperCase().trim();
      if (rule !== 'CASCADE') {
        violations.push(`${table}.${fk.from} -> workspaces(id): expected CASCADE, got "${fk.on_delete}"`);
      }
    }
  }

  db.close();

  assert.equal(
    violations.length,
    0,
    `workspace_id cascade violations:\n  ` + violations.join('\n  '),
  );
});
