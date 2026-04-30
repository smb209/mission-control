#!/usr/bin/env -S tsx
/**
 * db-import-from-prod.ts — clone a "production" SQLite DB into the
 * local dev DB while preserving named local-only tables.
 *
 * Use case: pull a fresh prod data baseline into dev so we can run
 * validation against real workspaces / products / tasks WITHOUT
 * adopting prod's agent identities (which are bound to prod's openclaw
 * gateway instance and won't authenticate from dev).
 *
 * Usage:
 *   yarn db:import-from-prod \
 *     --source <path-or-docker:container:path> \
 *     [--target <path>] \
 *     [--preserve <table,table,...>] \
 *     [--dry-run] \
 *     [--yes]
 *
 *   # Convenience: pull straight from the running stable container
 *   yarn db:import-from-prod --source docker:mission-control:/app/data/mission-control.db
 *
 * What happens, in order:
 *   1. Validate target is not currently open by another writer (no
 *      MC dev server bound to :4010 etc).
 *   2. Backup the current target to <dirname>/backups/import-pre-<ts>.db
 *      via the existing backup pipeline.
 *   3. Snapshot rows from `--preserve` tables in the target into a
 *      temp SQL dump.
 *   4. Replace target with source (file copy).
 *   5. Run schema migrations against the new file so any newer
 *      migrations land before we rehydrate preserved rows.
 *   6. DELETE FROM <preserved> in the new target, then restore the
 *      preserved rows.
 *   7. NULL out FK columns on rows that pointed at agents not present
 *      in the preserved set (`tasks.assigned_agent_id`,
 *      `tasks.created_by_agent_id`, etc). Configurable via the
 *      `FK_FIXUPS` table below.
 *
 * Defaults: only the `agents` table is preserved. That maps to the
 * "agent settings" the operator typically wants to keep — the row
 * carries `gateway_agent_id`, `session_key_prefix`, soul_md, identity
 * tuning. Other agent-adjacent tables (`agent_health`, `agent_mailbox`,
 * `agent_chat_messages`, `openclaw_sessions`) are intentionally NOT
 * preserved — those are derived state that should reset for a fresh
 * baseline.
 *
 * Safety:
 *   - Refuses to run if target file is locked (open by another process).
 *   - Always backs up first; backup path is logged.
 *   - --dry-run prints what would happen without writing.
 *   - --yes is required for non-interactive runs (defends against
 *     accidental cron invocation).
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/lib/db/migrations.js';

interface Args {
  source: string;
  target: string;
  preserve: string[];
  /**
   * Suffix appended to a source agent's `name` to find its target
   * equivalent. E.g. `--agent-suffix=-dev` rewrites every FK pointing
   * at prod's `mc-foo` to dev's `mc-foo-dev` instead of NULLing the
   * column or deleting the row.
   *
   * Empty string disables remapping (legacy behavior).
   */
  agentSuffix: string;
  dryRun: boolean;
  yes: boolean;
}

const DEFAULT_PRESERVE = ['agents'];

/**
 * Tables under `--preserve` are restored from the dev snapshot, so any
 * column elsewhere that REFERENCES one of those tables may now point at
 * a prod row that no longer exists. We discover those columns at runtime
 * via `PRAGMA foreign_key_list` and either NULL them (if the column
 * allows null) or DELETE the entire row (if NOT NULL — typically
 * many-to-many bridge tables like task_roles where an agent-less row is
 * meaningless).
 *
 * Hardcoded blacklist below: tables we never want to touch even if they
 * have agent FKs (e.g. `agents.gateway_agent_id` is a self-pointer that
 * doesn't reference our preserved table).
 */
const SELF_FK_TABLES = new Set(['agents']);

