'use client';

/**
 * Per-workspace settings page. Inline-editable identity fields up top,
 * GitHub-style red Danger Zone at the bottom for destructive actions.
 *
 * Why this page exists separately from the global /settings:
 * /settings is for cross-workspace concerns (API URL, default paths,
 * database backups, kanban prefs). Each workspace owns its own
 * configuration too — name, icon, description, and the project root
 * where the gateway writes deliverables. Editing those used to live
 * on a workspace-picker table that took the operator back to the
 * task board on row click; now each workspace links here directly
 * from the left-nav Settings entry, scoped to whichever workspace
 * the switcher has selected.
 */

import { useEffect, useState, use, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  Download,
  Folder,
  Loader,
  Trash2,
} from 'lucide-react';
import {
  InlineText,
  InlineTextarea,
} from '@/components/inline/InlineEdit';
import {
  useCurrentWorkspaceId,
  useSetCurrentWorkspaceId,
} from '@/components/shell/workspace-context';
import type { WorkspaceCascadeCounts } from '@/lib/db/workspaces';

interface WorkspaceWithDefault {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  icon: string;
  workspace_path?: string | null;
  /** Server-resolved default the override falls back to. */
  default_workspace_path: string;
  created_at: string;
  updated_at: string;
}

export default function WorkspaceSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const router = useRouter();
  const currentWorkspaceId = useCurrentWorkspaceId();
  const setCurrentWorkspaceId = useSetCurrentWorkspaceId();

  const [workspace, setWorkspace] = useState<WorkspaceWithDefault | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [includeTransient, setIncludeTransient] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(slug)}`);
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const data = (await res.json()) as WorkspaceWithDefault;
      setWorkspace(data);
      // Sync the workspace context if the operator landed here via a
      // direct link with a different active workspace.
      if (data.id && data.id !== currentWorkspaceId) {
        setCurrentWorkspaceId(data.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load workspace');
    } finally {
      setLoading(false);
    }
    // currentWorkspaceId intentionally omitted: re-fetching every time
    // the operator switches workspace would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      if (!workspace) return;
      const res = await fetch(`/api/workspaces/${workspace.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Update failed (${res.status})`);
      }
      await refresh();
    },
    [workspace, refresh],
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-mc-bg flex items-center justify-center">
        <Loader className="w-6 h-6 animate-spin text-mc-text-secondary" />
      </div>
    );
  }
  if (error || !workspace) {
    return (
      <div className="min-h-screen bg-mc-bg p-6">
        <div className="max-w-3xl mx-auto p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
          {error || 'Workspace not found'}
        </div>
      </div>
    );
  }

  const isDefault = workspace.id === 'default';

  const exportWorkspace = async () => {
    if (!workspace || exporting) return;
    setExporting(true);
    setActionError(null);
    try {
      const url = `/api/workspaces/${workspace.id}/export${
        includeTransient ? '?include_transient=true' : ''
      }`;
      const res = await fetch(url);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Export failed (${res.status})`);
      }
      // Honor the Content-Disposition filename from the server.
      const blob = await res.blob();
      const disp = res.headers.get('Content-Disposition') ?? '';
      const m = disp.match(/filename="([^"]+)"/);
      const filename =
        m?.[1] ?? `mc-workspace-${workspace.id}-${new Date().toISOString()}.json`;
      const a = document.createElement('a');
      const objectUrl = URL.createObjectURL(blob);
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="min-h-screen bg-mc-bg text-mc-text">
      <div className="max-w-3xl mx-auto p-6">
        <div className="mb-4 flex items-center gap-2 text-sm">
          <Link
            href={`/workspace/${workspace.slug}`}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-mc-text-secondary hover:text-mc-text"
          >
            <ArrowLeft className="w-4 h-4" /> Back to workspace
          </Link>
        </div>

        <header className="mb-6 p-5 rounded-lg bg-mc-bg-secondary border border-mc-border">
          <div className="flex items-start gap-3">
            <span className="text-3xl shrink-0">{workspace.icon}</span>
            <div className="flex-1 min-w-0">
              <h1 className="text-xl font-semibold">{workspace.name}</h1>
              <div className="text-xs text-mc-text-secondary font-mono">
                /workspace/{workspace.slug}
              </div>
            </div>
          </div>
        </header>

        {actionError && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
            {actionError}
          </div>
        )}

        {/* Identity */}
        <Section title="Identity">
          <Field label="Name">
            <InlineText
              value={workspace.name}
              onSave={next => patch({ name: next })}
              className="text-mc-text font-medium"
              placeholder="Untitled workspace"
              label="Edit workspace name"
            />
          </Field>
          <Field label="Icon">
            <InlineText
              value={workspace.icon}
              onSave={next => patch({ icon: next || '📁' })}
              className="text-2xl"
              placeholder="📁"
              label="Edit workspace icon"
            />
          </Field>
          <Field label="Description">
            <InlineTextarea
              value={workspace.description ?? ''}
              onSave={next =>
                patch({ description: next.length > 0 ? next : null })
              }
              placeholder="What is this workspace for?"
              minRows={3}
              label="Edit workspace description"
            />
          </Field>
        </Section>

        {/* Path */}
        <Section
          title="Project root"
          description={
            <>
              Directory where deliverables and project files live for this
              workspace. Leave blank to use the resolved default — the
              system picks{' '}
              <code className="text-mc-text">MC_DELIVERABLES_HOST_PATH</code>{' '}
              first (so gateway agents writing on the host find the right
              folder), then{' '}
              <code className="text-mc-text">
                MC_DELIVERABLES_CONTAINER_PATH
              </code>
              ,{' '}
              <code className="text-mc-text">PROJECTS_PATH</code>, and finally
              falls back to{' '}
              <code className="text-mc-text">~/Documents/Shared/projects</code>
              .
            </>
          }
        >
          <Field label="Workspace path">
            <InlineText
              value={workspace.workspace_path ?? ''}
              onSave={next => patch({ workspace_path: next })}
              placeholder={workspace.default_workspace_path}
              label="Edit workspace path"
            />
            <p className="text-[11px] text-mc-text-secondary mt-1">
              Effective path:{' '}
              <code className="text-mc-text">
                {workspace.workspace_path && workspace.workspace_path.trim().length > 0
                  ? workspace.workspace_path
                  : workspace.default_workspace_path}
              </code>
              {!workspace.workspace_path && (
                <span className="ml-2 text-mc-text-secondary/70">
                  (resolved default — clear or untouched override)
                </span>
              )}
            </p>
          </Field>
        </Section>

        {/* Export — read-only snapshot of every workspace-scoped row,
            useful for retaining state before a reset or copying a real
            workspace into a checkpoint. Backed by the same lib the CLI
            script uses (src/lib/db/workspace-export.ts). */}
        <Section
          title="Export"
          description="Download a JSON snapshot of every initiative, task, agent, proposal, knowledge entry, and supporting row attached to this workspace. Useful for retention before a database reset or for staging an import elsewhere."
        >
          <div className="flex items-start justify-between gap-3">
            <label className="flex items-center gap-2 text-xs text-mc-text-secondary">
              <input
                type="checkbox"
                checked={includeTransient}
                onChange={e => setIncludeTransient(e.target.checked)}
                className="accent-mc-accent"
              />
              Include transient rows
              <span className="text-mc-text-secondary/60">
                (mailbox, chat, sessions — large, mostly noise)
              </span>
            </label>
            <button
              type="button"
              onClick={exportWorkspace}
              disabled={exporting}
              className="px-3 py-1.5 text-sm rounded border border-mc-border text-mc-text hover:bg-mc-bg-tertiary disabled:opacity-40 inline-flex items-center gap-1.5 shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              {exporting ? 'Exporting…' : 'Export workspace'}
            </button>
          </div>
        </Section>

        {/* Danger Zone — GitHub-style. Red border, destructive actions
            grouped at the bottom of the page so they're never the first
            thing the operator clicks. Delete is the only one for now;
            the rename action lives inline above (no separate row needed
            — InlineText handles it). */}
        <section className="mt-10 rounded-lg border border-red-500/40 bg-red-500/5">
          <header className="px-5 py-3 border-b border-red-500/30">
            <h2 className="text-sm font-semibold text-red-300 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> Danger Zone
            </h2>
          </header>
          <div className="px-5 py-4 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-mc-text">
                Delete this workspace
              </h3>
              <p className="text-xs text-mc-text-secondary mt-0.5">
                Permanently removes this workspace and every task, agent,
                initiative, and deliverable record attached to it. Files on
                disk under{' '}
                <code className="text-mc-text">
                  {workspace.workspace_path ?? workspace.default_workspace_path}
                </code>{' '}
                are not touched.
                {isDefault && (
                  <span className="block mt-1 text-amber-300">
                    The default workspace cannot be deleted.
                  </span>
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowDelete(true)}
              disabled={isDefault}
              className="px-3 py-1.5 text-sm rounded border border-red-500/40 text-red-200 hover:bg-red-500/10 disabled:opacity-30 disabled:hover:bg-transparent inline-flex items-center gap-1.5 shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete workspace
            </button>
          </div>
        </section>
      </div>

      {showDelete && (
        <DeleteModal
          workspace={workspace}
          onClose={() => setShowDelete(false)}
          onDeleted={async () => {
            setShowDelete(false);
            // If we just deleted the active workspace, switch to whichever
            // is left and route back to its task board.
            try {
              const r = await fetch('/api/workspaces');
              const list = (await r.json()) as Array<{ id: string; slug: string }>;
              if (list.length > 0) {
                setCurrentWorkspaceId(list[0].id);
                router.replace(`/workspace/${list[0].slug}`);
              } else {
                router.replace('/');
              }
            } catch {
              router.replace('/');
            }
          }}
        />
      )}
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6 rounded-lg border border-mc-border bg-mc-bg-secondary">
      <header className="px-5 py-3 border-b border-mc-border/60">
        <h2 className="text-sm font-semibold text-mc-text">{title}</h2>
        {description && (
          <p className="text-xs text-mc-text-secondary mt-1">{description}</p>
        )}
      </header>
      <div className="px-5 py-4 space-y-4">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-mc-text-secondary/70 mb-1">
        {label}
      </div>
      {children}
    </div>
  );
}

