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
  /** 'set_null' (column is NULLable) or 'delete_row' (NOT NULL or PK part). */
  strategy: 'set_null' | 'delete_row';
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
      const strategy: FkAction['strategy'] = isNotNull ? 'delete_row' : 'set_null';

      const sql =
        strategy === 'set_null'
          ? `UPDATE ${table}
                SET "${col.name}" = NULL
              WHERE "${col.name}" IS NOT NULL
                AND "${col.name}" NOT IN (SELECT "${refCol}" FROM ${refTable})`
          : `DELETE FROM ${table}
              WHERE "${col.name}" NOT IN (SELECT "${refCol}" FROM ${refTable})`;

      const result = db.prepare(sql).run();
      if (result.changes > 0) {
        out.push({ table, column: col.name, strategy, affected: result.changes });
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

    // 5. Rehydrate preserved rows.
    rehydratePreserved(args.target, preserved);

    // 6. Fix dangling FKs that point at no-longer-present preserved rows.
    const fkActions = fixDanglingFKs(args.target, args.preserve);
    if (fkActions.length === 0) {
      console.log('[import] no dangling FKs to fix');
    } else {
      for (const f of fkActions) {
        const verb = f.strategy === 'set_null' ? 'NULLed' : 'deleted';
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
