#!/usr/bin/env -S tsx
/**
 * import-workspace.ts — counterpart to scripts/export-workspace.ts.
 * Loads a workspace export JSON and inserts its non-transient rows
 * into a target SQLite DB without wiping anything else.
 *
 * Usage:
 *   yarn tsx scripts/import-workspace.ts \
 *     --in=<export.json> \
 *     [--workspace-id=ID]            target workspace id (existing or new)
 *     [--new-workspace]              materialise a fresh workspaces row
 *     [--workspace-name=NAME]        required when --new-workspace
 *     [--workspace-slug=SLUG]
 *     [--workspace-icon=📁]
 *     [--workspace-description=...]
 *     [--tables=t1,t2,...]           restrict to specific tables
 *     [--include-transient]
 *     [--db=PATH]                    target DB (default: $DATABASE_PATH or ./mission-control.db)
 *     [--dry-run]
 *     [--yes]
 *
 * Examples:
 *   # Initiatives-only into a brand new workspace
 *   yarn tsx scripts/import-workspace.ts \
 *     --in=~/Downloads/MISSION-CONTROL-IDEAS.json \
 *     --new-workspace --workspace-name="Imported Ideas" \
 *     --tables=initiatives,initiative_dependencies,initiative_parent_history \
 *     --yes
 *
 *   # Everything (non-transient) into an existing workspace
 *   yarn tsx scripts/import-workspace.ts --in=./export.json \
 *     --workspace-id=default --yes
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import {
  importWorkspace,
  ImportError,
  type ImportInput,
} from '../src/lib/db/workspace-import.js';

interface Args {
  in?: string;
  workspaceId?: string;
  newWorkspace: boolean;
  workspaceName?: string;
  workspaceSlug?: string;
  workspaceIcon?: string;
  workspaceDescription?: string;
  tables?: string[];
  includeTransient: boolean;
  dbPath: string;
  dryRun: boolean;
  yes: boolean;
}

function usage(): never {
  console.error(
    [
      'Usage: yarn tsx scripts/import-workspace.ts --in=<export.json> [options]',
      '',
      'Options:',
      '  --in=PATH                    workspace export JSON (required)',
      '  --workspace-id=ID            target workspace id (existing or new)',
      '  --new-workspace              create a fresh workspaces row',
      '  --workspace-name=NAME        required when --new-workspace',
      '  --workspace-slug=SLUG        defaults to slugified name',
      '  --workspace-icon=📁',
      '  --workspace-description=TEXT',
      '  --tables=t1,t2,...           restrict to specific tables',
      '  --include-transient          include chat/mailbox/health/sessions',
      '  --db=PATH                    default $DATABASE_PATH or ./mission-control.db',
      '  --dry-run                    report intended changes only',
      '  --yes                        required for non-dry runs',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    newWorkspace: false,
    includeTransient: false,
    dbPath: process.env.DATABASE_PATH ?? './mission-control.db',
    dryRun: false,
    yes: false,
  };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--in=')) args.in = a.split('=', 2)[1];
    else if (a.startsWith('--workspace-id=')) args.workspaceId = a.split('=', 2)[1];
    else if (a === '--new-workspace') args.newWorkspace = true;
    else if (a.startsWith('--workspace-name=')) args.workspaceName = a.split('=', 2)[1];
    else if (a.startsWith('--workspace-slug=')) args.workspaceSlug = a.split('=', 2)[1];
    else if (a.startsWith('--workspace-icon=')) args.workspaceIcon = a.split('=', 2)[1];
    else if (a.startsWith('--workspace-description=')) args.workspaceDescription = a.split('=', 2)[1];
    else if (a.startsWith('--tables=')) {
      args.tables = a
        .split('=', 2)[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === '--include-transient') args.includeTransient = true;
    else if (a.startsWith('--db=')) args.dbPath = a.split('=', 2)[1];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--yes') args.yes = true;
    else if (a === '--help' || a === '-h') usage();
    else {
      console.error(`Unknown argument: ${a}`);
      usage();
    }
  }
  if (!args.in) {
    console.error('--in is required');
    usage();
  }
  if (args.newWorkspace && !args.workspaceName) {
    console.error('--workspace-name is required when --new-workspace is set');
    usage();
  }
  if (!args.newWorkspace && !args.workspaceId) {
    console.error('Either --workspace-id or --new-workspace is required');
    usage();
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const inPath = path.resolve(args.in!.replace(/^~/, process.env.HOME ?? '~'));
  const dbPath = path.resolve(args.dbPath);

  const raw = await fs.readFile(inPath, 'utf8');
  const input = JSON.parse(raw) as ImportInput;
  console.log(`[import] source: ${inPath}`);
  console.log(`[import] export workspace_id (in JSON): ${input.workspace_id}`);
  console.log(`[import] target db: ${dbPath}`);

  await fs.access(dbPath).catch(() => {
    console.error(`Target DB not found at ${dbPath}`);
    process.exit(1);
  });

  if (!args.dryRun && !args.yes) {
    console.error('--yes is required to perform a real import (or use --dry-run)');
    process.exit(2);
  }

  const db = new Database(dbPath);
  try {
    const result = importWorkspace(db, input, {
      workspaceId: args.workspaceId,
      createWorkspace: args.newWorkspace
        ? {
            name: args.workspaceName!,
            slug: args.workspaceSlug,
            icon: args.workspaceIcon ?? null,
            description: args.workspaceDescription ?? null,
          }
        : undefined,
      tables: args.tables,
      includeTransient: args.includeTransient,
      dryRun: args.dryRun,
    });

    console.log('');
    console.log(
      `[import] ${args.dryRun ? 'DRY RUN — would import' : 'imported'} into workspace_id=${result.workspace_id}` +
        (result.created_workspace ? ' (newly created)' : ''),
    );
    console.log('[import] table         inserted   skipped   fk-nulled');
    const tables = Object.keys(result.inserted).sort();
    const longest = Math.max(15, ...tables.map((t) => t.length));
    for (const t of tables) {
      const ins = String(result.inserted[t] ?? 0).padStart(8);
      const skip = String(result.skipped[t] ?? 0).padStart(8);
      const fkn = String(result.fk_nulled[t] ?? 0).padStart(9);
      console.log(`[import]   ${t.padEnd(longest)}  ${ins}  ${skip}   ${fkn}`);
    }
    if (result.ignored_tables.length > 0) {
      console.log(`[import] ignored tables (filtered/transient/missing): ${result.ignored_tables.join(', ')}`);
    }
  } catch (err) {
    if (err instanceof ImportError) {
      console.error(`[import] FAILED: ${err.message}`);
      process.exit(1);
    }
    throw err;
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('[import] FAILED:', err);
  process.exit(1);
});
