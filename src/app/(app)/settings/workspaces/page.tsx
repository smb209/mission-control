'use client';

/**
 * Settings → Workspaces.
 *
 * Operator-facing list of every workspace with rename + delete actions.
 * Pairs with `/api/workspaces` (list + create), `PATCH /api/workspaces/[id]`
 * (rename), and `DELETE /api/workspaces/[id]?confirm=<name>` (typed-
 * confirmation cascade).
 *
 * The delete modal pulls a fresh count snapshot for the chosen
 * workspace from `GET /api/workspaces/[id]?counts=true` so the operator
 * sees an honest "this will delete X tasks, Y agents, …" warning before
 * confirming.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Pencil, Trash2, AlertTriangle, Plus, Settings as SettingsIcon, Folder } from 'lucide-react';
import {
  useCurrentWorkspaceId,
  useSetCurrentWorkspaceId,
} from '@/components/shell/workspace-context';
import { CreateWorkspaceDrawer } from '@/components/shell/CreateWorkspaceDrawer';
import type { WorkspaceStats } from '@/lib/types';
import type { WorkspaceCascadeCounts } from '@/lib/db/workspaces';

interface WorkspaceRow extends WorkspaceStats {
  created_at?: string;
}

export default function WorkspacesSettingsPage() {
  const router = useRouter();
  const currentWorkspaceId = useCurrentWorkspaceId();
  const setCurrentWorkspaceId = useSetCurrentWorkspaceId();

  const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<WorkspaceRow | null>(null);

  const reload = useMemo(() => async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/workspaces?stats=true');
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const data = (await res.json()) as WorkspaceRow[];
      setWorkspaces(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspaces');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <div className="min-h-full bg-mc-bg">
      {/* Page header */}
      <div className="border-b border-mc-border bg-mc-bg-secondary">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Folder className="w-6 h-6 text-mc-accent" />
            <div>
              <h1 className="text-xl font-bold text-mc-text">Workspaces</h1>
              <p className="text-xs text-mc-text-secondary">Manage workspaces, rename, or delete</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/settings"
              className="px-3 py-1.5 text-sm border border-mc-border rounded-sm hover:bg-mc-bg-tertiary text-mc-text-secondary flex items-center gap-1.5"
            >
              <SettingsIcon className="w-4 h-4" />
              General Settings
            </Link>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="px-3 py-1.5 text-sm bg-mc-accent text-mc-bg rounded-sm font-medium hover:bg-mc-accent/90 flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              New workspace
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-6">
        {error && (
          <div className="mb-4 p-3 rounded-sm bg-mc-accent-red/10 border border-mc-accent-red/30 text-sm text-mc-accent-red">
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-mc-text-secondary text-sm">Loading workspaces…</div>
        ) : workspaces.length === 0 ? (
          <div className="text-center py-12 border border-dashed border-mc-border rounded-sm">
            <Folder className="w-10 h-10 mx-auto text-mc-text-secondary mb-2" />
            <p className="text-sm text-mc-text-secondary">No workspaces yet.</p>
          </div>
        ) : (
          <div className="border border-mc-border rounded-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-mc-bg-tertiary border-b border-mc-border text-left">
                  <th className="px-4 py-2.5 text-mc-text-secondary font-medium">Workspace</th>
                  <th className="px-4 py-2.5 text-mc-text-secondary font-medium w-32">Tasks</th>
                  <th className="px-4 py-2.5 text-mc-text-secondary font-medium w-24">Agents</th>
                  <th className="px-4 py-2.5 text-mc-text-secondary font-medium w-32"></th>
                </tr>
              </thead>
              <tbody>
                {workspaces.map(ws => {
                  const isActive = ws.id === currentWorkspaceId;
                  const isDefault = ws.id === 'default';
                  return (
                    <tr key={ws.id} className="border-b border-mc-border last:border-0 hover:bg-mc-bg-tertiary/50">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <span className="text-xl shrink-0">{ws.icon ?? '📁'}</span>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <Link
                                href={`/workspace/${ws.slug}`}
                                onClick={() => setCurrentWorkspaceId(ws.id)}
                                className="font-medium text-mc-text hover:text-mc-accent truncate"
                              >
                                {ws.name}
                              </Link>
                              {isActive && (
                                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-mc-accent/20 text-mc-accent">
                                  Active
                                </span>
                              )}
                              {isDefault && (
                                <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-sm bg-mc-bg text-mc-text-secondary">
                                  Default
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-mc-text-secondary font-mono">/workspace/{ws.slug}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-mc-text-secondary">
                        {ws.taskCounts?.total ?? 0}
                      </td>
                      <td className="px-4 py-3 text-mc-text-secondary">
                        {ws.agentCount ?? 0}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => setRenaming({ id: ws.id, name: ws.name })}
                            className="px-2 py-1 text-xs rounded-sm border border-mc-border text-mc-text-secondary hover:bg-mc-bg-tertiary flex items-center gap-1"
                            title="Rename"
                          >
                            <Pencil className="w-3 h-3" />
                            Rename
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleting(ws)}
                            disabled={isDefault}
                            className="px-2 py-1 text-xs rounded-sm border border-mc-accent-red/40 text-mc-accent-red hover:bg-mc-accent-red/10 disabled:opacity-30 disabled:hover:bg-transparent flex items-center gap-1"
                            title={isDefault ? 'Cannot delete the default workspace' : 'Delete'}
                          >
                            <Trash2 className="w-3 h-3" />
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CreateWorkspaceDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => reload()}
      />

      {renaming && (
        <RenameModal
          workspaceId={renaming.id}
          currentName={renaming.name}
          onClose={() => setRenaming(null)}
          onSaved={() => {
            setRenaming(null);
            reload();
          }}
        />
      )}

      {deleting && (
        <DeleteModal
          workspace={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={async () => {
            const was = deleting;
            setDeleting(null);

            // If we just deleted the active workspace, switch the
            // shell context to the first remaining one and route
            // there so the nav doesn't point at a tombstone.
            if (was.id === currentWorkspaceId) {
              const remaining = workspaces.filter(w => w.id !== was.id);
              if (remaining.length > 0) {
                const next = remaining[0];
                setCurrentWorkspaceId(next.id);
                router.push(`/workspace/${next.slug}`);
                return;
              }
            }
            await reload();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rename modal
// ---------------------------------------------------------------------------

function RenameModal({
  workspaceId,
  currentName,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  currentName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(currentName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || name.trim() === currentName) {
      onClose();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Rename failed (${res.status})`);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed');
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-mc-bg-secondary border border-mc-border rounded-lg w-full max-w-md p-5">
        <h2 className="text-lg font-semibold mb-3">Rename workspace</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            autoFocus
            className="w-full px-3 py-2 bg-mc-bg border border-mc-border rounded-sm text-sm text-mc-text focus:border-mc-accent focus:outline-hidden"
          />
          {error && (
            <div className="p-2 rounded-sm bg-mc-accent-red/10 border border-mc-accent-red/30 text-xs text-mc-accent-red">
              {error}
            </div>
          )}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded-sm border border-mc-border text-mc-text-secondary hover:bg-mc-bg-tertiary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim() || name.trim() === currentName}
              className="px-3 py-1.5 text-sm rounded-sm bg-mc-accent text-mc-bg font-medium hover:bg-mc-accent/90 disabled:opacity-50"
            >
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete modal
// ---------------------------------------------------------------------------

function DeleteModal({
  workspace,
  onClose,
  onDeleted,
}: {
  workspace: WorkspaceRow;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [counts, setCounts] = useState<WorkspaceCascadeCounts | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workspaces/${workspace.id}?counts=true`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        if (data?.cascadeCounts) setCounts(data.cascadeCounts as WorkspaceCascadeCounts);
      })
      .catch(() => { /* surface via inline error if delete also fails */ });
    return () => { cancelled = true; };
  }, [workspace.id]);

  const matches = confirmText === workspace.name;

  async function handleDelete() {
    if (!matches) return;
    setSubmitting(true);
    setError(null);
    try {
      const url = `/api/workspaces/${workspace.id}?confirm=${encodeURIComponent(workspace.name)}`;
      const res = await fetch(url, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Delete failed (${res.status})`);
      }
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-mc-bg-secondary border border-mc-border rounded-lg w-full max-w-md p-5">
        <div className="flex items-start gap-3 mb-4">
          <div className="p-2 bg-mc-accent-red/15 rounded-full shrink-0">
            <AlertTriangle className="w-5 h-5 text-mc-accent-red" />
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">Delete workspace</h2>
            <p className="text-sm text-mc-text-secondary">
              Permanently destroy <span className="font-medium text-mc-text">{workspace.name}</span> and everything in it.
            </p>
          </div>
        </div>

        <div className="bg-mc-bg border border-mc-border rounded-sm p-3 mb-4 text-xs">
          <div className="text-mc-text-secondary mb-1">This will permanently delete:</div>
          {counts === null ? (
            <div className="text-mc-text-secondary">Loading counts…</div>
          ) : (
            <CascadeCountsList counts={counts} />
          )}
          <div className="mt-2 text-mc-accent-red text-[11px]">This cannot be undone.</div>
        </div>

        <label className="block text-xs uppercase tracking-wider text-mc-text-secondary mb-1">
          Type <span className="font-mono text-mc-text">{workspace.name}</span> to confirm
        </label>
        <input
          type="text"
          value={confirmText}
          onChange={e => setConfirmText(e.target.value)}
          placeholder={workspace.name}
          autoFocus
          className="w-full px-3 py-2 bg-mc-bg border border-mc-border rounded-sm text-sm text-mc-text font-mono focus:border-mc-accent focus:outline-hidden"
        />

        {error && (
          <div className="mt-3 p-2 rounded-sm bg-mc-accent-red/10 border border-mc-accent-red/30 text-xs text-mc-accent-red">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-sm border border-mc-border text-mc-text-secondary hover:bg-mc-bg-tertiary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={!matches || submitting}
            className="px-3 py-1.5 text-sm rounded-sm bg-mc-accent-red text-white font-medium hover:bg-mc-accent-red/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? 'Deleting…' : 'Delete forever'}
          </button>
        </div>
      </div>
    </div>
  );
}

function CascadeCountsList({ counts }: { counts: WorkspaceCascadeCounts }) {
  const rows: Array<[string, number]> = [
    ['Tasks', counts.tasks],
    ['Agents', counts.agents],
    ['Initiatives', counts.initiatives],
    ['Products', counts.products],
    ['Knowledge entries', counts.knowledgeEntries],
    ['Workflow templates', counts.workflowTemplates],
    ['PM proposals', counts.pmProposals],
    ['Cost events', counts.costEvents],
    ['Cost caps', counts.costCaps],
    ['Rollcall sessions', counts.rollcallSessions],
  ];
  const visible = rows.filter(([, n]) => n > 0);
  if (visible.length === 0) {
    return <div className="text-mc-text-secondary">Nothing — workspace is empty.</div>;
  }
  return (
    <ul className="space-y-0.5">
      {visible.map(([label, n]) => (
        <li key={label} className="flex items-center justify-between">
          <span className="text-mc-text-secondary">{label}</span>
          <span className="font-mono text-mc-text">{n}</span>
        </li>
      ))}
    </ul>
  );
}
