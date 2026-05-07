/**
 * POST /api/workspaces/[id]/import
 *
 * Counterpart to GET .../export. Receives an export-shaped JSON
 * document and inserts the operator-selected tables into either:
 *   - the workspace identified by `[id]` (mode='existing'), or
 *   - a freshly-created workspace (mode='new', with a `name` field).
 *
 * Mirrors the options on `scripts/import-workspace.ts`. Both code paths
 * share the lib at `src/lib/db/workspace-import.ts`.
 *
 * Body shape:
 *   {
 *     export: ImportInput,                 // the JSON file's contents
 *     mode: 'existing' | 'new',
 *     tables?: string[],                   // restrict to these table names
 *     include_transient?: boolean,
 *     dry_run?: boolean,
 *     // Required when mode='new':
 *     new_workspace?: { name, slug?, icon?, description? }
 *   }
 *
 * Returns the same shape `importWorkspace` produces, plus a
 * `dry_run` flag for the UI to render an "are-you-sure" preview vs.
 * a final result.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import {
  importWorkspace,
  ImportError,
  type ImportInput,
} from '@/lib/db/workspace-import';

export const dynamic = 'force-dynamic';

// Body validation. We deliberately don't validate the full ImportInput
// shape here — the import lib does its own parsing and surfaces
// structured errors back to the operator.
const Body = z.object({
  export: z.object({
    version: z.number(),
    workspace_id: z.string().min(1),
    tables: z.record(z.string(), z.array(z.unknown())),
    table_counts: z.record(z.string(), z.number()).optional(),
    schema_migration: z.string().nullish(),
    include_transient: z.boolean().optional(),
  }),
  mode: z.enum(['existing', 'new']),
  tables: z.array(z.string()).optional(),
  include_transient: z.boolean().optional(),
  dry_run: z.boolean().optional(),
  new_workspace: z
    .object({
      name: z.string().min(1).max(120),
      slug: z.string().max(64).optional(),
      icon: z.string().max(8).optional(),
      description: z.string().max(2000).optional(),
    })
    .optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  let body: z.infer<typeof Body>;
  try {
    const raw = await request.json();
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation failed', details: parsed.error.issues },
        { status: 400 },
      );
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (body.mode === 'new' && !body.new_workspace) {
    return NextResponse.json(
      { error: 'mode=new requires new_workspace.name' },
      { status: 400 },
    );
  }

  const db = getDb();

  // Resolve the URL `id` to a canonical workspace_id. Only relevant
  // when mode='existing'; for new mode the URL workspace acts as the
  // "host" page but the import doesn't write into it.
  let targetWorkspaceId: string | undefined;
  if (body.mode === 'existing') {
    const ws = db
      .prepare('SELECT id FROM workspaces WHERE id = ? OR slug = ?')
      .get(id, id) as { id: string } | undefined;
    if (!ws) {
      return NextResponse.json(
        { error: 'host workspace not found' },
        { status: 404 },
      );
    }
    targetWorkspaceId = ws.id;
  }

  try {
    const result = importWorkspace(db, body.export as ImportInput, {
      workspaceId: targetWorkspaceId,
      createWorkspace:
        body.mode === 'new' && body.new_workspace
          ? {
              name: body.new_workspace.name,
              slug: body.new_workspace.slug,
              icon: body.new_workspace.icon ?? null,
              description: body.new_workspace.description ?? null,
            }
          : undefined,
      tables: body.tables,
      includeTransient: body.include_transient ?? false,
      dryRun: body.dry_run ?? false,
    });
    return NextResponse.json({ ...result, dry_run: body.dry_run ?? false });
  } catch (err) {
    if (err instanceof ImportError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('[workspace-import] unexpected', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'import failed' },
      { status: 500 },
    );
  }
}
