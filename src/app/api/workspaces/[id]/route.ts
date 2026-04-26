import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import {
  deleteWorkspaceCascade,
  getWorkspaceCascadeCounts,
} from '@/lib/db/workspaces';
import { resolveWorkspacePath } from '@/lib/config';

export const dynamic = 'force-dynamic';
// GET /api/workspaces/[id] - Get a single workspace
//   Optional query: ?counts=true → also include cascade row counts
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const wantCounts = request.nextUrl.searchParams.get('counts') === 'true';

  try {
    const db = getDb();

    // Try to find by ID or slug
    const workspace = db.prepare(
      'SELECT * FROM workspaces WHERE id = ? OR slug = ?'
    ).get(id, id) as
      | { id: string; slug: string; workspace_path?: string | null }
      | undefined;

    if (!workspace) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    // Resolved-default companion field. The settings UI uses it as the
    // input placeholder so the operator can see what the system would
    // pick if they leave the override blank.
    const default_workspace_path = resolveWorkspacePath(workspace.slug, null);

    if (wantCounts) {
      const cascadeCounts = getWorkspaceCascadeCounts(workspace.id);
      return NextResponse.json({ ...workspace, cascadeCounts, default_workspace_path });
    }

    return NextResponse.json({ ...workspace, default_workspace_path });
  } catch (error) {
    console.error('Failed to fetch workspace:', error);
    return NextResponse.json({ error: 'Failed to fetch workspace' }, { status: 500 });
  }
}

// PATCH /api/workspaces/[id] - Update a workspace
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await request.json();
    const { name, description, icon, workspace_path } = body;

    const db = getDb();

    // Check workspace exists
    const existing = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    if (!existing) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    // Build update query dynamically
    const updates: string[] = [];
    const values: unknown[] = [];

    if (name !== undefined) {
      updates.push('name = ?');
      values.push(name);
    }
    if (description !== undefined) {
      updates.push('description = ?');
      values.push(description);
    }
    if (icon !== undefined) {
      updates.push('icon = ?');
      values.push(icon);
    }
    if (workspace_path !== undefined) {
      // Empty-string clears the override and reverts to the env default;
      // any other value persists as the explicit path.
      updates.push('workspace_path = ?');
      const trimmed = typeof workspace_path === 'string' ? workspace_path.trim() : null;
      values.push(trimmed && trimmed.length > 0 ? trimmed : null);
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    db.prepare(`
      UPDATE workspaces SET ${updates.join(', ')} WHERE id = ?
    `).run(...values);

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    return NextResponse.json(workspace);
  } catch (error) {
    console.error('Failed to update workspace:', error);
    return NextResponse.json({ error: 'Failed to update workspace' }, { status: 500 });
  }
}

// DELETE /api/workspaces/[id]
//
// Requires `?confirm=<workspace-name>` to actually delete (typed
// confirmation guard). Cascades through all workspace-scoped tables —
// see `deleteWorkspaceCascade` for the dependency walk.
//
// Refuses to delete the special `default` workspace and refuses to
// delete the *last* remaining workspace (operators always need at
// least one to land on).
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const confirm = request.nextUrl.searchParams.get('confirm');

  try {
    const db = getDb();

    if (id === 'default') {
      return NextResponse.json({ error: 'Cannot delete the default workspace' }, { status: 400 });
    }

    const existing = db.prepare('SELECT id, name FROM workspaces WHERE id = ?').get(id) as
      | { id: string; name: string }
      | undefined;

    if (!existing) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    // Block deleting the last workspace — operators always need at
    // least one container to drop into.
    const total = (db.prepare('SELECT COUNT(*) as c FROM workspaces').get() as { c: number }).c;
    if (total <= 1) {
      return NextResponse.json({
        error: 'Cannot delete the last remaining workspace',
      }, { status: 400 });
    }

    // Typed-name confirmation guard. The UI sends `?confirm=<name>`
    // after the operator types the workspace name into the modal.
    if (!confirm || confirm !== existing.name) {
      return NextResponse.json({
        error: 'Workspace name confirmation required',
        expected: existing.name,
      }, { status: 400 });
    }

    const counts = deleteWorkspaceCascade(id);

    return NextResponse.json({
      success: true,
      deleted: { id, name: existing.name },
      cascadeCounts: counts,
    });
  } catch (error) {
    console.error('Failed to delete workspace:', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to delete workspace',
    }, { status: 500 });
  }
}
