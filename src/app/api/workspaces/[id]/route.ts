import { NextRequest, NextResponse } from 'next/server';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb } from '@/lib/db';
import {
  deleteWorkspaceCascade,
  getWorkspaceCascadeCounts,
  AUDIT_PER_NODE_TIMEOUT_MS_MIN,
  AUDIT_PER_NODE_TIMEOUT_MS_MAX,
  AUDIT_SUBTREE_CONCURRENCY_MIN,
  AUDIT_SUBTREE_CONCURRENCY_MAX,
} from '@/lib/db/workspaces';
import { resolveWorkspacePath } from '@/lib/config';
import { hostPathToContainerPath } from '@/lib/deliverables/storage';

const execFileAsync = promisify(execFile);

/**
 * Initialize a git repo at `workspacePath` if one isn't already there.
 * Idempotent — when `.git/` already exists this is a silent no-op.
 *
 * Path resolution: `workspacePath` is stored as the **host** path
 * (that's what host-side gateway agents use to find the working tree).
 * When MC runs in Docker, the host path isn't valid inside the
 * container, so we translate via `hostPathToContainerPath` (which uses
 * the bind mount declared via `MC_DELIVERABLES_HOST_PATH` /
 * `MC_DELIVERABLES_CONTAINER_PATH`). When MC runs natively (dev), the
 * translator returns the input unchanged. The resulting `.git/` is
 * visible on the host because the directory is bind-mounted in.
 *
 * Returns a structured result so the route can surface non-blocking
 * warnings; failure does NOT abort the workspace save (the operator's
 * primary intent — setting fields — has already succeeded by this point).
 *
 * See specs/workspace-conventions-structured.md §5.
 */
async function ensureLocalRepo(
  workspacePath: string,
): Promise<{
  status: 'noop' | 'initialized' | 'error';
  message?: string;
  /** When the path was translated (host → container), the value MC
   *  actually executed against. Surfaced for operator sanity-check. */
  effective_cwd?: string;
}> {
  if (!workspacePath || !workspacePath.trim()) {
    return { status: 'error', message: 'workspace_path is empty; cannot init git here' };
  }
  // Translate host → container if MC is dockerized AND the path is
  // under the declared bind mount. When MC runs natively this is a
  // no-op (host root === container root).
  const effectivePath = hostPathToContainerPath(workspacePath);
  if (!existsSync(effectivePath)) {
    return {
      status: 'error',
      message:
        effectivePath === workspacePath
          ? `workspace_path '${workspacePath}' does not exist on disk`
          : `workspace_path '${workspacePath}' (translated to '${effectivePath}' inside MC) does not exist on disk — is the bind mount configured?`,
      effective_cwd: effectivePath,
    };
  }
  if (existsSync(join(effectivePath, '.git'))) {
    return { status: 'noop', effective_cwd: effectivePath };
  }
  try {
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: effectivePath });
    return { status: 'initialized', effective_cwd: effectivePath };
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
      effective_cwd: effectivePath,
    };
  }
}

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
    const {
      name,
      description,
      icon,
      workspace_path,
      context_md,
      audit_per_node_timeout_ms,
      audit_subtree_concurrency,
      local_repo_init,
      repo_url,
      default_base_branch,
    } = body;

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
    if (context_md !== undefined) {
      // Markdown blob holding the operator's "rules of the road" for
      // dispatched agents. Read at task dispatch time and prepended as
      // a "## Workspace conventions" block. Empty string clears it.
      updates.push('context_md = ?');
      const trimmed = typeof context_md === 'string' ? context_md : null;
      values.push(trimmed && trimmed.length > 0 ? trimmed : null);
    }

    if (audit_per_node_timeout_ms !== undefined) {
      const n = Number(audit_per_node_timeout_ms);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return NextResponse.json(
          { error: 'audit_per_node_timeout_ms must be an integer (ms)' },
          { status: 400 },
        );
      }
      if (n < AUDIT_PER_NODE_TIMEOUT_MS_MIN || n > AUDIT_PER_NODE_TIMEOUT_MS_MAX) {
        return NextResponse.json(
          {
            error: `audit_per_node_timeout_ms must be between ${AUDIT_PER_NODE_TIMEOUT_MS_MIN} and ${AUDIT_PER_NODE_TIMEOUT_MS_MAX} ms (1–60 minutes)`,
          },
          { status: 400 },
        );
      }
      updates.push('audit_per_node_timeout_ms = ?');
      values.push(n);
    }
    if (local_repo_init !== undefined) {
      // Boolean stored as INTEGER (0/1) per the migration.
      updates.push('local_repo_init = ?');
      values.push(local_repo_init ? 1 : 0);
    }
    if (repo_url !== undefined) {
      // Empty string clears the field; any other value persists trimmed.
      const trimmed = typeof repo_url === 'string' ? repo_url.trim() : null;
      updates.push('repo_url = ?');
      values.push(trimmed && trimmed.length > 0 ? trimmed : null);
    }
    if (default_base_branch !== undefined) {
      const trimmed = typeof default_base_branch === 'string' ? default_base_branch.trim() : null;
      updates.push('default_base_branch = ?');
      values.push(trimmed && trimmed.length > 0 ? trimmed : null);
    }
    if (audit_subtree_concurrency !== undefined) {
      const n = Number(audit_subtree_concurrency);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return NextResponse.json(
          { error: 'audit_subtree_concurrency must be an integer' },
          { status: 400 },
        );
      }
      if (n < AUDIT_SUBTREE_CONCURRENCY_MIN || n > AUDIT_SUBTREE_CONCURRENCY_MAX) {
        return NextResponse.json(
          {
            error: `audit_subtree_concurrency must be between ${AUDIT_SUBTREE_CONCURRENCY_MIN} and ${AUDIT_SUBTREE_CONCURRENCY_MAX}`,
          },
          { status: 400 },
        );
      }
      updates.push('audit_subtree_concurrency = ?');
      values.push(n);
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    updates.push("updated_at = datetime('now')");
    values.push(id);

    db.prepare(`
      UPDATE workspaces SET ${updates.join(', ')} WHERE id = ?
    `).run(...values);

    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
      | { workspace_path?: string | null; slug: string; local_repo_init?: number }
      | undefined;

    // Local-repo init: when the operator just flipped the checkbox on
    // (or had it on already and is re-saving), ensure the working tree
    // has a git repo. Idempotent. Failures surface as a non-blocking
    // warning — the workspace save itself has already succeeded.
    let localRepoInit: { status: string; message?: string } | undefined;
    if (
      local_repo_init !== undefined &&
      local_repo_init &&
      workspace
    ) {
      const effectivePath =
        (workspace.workspace_path && workspace.workspace_path.trim()) ||
        resolveWorkspacePath(workspace.slug, null);
      localRepoInit = await ensureLocalRepo(effectivePath);
    }

    return NextResponse.json(
      localRepoInit ? { ...workspace, local_repo_init_result: localRepoInit } : workspace,
    );
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
