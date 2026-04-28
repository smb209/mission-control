#!/usr/bin/env -S tsx
/**
 * export-workspace.ts
 *
 * Thin CLI wrapper around src/lib/db/workspace-export.ts. Dumps every
 * workspace-scoped table for a given workspace_id to a JSON file.
 *
 * Usage:
 *   yarn tsx scripts/export-workspace.ts \
 *     [--workspace-id=default] \
 *     [--out=./workspace-export.json] \
 *     [--include-transient] \
 *     [--db=./mission-control.db]
 *
 * The same export logic powers the workspace settings page download
 * button, so the CLI and UI stay aligned on what "export everything"
 * means.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import Database from 'better-sqlite3';
import {
  exportWorkspace,
  defaultExportFilename,
  WorkspaceNotFoundError,
} from '../src/lib/db/workspace-export.js';

interface Args {
  workspaceId: string;
  out?: string;
  includeTransient: boolean;
  dbPath: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    workspaceId: 'default',
    includeTransient: false,
    dbPath: process.env.DATABASE_PATH ?? './mission-control.db',
  };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--workspace-id=')) args.workspaceId = a.split('=', 2)[1];
    else if (a.startsWith('--out=')) args.out = a.split('=', 2)[1];
    else if (a === '--include-transient') args.includeTransient = true;
    else if (a.startsWith('--db=')) args.dbPath = a.split('=', 2)[1];
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: yarn tsx scripts/export-workspace.ts [--workspace-id=ID] [--out=FILE] [--include-transient] [--db=PATH]',
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const dbPath = path.resolve(args.dbPath);

  await fs.access(dbPath).catch(() => {
    console.error(`DB not found at ${dbPath}`);
    process.exit(1);
  });

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  let result;
  try {
    result = exportWorkspace(db, args.workspaceId, {
      includeTransient: args.includeTransient,
    });
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError) {
      console.error(err.message);
      const all = db.prepare('SELECT id, name FROM workspaces ORDER BY id').all() as Array<{
        id: string;
        name?: string;
      }>;
      if (all.length > 0) {
        console.error('Available workspaces:');
        for (const w of all) console.error(`  - ${w.id}${w.name ? `  (${w.name})` : ''}`);
      }
      process.exit(1);
    }
    throw err;
  } finally {
    db.close();
  }

  const outPath = path.resolve(
    args.out ??
      `./${defaultExportFilename(args.workspaceId, result.exported_at)}`,
  );
  await fs.writeFile(outPath, JSON.stringify(result, null, 2), 'utf8');

  console.log(`Exported workspace "${args.workspaceId}" → ${outPath}`);
  console.log(`Schema migration at export: ${result.schema_migration ?? '(unknown)'}`);
  console.log(`Transient tables included: ${result.include_transient}`);
  for (const [t, n] of Object.entries(result.table_counts)) {
    console.log(`  ${t.padEnd(34)} ${n}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