/**
 * Typed-confirmation delete modal. Same shape as the previous one in
 * /settings/workspaces — pulls live cascade counts from the API so the
 * operator sees an honest "this will delete X tasks, Y agents, …"
 * before they confirm by typing the workspace name.
 */
function DeleteModal({
  workspace,
  onClose,
  onDeleted,
}: {
  workspace: WorkspaceWithDefault;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [counts, setCounts] = useState<WorkspaceCascadeCounts | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workspaces/${workspace.id}?counts=true`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled && data?.cascadeCounts) {
          setCounts(data.cascadeCounts as WorkspaceCascadeCounts);
        }
      })
      .catch(() => {
        /* surface via inline error if delete also fails */
      });
    return () => {
      cancelled = true;
    };
  }, [workspace.id]);

  const canConfirm = confirmText.trim() === workspace.name;
  const submit = async () => {
    if (!canConfirm) return;
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/workspaces/${workspace.id}?confirm=${encodeURIComponent(workspace.name)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Delete failed (${res.status})`);
      }
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Delete failed');
      setSubmitting(false);
    }
  };

  const cascadeRows: Array<{ label: string; count: number }> = counts
    ? [
        { label: 'tasks', count: counts.tasks },
        { label: 'agents', count: counts.agents },
        { label: 'initiatives', count: counts.initiatives },
        { label: 'PM proposals', count: counts.pmProposals },
        { label: 'products', count: counts.products },
        { label: 'knowledge entries', count: counts.knowledgeEntries },
        { label: 'workflow templates', count: counts.workflowTemplates },
        { label: 'cost events', count: counts.costEvents },
      ].filter(r => r.count > 0)
    : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-mc-bg-secondary border border-mc-border rounded-lg w-full max-w-lg p-5">
        <h2 className="text-lg font-semibold mb-2 text-red-300 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> Delete workspace
        </h2>
        <p className="text-sm text-mc-text-secondary mb-4">
          You're about to permanently delete{' '}
          <strong className="text-mc-text">{workspace.name}</strong>. This
          cannot be undone.
        </p>

        {cascadeRows.length > 0 && (
          <div className="mb-4 rounded-sm border border-mc-border bg-mc-bg p-3 text-xs">
            <div className="text-mc-text-secondary uppercase tracking-wide text-[10px] mb-2">
              Will cascade-delete
            </div>
            <ul className="space-y-1">
              {cascadeRows.map(r => (
                <li key={r.label} className="flex justify-between">
                  <span className="text-mc-text">{r.label}</span>
                  <span className="font-mono text-mc-text-secondary">{r.count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <label className="block">
          <span className="text-xs text-mc-text-secondary">
            Type{' '}
            <code className="text-mc-text">{workspace.name}</code> to confirm:
          </span>
          <input
            type="text"
            autoFocus
            value={confirmText}
            onChange={e => setConfirmText(e.target.value)}
            className="mt-1 w-full px-3 py-2 bg-mc-bg border border-mc-border rounded-sm text-sm text-mc-text focus:border-red-500/60 focus:outline-hidden"
          />
        </label>

        {err && (
          <div className="mt-3 p-2 rounded-sm bg-red-500/10 border border-red-500/30 text-xs text-red-300">
            {err}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-sm rounded border border-mc-border text-mc-text-secondary hover:bg-mc-bg-tertiary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canConfirm || submitting}
            className="px-3 py-1.5 text-sm rounded bg-red-500/20 border border-red-500/40 text-red-200 hover:bg-red-500/30 disabled:opacity-30 inline-flex items-center gap-1.5"
          >
            <Folder className="w-3.5 h-3.5" />
            {submitting ? 'Deleting…' : 'Delete forever'}
          </button>
        </div>
      </div>
    </div>
  );
}
