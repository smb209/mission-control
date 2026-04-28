/**
 * GET /api/workspaces/[id]/export
 *
 *   Optional query: ?include_transient=true → include mailbox / chat /
 *   sessions / agent health rows. Off by default (those grow large
 *   and are mostly noise for retention/reload purposes).
 *
 * Returns the workspace's full content as a single JSON document with
 * Content-Disposition set so a browser GET triggers a file download.
 * Same shape as `scripts/export-workspace.ts` (both share the lib at
 * src/lib/db/workspace-export.ts).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  exportWorkspace,
  defaultExportFilename,
  WorkspaceNotFoundError,
} from '@/lib/db/workspace-export';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const includeTransient =
    request.nextUrl.searchParams.get('include_transient') === 'true';

  try {
    const db = getDb();

    // Resolve slug → id so the route works for both. The export lib
    // requires the canonical workspace_id since that's what every
    // scoped table references.
    const workspace = db
      .prepare('SELECT id FROM workspaces WHERE id = ? OR slug = ?')
      .get(id, id) as { id: string } | undefined;
    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    const result = exportWorkspace(db, workspace.id, { includeTransient });
    const filename = defaultExportFilename(workspace.id, result.exported_at);

    return new NextResponse(JSON.stringify(result, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    const msg = err instanceof Error ? err.message : 'Export failed';
    console.error('[workspace-export] error:', err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