function usage(): never {
  console.error(
    [
      'Usage: yarn db:import-from-prod --source <path-or-docker:container:path> [options]',
      '',
      'Options:',
      '  --source <path>           Source SQLite file. Use docker:<container>:<path> to',
      '                            pull from a running container via `docker cp`.',
      '  --target <path>           Target SQLite file (default: $DATABASE_PATH or ./mission-control.db)',
      '  --preserve a,b,c          Comma-separated tables whose rows are kept from the target.',
      '                            Default: agents',
      '  --dry-run                 Show what would happen without writing.',
      '  --yes                     Required for non-interactive execution.',
      '',
      'Examples:',
      '  yarn db:import-from-prod --source docker:mission-control:/app/data/mission-control.db --yes',
      '  yarn db:import-from-prod --source ~/snapshots/prod.db --preserve agents,workspaces --yes',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {
    preserve: DEFAULT_PRESERVE,
    agentSuffix: '',
    dryRun: false,
    yes: false,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const next = (): string => {
      const v = rest[++i];
      if (v === undefined) usage();
      return v;
    };
    if (a === '--source') args.source = next();
    else if (a === '--target') args.target = next();
    else if (a === '--preserve') args.preserve = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--agent-suffix') args.agentSuffix = next();
    else if (a.startsWith('--agent-suffix=')) args.agentSuffix = a.split('=', 2)[1] ?? '';
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--yes') args.yes = true;
    else if (a === '--help' || a === '-h') usage();
    else {
      console.error(`Unknown argument: ${a}`);
      usage();
    }
  }
  if (!args.source) {
    console.error('--source is required');
    usage();
  }
  if (!args.target) {
    args.target =
      process.env.DATABASE_PATH || path.join(process.cwd(), 'mission-control.db');
  }
  return args as Args;
}

/**
 * Resolve --source. `docker:<container>:<path>` triggers a `docker cp`
 * into a temp file; anything else is treated as a host path.
 */
function resolveSource(spec: string): { path: string; cleanup?: () => void } {
  if (spec.startsWith('docker:')) {
    const rest = spec.slice('docker:'.length);
    const colonIdx = rest.indexOf(':');
    if (colonIdx <= 0) {
      throw new Error(`Bad docker source spec: ${spec}. Expected docker:<container>:<path-in-container>`);
    }
    const container = rest.slice(0, colonIdx);
    const inContainer = rest.slice(colonIdx + 1);
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mc-import-'));
    const out = path.join(tmp, 'source.db');
    console.log(`[import] docker cp ${container}:${inContainer} → ${out}`);
    execSync(`docker cp ${container}:${inContainer} ${out}`, { stdio: 'inherit' });
    return {
      path: out,
      cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
    };
  }
  const expanded = spec.replace(/^~/, process.env.HOME || '');
  if (!fs.existsSync(expanded)) {
    throw new Error(`Source DB does not exist: ${expanded}`);
  }
  return { path: expanded };
}

interface PreservedRows {
  table: string;
  columns: string[];
  rows: unknown[][];
}

/**
 * Build a (source agent id → target agent id) lookup using the
 * suffix rule. Tries `gateway_agent_id` first (the natural openclaw
 * identifier — `mc-builder` ↔ `mc-builder-dev`), then falls back to
 * `name` for agents without a gateway binding (e.g. PM seeded by
 * migration). Captured BEFORE the agents table is rehydrated so we
 * can map the source's agent ids (still in the new target file from
 * the cp) to the target equivalents we just snapshotted.
 *
 * Returns null when no remapping was requested.
 */
function buildAgentRemap(
  newTargetPath: string,
  preserved: PreservedRows[],
  suffix: string,
): { map: Map<string, string>; matched: number; unmatched: number } | null {
  if (!suffix) return null;
  const agentsSnapshot = preserved.find((p) => p.table === 'agents');
  if (!agentsSnapshot) return null;

  // Pull the SOURCE agents (currently in newTargetPath since we just
  // copied source over target — agents haven't been rehydrated yet).
  const db = new Database(newTargetPath, { readonly: true });
  const sourceAgents = db
    .prepare(`SELECT id, name, gateway_agent_id FROM agents`)
    .all() as Array<{ id: string; name: string | null; gateway_agent_id: string | null }>;
  db.close();

  const idCol = agentsSnapshot.columns.indexOf('id');
  const nameCol = agentsSnapshot.columns.indexOf('name');
  const gwCol = agentsSnapshot.columns.indexOf('gateway_agent_id');
  if (idCol < 0) return null;

  const targetByGateway = new Map<string, string>();
  const targetByName = new Map<string, string>();
  for (const row of agentsSnapshot.rows) {
    const id = row[idCol] as string | null;
    if (!id) continue;
    if (gwCol >= 0) {
      const gw = row[gwCol] as string | null;
      if (gw) targetByGateway.set(gw, id);
    }
    if (nameCol >= 0) {
      const name = row[nameCol] as string | null;
      if (name) targetByName.set(name, id);
    }
  }

  const map = new Map<string, string>();
  let matched = 0;
  let unmatched = 0;
  for (const sa of sourceAgents) {
    if (!sa.id) continue;
    let targetId: string | undefined;
    // 1. Suffixed gateway match (prod 'mc-builder' → dev 'mc-builder-dev')
    if (sa.gateway_agent_id) {
      targetId = targetByGateway.get(sa.gateway_agent_id + suffix);
    }
    // 2. Suffixed name fallback (PM seeded by migration has no gw id)
    if (!targetId && sa.name) {
      targetId = targetByName.get(sa.name + suffix);
    }
    // 3. Verbatim gateway match (prod 'main' → dev 'main' — same id used
    //    on both sides of the same openclaw, no suffix added).
    if (!targetId && sa.gateway_agent_id) {
      targetId = targetByGateway.get(sa.gateway_agent_id);
    }
    if (targetId) {
      map.set(sa.id, targetId);
      matched++;
    } else {
      unmatched++;
    }
  }
  return { map, matched, unmatched };
}

/**
 * Read every row from `tables` in the target DB. Returns rows + the
 * column order so we can build INSERT statements that match the
 * (possibly post-migration) schema in the new DB.
 */
function snapshotPreservedRows(targetPath: string, tables: string[]): PreservedRows[] {
  const db = new Database(targetPath, { readonly: true });
  const out: PreservedRows[] = [];
  for (const table of tables) {
    const exists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table) as { name?: string } | undefined;
    if (!exists?.name) {
      console.warn(`[import] preserved table not found in target: ${table} (skipping)`);
      continue;
    }
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    const rows = db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM ${table}`).all() as Record<
      string,
      unknown
    >[];
    out.push({
      table,
      columns: cols,
      rows: rows.map((r) => cols.map((c) => r[c])),
    });
  }
  db.close();
  return out;
}

/**
 * Replace target with source. Also clears WAL/SHM siblings so SQLite
 * doesn't try to replay an old write-ahead log on top of the new file.
 */
function replaceTarget(sourcePath: string, targetPath: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    const p = `${targetPath}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  fs.copyFileSync(sourcePath, targetPath);
}

function rehydratePreserved(targetPath: string, preserved: PreservedRows[]): void {
  const db = new Database(targetPath);
  db.pragma('foreign_keys = OFF'); // we'll fix FKs explicitly below
  for (const p of preserved) {
    const targetCols = (db.prepare(`PRAGMA table_info(${p.table})`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    // Restrict to columns that still exist in the post-migration target.
    // Any preserved-source column dropped in a newer migration is silently
    // discarded; any new target column not in the preserved snapshot gets
    // its DEFAULT.
    const useCols = p.columns.filter((c) => targetCols.includes(c));
    if (useCols.length === 0) {
      console.warn(`[import] no overlapping columns for ${p.table}; skipping rehydrate`);
      continue;
    }
    const placeholders = useCols.map(() => '?').join(', ');
    const sql = `INSERT OR REPLACE INTO ${p.table} (${useCols
      .map((c) => `"${c}"`)
      .join(', ')}) VALUES (${placeholders})`;
    const stmt = db.prepare(sql);
    const insert = db.transaction((rows: unknown[][]) => {
      // First clear existing rows so prod's snapshot of the table is fully
      // replaced (otherwise we'd be doing an upsert that leaves prod rows
      // with conflicting FKs intact).
      db.prepare(`DELETE FROM ${p.table}`).run();
      for (const r of rows) {
        const filtered = useCols.map((c) => r[p.columns.indexOf(c)]);
        stmt.run(filtered);
      }
    });
    insert(p.rows);
    console.log(`[import] rehydrated ${p.rows.length} rows into ${p.table}`);
  }
  db.pragma('foreign_keys = ON');
  db.close();
}

interface FkAction {
  table: string;
  column: string;
  /** 'remap', 'set_null', or 'delete_row'. */
  strategy: 'remap' | 'set_null' | 'delete_row';
  affected: number;
}

/**
 * Walk every user table, find columns that REFERENCE any of the
 * preserved-table sources, and rewrite rows that point at a no-longer-
 * present id. NULLable columns get UPDATE … SET col = NULL. NOT-NULL
 * columns get DELETE — those rows are bridge entries that became
 * meaningless once the referenced agent vanished.
 *
 * Returns the list of mutations actually performed so the import log
 * is honest about what changed.
 */
function fixDanglingFKs(
  targetPath: string,
  preservedTables: string[],
  agentRemap: Map<string, string> | null,
): FkAction[] {
  const db = new Database(targetPath);
  db.pragma('foreign_keys = OFF');
  const out: FkAction[] = [];

  const allTables = (db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
    .all() as Array<{ name: string }>).map((r) => r.name);

  for (const table of allTables) {
    if (SELF_FK_TABLES.has(table)) continue;
    if (preservedTables.includes(table)) continue; // its rows just got rehydrated

    const fkRows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      from: string;
      to: string;
      table: string;
    }>;
    if (fkRows.length === 0) continue;

    const colInfo = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;

    for (const fk of fkRows) {
      if (!preservedTables.includes(fk.table)) continue;
      const col = colInfo.find((c) => c.name === fk.from);
      if (!col) continue;
      const refTable = fk.table;
      const refCol = fk.to;
      const isNotNull = col.notnull === 1 || col.pk > 0;

      // Step 1: rewrite via the agent remap (only valid when the
      // referenced table is `agents` — that's the only remap source we
      // build right now).
      if (agentRemap && agentRemap.size > 0 && refTable === 'agents') {
        const update = db.prepare(
          `UPDATE ${table} SET "${col.name}" = ? WHERE "${col.name}" = ?`,
        );
        let remapped = 0;
        const tx = db.transaction(() => {
          for (const [sourceId, targetId] of agentRemap) {
            const r = update.run(targetId, sourceId);
            remapped += r.changes;
          }
        });
        tx();
        if (remapped > 0) {
          out.push({ table, column: col.name, strategy: 'remap', affected: remapped });
        }
      }

      // Step 2: handle whatever didn't remap (no source agent name match,
      // or remap disabled). Same NULL-vs-DELETE rule as before.
      const strategy: 'set_null' | 'delete_row' = isNotNull ? 'delete_row' : 'set_null';
      const sql =
        strategy === 'set_null'
          ? `UPDATE ${table}
                SET "${col.name}" = NULL
              WHERE "${col.name}" IS NOT NULL
                AND "${col.name}" NOT IN (SELECT "${refCol}" FROM ${refTable})`
          : `DELETE FROM ${table}
              WHERE "${col.name}" NOT IN (SELECT "${refCol}" FROM ${refTable})`;
      const residual = db.prepare(sql).run();
      if (residual.changes > 0) {
        out.push({ table, column: col.name, strategy, affected: residual.changes });
      }
    }
  }

  db.pragma('foreign_keys = ON');
  db.close();
  return out;
}

function rowCounts(dbPath: string, tables: string[]): Record<string, number> {
  const db = new Database(dbPath, { readonly: true });
  const out: Record<string, number> = {};
  for (const t of tables) {
    try {
      const r = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number };
      out[t] = r.c;
    } catch {
      out[t] = -1;
    }
  }
  db.close();
  return out;
}

const SUMMARY_TABLES = [
  'agents',
  'workspaces',
  'products',
  'tasks',
  'task_deliverables',
  'task_evidence',
  'convoys',
  'convoy_subtasks',
  'planning_specs',
  'knowledge_entries',
  'rollcall_sessions',
  'workflow_templates',
];

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  console.log('[import] config:', {
    source: args.source,
    target: args.target,
    preserve: args.preserve,
    dryRun: args.dryRun,
  });

  const { path: sourcePath, cleanup } = resolveSource(args.source);
  try {
    if (!fs.existsSync(args.target)) {
      throw new Error(`Target DB does not exist: ${args.target}. Run \`yarn db:reset\` first if you want a fresh dev DB.`);
    }

    // Live-writer check. Stale `-wal` / `-shm` siblings are harmless (we
    // wipe them in replaceTarget), so the meaningful signal is "is an MC
    // dev server actually running?" — i.e. is the configured dev port
    // bound. We probe both the active default (4010) and any port the
    // operator has set explicitly via $PORT.
    const candidatePorts = [4010, Number(process.env.PORT) || 0].filter((p) => p > 0);
    for (const port of candidatePorts) {
      try {
        const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`, {
          encoding: 'utf8',
        }).trim();
        if (out.length > 0) {
          throw new Error(
            `Port ${port} is bound (pid ${out.replace(/\s+/g, ',')}). Stop the MC dev server before importing.`,
          );
        }
      } catch (err) {
        if ((err as Error).message.startsWith('Port ')) throw err;
        // lsof not available — fall through. Operator is responsible.
      }
    }

    console.log('[import] source row counts:', rowCounts(sourcePath, SUMMARY_TABLES));
    console.log('[import] target row counts (before):', rowCounts(args.target, SUMMARY_TABLES));

    if (args.dryRun) {
      console.log('[import] --dry-run set, exiting before any writes.');
      return;
    }
    if (!args.yes) {
      console.error('[import] --yes is required to actually run the import. Aborting.');
      process.exit(2);
    }

    // 1. Backup target.
    const backupDir = path.join(path.dirname(args.target), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `import-pre-${ts}.db`);
    fs.copyFileSync(args.target, backupPath);
    console.log(`[import] backed up target → ${backupPath}`);

    // 2. Snapshot preserved rows.
    const preserved = snapshotPreservedRows(args.target, args.preserve);
    console.log(
      `[import] snapshotted preserved tables:`,
      preserved.map((p) => `${p.table}=${p.rows.length}`).join(', '),
    );

    // 3. Replace target with source.
    replaceTarget(sourcePath, args.target);
    console.log(`[import] replaced ${args.target} with ${sourcePath}`);

    // 4. Run migrations on the new target so any migrations newer than
    //    the source's last applied id land before we rehydrate.
    const dbForMigrations = new Database(args.target);
    runMigrations(dbForMigrations);
    dbForMigrations.close();
    console.log('[import] migrations applied to new target');

    // 5a. Build the agent remap BEFORE rehydration, while the new target
    //     file still contains the source's agent rows. After rehydrate,
    //     those source rows are gone and we'd lose the (id → name) lookup.
    const remap = buildAgentRemap(args.target, preserved, args.agentSuffix);
    if (remap) {
      console.log(
        `[import] agent name remap (suffix='${args.agentSuffix}'): ${remap.matched} matched, ${remap.unmatched} unmatched`,
      );
    }

    // 5b. Rehydrate preserved rows.
    rehydratePreserved(args.target, preserved);

    // 6. Fix dangling FKs that point at no-longer-present preserved rows.
    const fkActions = fixDanglingFKs(args.target, args.preserve, remap?.map ?? null);
    if (fkActions.length === 0) {
      console.log('[import] no dangling FKs to fix');
    } else {
      for (const f of fkActions) {
        const verb =
          f.strategy === 'remap'
            ? 'remapped'
            : f.strategy === 'set_null'
              ? 'NULLed'
              : 'deleted';
        console.log(`[import] ${verb} ${f.affected} ${f.table}.${f.column} row(s)`);
      }
    }

    console.log('[import] target row counts (after):', rowCounts(args.target, SUMMARY_TABLES));
    console.log('[import] done.');
  } finally {
    cleanup?.();
  }
}

main().catch((err) => {
  console.error('[import] FAILED:', err);
  process.exit(1);
});
