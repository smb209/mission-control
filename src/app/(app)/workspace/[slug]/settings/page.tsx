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
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  Download,
  Folder,
  GitBranch,
  Loader,
  Loader2,
  Sparkles,
  Trash2,
  Upload,
  FilePlus,
  X,
} from 'lucide-react';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  resolveVariables,
  inventoryVariables,
  type VariableSource,
} from '@/lib/workspace-conventions/resolve-variables';
import {
  InlineText,
  InlineTextarea,
} from '@/components/inline/InlineEdit';
import {
  useCurrentWorkspaceId,
  useSetCurrentWorkspaceId,
} from '@/components/shell/workspace-context';
import { PageWithRails, SectionNav } from '@/components/shell/PageWithRails';
import type { WorkspaceCascadeCounts } from '@/lib/db/workspaces';

interface WorkspaceWithDefault {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  icon: string;
  workspace_path?: string | null;
  /** Markdown rules-of-the-road prepended to every dispatched task's prompt.
   *  v0 of org-scope memory grounding — see docs/specs and the
   *  Ground-agents theme on the roadmap. */
  context_md?: string | null;
  /** Initiative-audit knobs. Migration 079 / specs/initiative-investigate.md. */
  audit_per_node_timeout_ms?: number | null;
  audit_subtree_concurrency?: number | null;
  /** Server-resolved default the override falls back to. */
  default_workspace_path: string;
  /** When true, the PATCH route runs `git init` in workspace_path on save.
   *  Idempotent. See specs/workspace-conventions-structured.md §5. */
  local_repo_init?: number | null;
  /** Optional remote (e.g. https://github.com/owner/repo). Drives PR
   *  targeting guidance in the conventions prompt and a UI chip. */
  repo_url?: string | null;
  /** Default base branch for PRs (e.g. main). */
  default_base_branch?: string | null;
  /** Operator-overridden display timezone (IANA name). NULL means
   *  "auto-detect from browser". See specs/timestamp-handling.md §PR-B. */
  display_timezone?: string | null;
  /** Whether the floating bottom-right ChatWidget renders. Stored as
   *  0/1 INTEGER in SQLite; default 0 (off). Migration 088. */
  show_chat_widget?: number | boolean | null;
  created_at: string;
  updated_at: string;
}

interface WorkspaceTemplate {
  slug: string;
  title: string;
  description: string;
  intended_for: string;
  body: string;
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
  // Live keystroke draft for the conventions textarea so the right-rail
  // preview updates as the operator types — `null` means "use saved value".
  const [conventionsDraft, setConventionsDraft] = useState<string | null>(null);
  const [templates, setTemplates] = useState<WorkspaceTemplate[]>([]);
  const [pendingTemplate, setPendingTemplate] = useState<WorkspaceTemplate | null>(null);
  const [localRepoInitNotice, setLocalRepoInitNotice] = useState<string | null>(null);
  const [refineModalOpen, setRefineModalOpen] = useState(false);

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

  // One-shot fetch of starter templates so the dropdown isn't empty on
  // first paint. The list is small and rarely-changes; no re-fetch.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/workspace-templates')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setTemplates(data.templates ?? []);
      })
      .catch((err) => {
        console.warn('[settings] template list failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      // The PATCH route returns a `local_repo_init_result` envelope when
      // a `git init` was attempted on save. Surface it as an inline
      // notice — non-blocking; the field has already saved.
      try {
        const data = await res.json();
        if (data?.local_repo_init_result) {
          const r = data.local_repo_init_result as {
            status: string;
            message?: string;
            effective_cwd?: string;
          };
          // When MC is dockerized, effective_cwd is the container path
          // (the host path is bind-mounted in). Mention it in the
          // notice so operators can sanity-check the mapping.
          const cwdSuffix =
            r.effective_cwd && r.effective_cwd !== (workspace?.workspace_path ?? '')
              ? ` (mapped to ${r.effective_cwd} inside MC)`
              : '';
          if (r.status === 'initialized') {
            setLocalRepoInitNotice(`Initialized a local git repo in the working tree${cwdSuffix}.`);
          } else if (r.status === 'noop') {
            setLocalRepoInitNotice(`Working tree already has a git repo — no init needed${cwdSuffix}.`);
          } else {
            setLocalRepoInitNotice(`git init skipped: ${r.message ?? 'unknown error'}`);
          }
        }
      } catch {
        /* response wasn't JSON — fine; field still saved */
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

  const sections = [
    { id: 'identity', label: 'Identity' },
    { id: 'project-root', label: 'Project root' },
    { id: 'source-control', label: 'Source control' },
    { id: 'conventions', label: 'Workspace conventions' },
    { id: 'ui', label: 'UI' },
    { id: 'audit-defaults', label: 'Audit defaults' },
    { id: 'export', label: 'Export' },
    { id: 'import', label: 'Import' },
    { id: 'danger-zone', label: 'Danger zone' },
  ];

  // Effective working dir for variable substitution previews — same
  // resolution the PATCH route uses on save.
  const effectiveWorkingDir =
    (workspace.workspace_path && workspace.workspace_path.trim()) ||
    workspace.default_workspace_path;
  const variableSrc: VariableSource = {
    name: workspace.name,
    working_dir: effectiveWorkingDir,
    deliverables: effectiveWorkingDir,
    repo_url: workspace.repo_url ?? null,
    base_branch: workspace.default_base_branch ?? null,
  };

  // No top header here: the Identity section below already shows the
  // workspace's name + icon + description, and the global left nav
  // already provides navigation back out — a sticky breadcrumb on top
  // was just cropping the form column on narrow viewports.

  return (
    <PageWithRails
      leftRail={<SectionNav sections={sections} />}
      collapsibleLeftRail
      leftRailStorageKey="mc:workspace:settings:rail"
      // Defer the 3-col layout until xl (1280px). At lg the right rail
      // ate so much horizontal room that the center column squashed
      // text per-character and the right rail visually overlapped the
      // form fields.
      rightRailMinViewport="xl"
      rightRail={
        <AgentPromptPreview
          contextMd={conventionsDraft ?? workspace.context_md ?? ''}
          dirty={conventionsDraft !== null && conventionsDraft !== (workspace.context_md ?? '')}
          variableSrc={variableSrc}
        />
      }
      rightRailTitle="Agent prompt preview"
    >
      <>
        {actionError && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
            {actionError}
          </div>
        )}

        {/* Identity */}
        <Section id="identity" title="Identity">
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
          id="project-root"
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

        {/* Source control — repo metadata + local-repo-init. Drives the
            {{repo_url}} / {{base_branch}} variables and the "always
            target this remote" rule in the dispatched prompt. See
            specs/workspace-conventions-structured.md §2 / §5. */}
        <Section
          id="source-control"
          title="Source control"
          description={
            <>
              Optional repository metadata for <code className="text-mc-text">{`{{repo_url}}`}</code>
              {' '}and <code className="text-mc-text">{`{{base_branch}}`}</code> in the conventions
              text. Even folder-only workspaces benefit from local git history —
              tick the checkbox below to <code className="text-mc-text">git init</code>{' '}
              the working tree on save (idempotent).
            </>
          }
        >
          <Field label="Repo URL">
            <InlineText
              value={workspace.repo_url ?? ''}
              onSave={(next) => patch({ repo_url: next.trim() })}
              placeholder="https://github.com/owner/repo (optional)"
              label="Edit repo URL"
            />
            <p className="text-[11px] text-mc-text-secondary mt-1">
              Used by <code className="text-mc-text">{`{{repo_url}}`}</code>. Leave
              blank for folder-only workspaces.
            </p>
          </Field>
          <Field label="Default base branch">
            <InlineText
              value={workspace.default_base_branch ?? ''}
              onSave={(next) => patch({ default_base_branch: next.trim() })}
              placeholder="main"
              label="Edit default base branch"
            />
            <p className="text-[11px] text-mc-text-secondary mt-1">
              Used by <code className="text-mc-text">{`{{base_branch}}`}</code>.
            </p>
          </Field>
          <Field label="Initialize local git repo">
            <label className="inline-flex items-center gap-2 text-sm text-mc-text cursor-pointer">
              <input
                type="checkbox"
                checked={!!workspace.local_repo_init}
                onChange={(e) => patch({ local_repo_init: e.target.checked })}
                aria-label="Initialize local git repo"
              />
              <span>
                <GitBranch className="w-3.5 h-3.5 inline-block mr-1 align-text-bottom" />
                Run <code className="text-mc-text">git init</code> in{' '}
                <code className="text-mc-text">{effectiveWorkingDir}</code> on save
              </span>
            </label>
            {localRepoInitNotice && (
              <p className="text-[11px] text-mc-text-secondary mt-1">
                {localRepoInitNotice}
              </p>
            )}
          </Field>
        </Section>

        {/* Workspace conventions — rules-of-the-road prepended to every
            dispatched agent's task prompt. v0 of org-scope memory
            grounding (precursor to the memory-layer epic). Operator
            writes once and every dispatched mc-builder / mc-coordinator
            inherits the workspace's testing / git / package-manager /
            push rules without having to rediscover them per task. */}
        <Section
          id="conventions"
          title="Workspace conventions"
          description={
            <>
              Markdown that gets prepended to every dispatched task&apos;s
              prompt as a <code className="text-mc-text">## Workspace conventions</code>
              {' '}block. Use{' '}
              <code className="text-mc-text">{`{{name}}`}</code>,{' '}
              <code className="text-mc-text">{`{{working_dir}}`}</code>,{' '}
              <code className="text-mc-text">{`{{deliverables}}`}</code>,{' '}
              <code className="text-mc-text">{`{{repo_url}}`}</code>,{' '}
              <code className="text-mc-text">{`{{base_branch}}`}</code> — they
              expand at dispatch time. Leave blank to skip the block entirely.
            </>
          }
        >
          {templates.length > 0 && (
            <Field label="Start from a template">
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="px-2 py-1 rounded border border-mc-border bg-mc-bg text-sm text-mc-text"
                  defaultValue=""
                  onChange={(e) => {
                    const slug = e.target.value;
                    if (!slug) return;
                    const tpl = templates.find((t) => t.slug === slug);
                    if (!tpl) return;
                    const current = (conventionsDraft ?? workspace.context_md ?? '').trim();
                    if (current.length > 0) {
                      // Confirm before overwriting hand-written content.
                      setPendingTemplate(tpl);
                    } else {
                      patch({ context_md: tpl.body.length > 0 ? tpl.body : null });
                      setConventionsDraft(tpl.body);
                    }
                    e.target.value = '';
                  }}
                  aria-label="Insert a starter template"
                >
                  <option value="" disabled>
                    Choose a template…
                  </option>
                  {templates.map((tpl) => (
                    <option key={tpl.slug} value={tpl.slug}>
                      {tpl.title}
                    </option>
                  ))}
                </select>
                <span className="text-[11px] text-mc-text-secondary">
                  <FilePlus className="w-3 h-3 inline-block mr-1 align-text-bottom" />
                  Templates are starter markdown — edit freely after inserting.
                </span>
              </div>
            </Field>
          )}
          <Field label="Conventions (markdown)">
            <InlineTextarea
              value={workspace.context_md ?? ''}
              onSave={next =>
                patch({ context_md: next.length > 0 ? next : null })
              }
              placeholder={`## Repos\n- Working tree: {{working_dir}}\n\n## Testing\n- ...\n\n## Git rules\n- Never push to main\n`}
              minRows={8}
              label="Edit workspace conventions"
              onDraftChange={setConventionsDraft}
            />
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setRefineModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs border border-mc-border hover:bg-mc-surface-hover text-mc-text"
                aria-label="Refine conventions with an agent"
              >
                <Sparkles className="w-3 h-3" />
                Refine with agent
              </button>
              <span className="ml-2 text-[11px] text-mc-text-secondary">
                Hand the current text to a writer agent and get a proposed
                rewrite or follow-up questions.
              </span>
            </div>
          </Field>
        </Section>

        <ConfirmDialog
          open={pendingTemplate !== null}
          title="Replace existing conventions?"
          body={
            <p className="text-sm text-mc-text">
              Inserting <strong>{pendingTemplate?.title ?? 'this template'}</strong>{' '}
              will replace the conventions you have written so far. The current
              text isn&apos;t saved anywhere; it will be lost.
            </p>
          }
          confirmLabel="Replace"
          destructive
          onConfirm={() => {
            const tpl = pendingTemplate;
            setPendingTemplate(null);
            if (!tpl) return;
            patch({ context_md: tpl.body.length > 0 ? tpl.body : null });
            setConventionsDraft(tpl.body);
          }}
          onCancel={() => setPendingTemplate(null)}
        />

        {refineModalOpen && (
          <RefineModal
            workspaceId={workspace.id}
            currentConventions={conventionsDraft ?? workspace.context_md ?? ''}
            onClose={() => setRefineModalOpen(false)}
            onAccept={(replacement) => {
              setRefineModalOpen(false);
              patch({ context_md: replacement.length > 0 ? replacement : null });
              setConventionsDraft(replacement);
            }}
          />
        )}

        {/* Display — operator-facing presentation knobs. Most of MC
            is timezone-aware via the browser's Intl auto-detect; this
            override is for the cases where that's wrong (e.g. running
            on a UTC server in a non-UTC location). See
            specs/timestamp-handling.md §PR-B. */}
        <Section
          id="display"
          title="Display"
          description="How the operator sees timestamps. The default — auto-detect from your browser — is right for ~all cases; override only if it's wrong."
        >
          <Field label="Display timezone">
            <InlineText
              value={workspace.display_timezone ?? ''}
              onSave={async (next) => {
                // Empty / whitespace clears the override (revert to
                // auto-detect). Server validates IANA names.
                await patch({ display_timezone: next.trim() });
              }}
              placeholder={(() => {
                try {
                  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles';
                } catch {
                  return 'America/Los_Angeles';
                }
              })()}
              label="Edit display timezone"
            />
            <p className="text-[11px] text-mc-text-secondary mt-1">
              IANA name (e.g. <code className="text-mc-text">America/Los_Angeles</code>,{' '}
              <code className="text-mc-text">America/New_York</code>,{' '}
              <code className="text-mc-text">Europe/London</code>,{' '}
              <code className="text-mc-text">Asia/Tokyo</code>). Leave
              blank to use your browser&apos;s detected zone (
              <code className="text-mc-text">
                {(() => {
                  try {
                    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown';
                  } catch {
                    return 'unknown';
                  }
                })()}
              </code>
              ). Reload after saving for the change to apply everywhere.
            </p>
          </Field>
        </Section>

        {/* UI — workspace-scoped presentation toggles. Today this just
            owns the floating chat widget visibility; the operator
            reported never using it, so it's gated rather than always-on. */}
        <Section
          id="ui"
          title="UI"
          description="Workspace-scoped UI toggles."
        >
          <Field label="Show chat widget">
            <label className="inline-flex items-center gap-2 text-sm text-mc-text cursor-pointer">
              <input
                type="checkbox"
                checked={!!workspace.show_chat_widget}
                onChange={(e) => patch({ show_chat_widget: e.target.checked })}
                aria-label="Show chat widget"
              />
              <span>Render the floating chat icon</span>
            </label>
            <p className="text-[11px] text-mc-text-secondary mt-1">
              Floating chat icon in the bottom-right corner. Off by
              default — enable if you actively use the per-task chat
              conversations.
            </p>
          </Field>
        </Section>

        {/* Audit defaults — workspace-scoped knobs for the initiative
            Investigate flow's subtree mode. See
            specs/initiative-investigate.md §"Decisions" item 1. */}
        <Section
          id="audit-defaults"
          title="Audit defaults"
          description={
            <>
              Knobs for the initiative <strong>Investigate ▾ → Whole subtree</strong>{' '}
              flow. These values are read at dispatch time, so changing them
              only affects subsequent audit runs.
            </>
          }
        >
          <Field label="Per-node timeout (minutes)">
            <InlineText
              value={String(
                Math.round(
                  (workspace.audit_per_node_timeout_ms ?? 15 * 60_000) / 60_000,
                ),
              )}
              onSave={async (next) => {
                const minutes = Number(next);
                if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) {
                  throw new Error('Enter a whole number of minutes between 1 and 60');
                }
                await patch({ audit_per_node_timeout_ms: Math.round(minutes) * 60_000 });
              }}
              placeholder="15"
              label="Edit per-node timeout"
            />
            <p className="text-[11px] text-mc-text-secondary mt-1">
              How long a single researcher is allowed before MC marks the
              node failed and proceeds. Default 15 min. Range 1–60 min.
            </p>
          </Field>
          <Field label="Subtree concurrency">
            <InlineText
              value={String(workspace.audit_subtree_concurrency ?? 4)}
              onSave={async (next) => {
                const n = Number(next);
                if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 8) {
                  throw new Error('Enter a whole number between 1 and 8');
                }
                await patch({ audit_subtree_concurrency: n });
              }}
              placeholder="4"
              label="Edit subtree concurrency"
            />
            <p className="text-[11px] text-mc-text-secondary mt-1">
              Max parallel researcher dispatches per layer. Default 4.
              Range 1–8. Dial up if your runner can hose the LLM; dial
              down to keep cost predictable.
            </p>
          </Field>
        </Section>

        {/* Export — read-only snapshot of every workspace-scoped row,
            useful for retaining state before a reset or copying a real
            workspace into a checkpoint. Backed by the same lib the CLI
            script uses (src/lib/db/workspace-export.ts). */}
        <Section
          id="export"
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

        {/* Import — counterpart to Export. Reads a JSON file from disk,
            shows a per-table checkbox list backed by table_counts in the
            export, lets the operator import into this workspace OR
            create a new one, and supports a dry-run preview. Backed by
            src/lib/db/workspace-import.ts (same lib the CLI script uses). */}
        <Section
          id="import"
          title="Import"
          description="Load a workspace export JSON. Choose which tables to import, whether to add to this workspace or create a new one, and run a dry-run first to preview the changes."
        >
          <ImportPanel
            currentWorkspaceId={workspace.id}
            onImported={async () => {
              await refresh();
            }}
          />
        </Section>

        {/* Danger Zone — GitHub-style. Red border, destructive actions
            grouped at the bottom of the page so they're never the first
            thing the operator clicks. Delete is the only one for now;
            the rename action lives inline above (no separate row needed
            — InlineText handles it). */}
        <section
          id="danger-zone"
          className="mt-10 rounded-lg border border-red-500/40 bg-red-500/5 scroll-mt-20"
        >
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
      </>
    </PageWithRails>
  );
}

/**
 * Live preview of what a dispatched agent will actually see for this
 * workspace. Mirrors the assembly in src/app/api/tasks/[id]/dispatch/route.ts —
 * the workspace's `context_md` is wrapped in a `## Workspace conventions`
 * heading and prepended above every task body. Showing this side-by-side
 * with the editor lets the operator catch malformed markdown / wrong tone
 * before a real dispatch carries it.
 */
function AgentPromptPreview({
  contextMd,
  dirty = false,
  variableSrc,
}: {
  contextMd: string;
  dirty?: boolean;
  variableSrc: VariableSource;
}) {
  const trimmed = contextMd.trim();
  if (!trimmed) {
    return (
      <div className="rounded-lg border border-mc-border/60 bg-mc-bg-secondary p-4 text-xs text-mc-text-secondary">
        <div className="text-[10px] uppercase tracking-wide text-mc-text-secondary/70 mb-2">
          Agent prompt preview
        </div>
        Conventions are empty — agents won&apos;t receive a{' '}
        <code className="text-mc-text">## Workspace conventions</code> block.
        Anything you type into the Conventions editor will appear here exactly
        as the agent sees it on dispatch.
      </div>
    );
  }
  // Expand `{{...}}` so the preview shows what the agent actually sees.
  const resolved = resolveVariables(trimmed, variableSrc);
  const variableUsage = inventoryVariables(trimmed, variableSrc);
  const warnings = variableUsage.filter((v) => !v.known || v.empty);
  return (
    <div className="rounded-lg border border-mc-border/60 bg-mc-bg-secondary">
      <header className="px-4 py-2 border-b border-mc-border/60 flex items-center justify-between gap-2">
        <h2 className="text-[10px] uppercase tracking-wide text-mc-text-secondary/70">
          Agent prompt preview
        </h2>
        {dirty ? (
          <span className="text-[10px] text-amber-300/80">unsaved draft</span>
        ) : (
          <span className="text-[10px] text-mc-text-secondary/60">
            prepended to every dispatch
          </span>
        )}
      </header>
      {warnings.length > 0 && (
        <div className="px-4 py-2 border-b border-mc-border/60 text-[10px] flex flex-wrap gap-1.5 bg-amber-500/5">
          {warnings.map((v) => (
            <span
              key={v.variable}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-200"
              title={
                v.known
                  ? `{{${v.variable}}} resolves to an empty value — set the field above to populate it.`
                  : `{{${v.variable}}} is not a known variable — likely a typo.`
              }
            >
              ⚠️ {`{{${v.variable}}}`} {v.known ? '(empty)' : '(unknown)'}
            </span>
          ))}
        </div>
      )}
      <div className="p-4 mc-md text-xs text-mc-text break-words">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {`## Workspace conventions\n\n${resolved}\n\n---`}
        </ReactMarkdown>
      </div>
    </div>
  );
}

/**
 * ImportPanel — file picker + per-table checkboxes + new-vs-existing
 * mode toggle + dry-run preview, all wired to POST /api/workspaces/:id/import.
 *
 * The panel reads the file client-side, parses it as JSON, and then
 * renders the operator's choices against the parsed `table_counts`. The
 * server is the source of truth for what's allowed (transient gating,
 * unknown-table filtering); the panel just helps the operator choose.
 */
const TRANSIENT_TABLES = new Set([
  'agent_mailbox',
  'agent_health',
  'agent_chat_messages',
  'openclaw_sessions',
]);

interface WorkspaceExportFile {
  version: number;
  workspace_id: string;
  exported_at?: string;
  table_counts?: Record<string, number>;
  tables: Record<string, unknown[]>;
  schema_migration?: string | null;
}

interface ImportResultPayload {
  workspace_id: string;
  created_workspace: boolean;
  inserted: Record<string, number>;
  skipped: Record<string, number>;
  fk_nulled: Record<string, number>;
  ignored_tables: string[];
  dry_run: boolean;
}

function ImportPanel({
  currentWorkspaceId,
  onImported,
}: {
  currentWorkspaceId: string;
  onImported: () => void | Promise<void>;
}) {
  const [parsedFile, setParsedFile] = useState<WorkspaceExportFile | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [includeTransient, setIncludeTransient] = useState(false);
  const [tableSelection, setTableSelection] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResultPayload | null>(null);

  const handleFile = async (file: File) => {
    setParseError(null);
    setResult(null);
    setSubmitError(null);
    setFilename(file.name);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as WorkspaceExportFile;
      if (typeof parsed !== 'object' || !parsed || !parsed.tables) {
        throw new Error('not a valid workspace export — missing `tables`');
      }
      setParsedFile(parsed);
      // Default selection: every non-transient table with non-zero rows ON.
      const sel: Record<string, boolean> = {};
      const counts = parsed.table_counts ?? {};
      for (const [table, count] of Object.entries(counts)) {
        if (count <= 0) continue;
        sel[table] = !TRANSIENT_TABLES.has(table);
      }
      setTableSelection(sel);
    } catch (e) {
      setParsedFile(null);
      setTableSelection({});
      setParseError(e instanceof Error ? e.message : 'failed to parse JSON');
    }
  };

  const tableEntries = parsedFile
    ? Object.entries(parsedFile.table_counts ?? {})
        .filter(([, count]) => count > 0)
        .sort((a, b) => a[0].localeCompare(b[0]))
    : [];

  const submit = async (dryRun: boolean) => {
    if (!parsedFile || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    if (!dryRun) setResult(null);
    try {
      const selectedTables = Object.entries(tableSelection)
        .filter(([, on]) => on)
        .map(([t]) => t);
      const body = {
        export: parsedFile,
        mode,
        tables: selectedTables.length > 0 ? selectedTables : undefined,
        include_transient: includeTransient,
        dry_run: dryRun,
        new_workspace:
          mode === 'new' && newWorkspaceName.trim()
            ? { name: newWorkspaceName.trim() }
            : undefined,
      };
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(currentWorkspaceId)}/import`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      }
      setResult(data as ImportResultPayload);
      if (!dryRun) {
        await onImported();
      }
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'import failed');
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setParsedFile(null);
    setFilename(null);
    setParseError(null);
    setTableSelection({});
    setResult(null);
    setSubmitError(null);
    setNewWorkspaceName('');
    setMode('existing');
  };

  const totalRowsSelected = tableEntries
    .filter(([t]) => tableSelection[t])
    .reduce((acc, [, c]) => acc + c, 0);

  return (
    <div className="flex flex-col gap-3">
      {!parsedFile && (
        <label className="flex flex-col gap-2 p-4 rounded border border-dashed border-mc-border text-sm text-mc-text cursor-pointer hover:bg-mc-bg-tertiary/50">
          <span className="inline-flex items-center gap-2 text-mc-text-secondary">
            <Upload className="w-3.5 h-3.5" />
            Choose a workspace export JSON…
          </span>
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = '';
            }}
          />
        </label>
      )}

      {parseError && (
        <p className="text-xs text-rose-300" role="alert">
          {filename}: {parseError}
        </p>
      )}

      {parsedFile && (
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-2 text-xs text-mc-text-secondary">
            <div>
              <p className="text-mc-text">
                <strong>{filename}</strong> — workspace_id{' '}
                <code className="text-mc-text">{parsedFile.workspace_id}</code>
                {parsedFile.exported_at && (
                  <span className="ml-2">
                    exported {parsedFile.exported_at.slice(0, 19).replace('T', ' ')}
                  </span>
                )}
              </p>
              <p className="mt-0.5 opacity-70">
                version {parsedFile.version}
                {parsedFile.schema_migration && (
                  <span className="ml-2">
                    schema {parsedFile.schema_migration}
                  </span>
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={reset}
              className="text-[11px] underline text-mc-text-secondary hover:text-mc-text"
            >
              Choose a different file
            </button>
          </div>

          {/* Mode toggle */}
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-[11px] uppercase tracking-wide text-mc-text-secondary/80 mb-1">
              Where should the import land?
            </legend>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="import-mode"
                checked={mode === 'existing'}
                onChange={() => setMode('existing')}
              />
              <span>
                Add to <strong className="text-mc-text">this workspace</strong>{' '}
                <code className="text-mc-text-secondary text-xs">
                  ({currentWorkspaceId})
                </code>
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="radio"
                name="import-mode"
                checked={mode === 'new'}
                onChange={() => setMode('new')}
              />
              <span>Create a new workspace</span>
            </label>
            {mode === 'new' && (
              <input
                type="text"
                value={newWorkspaceName}
                onChange={(e) => setNewWorkspaceName(e.target.value.slice(0, 120))}
                placeholder="New workspace name (required)"
                className="ml-6 mt-1 px-2 py-1 rounded border border-mc-border bg-mc-bg text-sm text-mc-text outline-none focus:border-mc-accent/60 max-w-md"
                aria-label="New workspace name"
              />
            )}
          </fieldset>

          {/* Per-table checkbox list */}
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-[11px] uppercase tracking-wide text-mc-text-secondary/80 mb-1 flex items-center justify-between gap-2">
              <span>Tables ({totalRowsSelected.toLocaleString()} rows selected)</span>
              <span className="flex items-center gap-2 normal-case tracking-normal">
                <button
                  type="button"
                  className="underline text-mc-text-secondary hover:text-mc-text"
                  onClick={() =>
                    setTableSelection(
                      Object.fromEntries(
                        tableEntries.map(([t]) => [t, !TRANSIENT_TABLES.has(t)]),
                      ),
                    )
                  }
                >
                  Reset to defaults
                </button>
                <button
                  type="button"
                  className="underline text-mc-text-secondary hover:text-mc-text"
                  onClick={() =>
                    setTableSelection(
                      Object.fromEntries(tableEntries.map(([t]) => [t, true])),
                    )
                  }
                >
                  All
                </button>
                <button
                  type="button"
                  className="underline text-mc-text-secondary hover:text-mc-text"
                  onClick={() => setTableSelection({})}
                >
                  None
                </button>
              </span>
            </legend>
            <div className="rounded border border-mc-border max-h-72 overflow-y-auto">
              <ul className="divide-y divide-mc-border/40">
                {tableEntries.map(([table, count]) => {
                  const transient = TRANSIENT_TABLES.has(table);
                  const checked = !!tableSelection[table];
                  return (
                    <li
                      key={table}
                      className="px-3 py-1.5 flex items-center justify-between gap-3 text-xs"
                    >
                      <label className="flex items-center gap-2 cursor-pointer text-mc-text">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setTableSelection((prev) => ({
                              ...prev,
                              [table]: e.target.checked,
                            }))
                          }
                        />
                        <code>{table}</code>
                        {transient && (
                          <span className="text-[10px] uppercase tracking-wide px-1 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-200">
                            transient
                          </span>
                        )}
                      </label>
                      <span className="text-mc-text-secondary tabular-nums">
                        {count.toLocaleString()}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
            <label className="flex items-center gap-2 text-xs text-mc-text-secondary mt-1">
              <input
                type="checkbox"
                checked={includeTransient}
                onChange={(e) => setIncludeTransient(e.target.checked)}
              />
              Include transient tables (mailbox, chat, sessions, agent health)
            </label>
          </fieldset>

          {submitError && (
            <p className="text-xs text-rose-300" role="alert">
              {submitError}
            </p>
          )}

          {result && (
            <div className="rounded border border-mc-border bg-mc-bg-tertiary/40 p-3 text-xs">
              <p className="text-mc-text mb-2">
                {result.dry_run ? (
                  <>
                    <strong>Dry run — nothing was written.</strong> Reviewing
                    what an import would do:
                  </>
                ) : (
                  <>
                    <strong>Import complete.</strong>{' '}
                    {result.created_workspace
                      ? `Created new workspace ${result.workspace_id}.`
                      : `Wrote into workspace ${result.workspace_id}.`}
                  </>
                )}
              </p>
              <table className="w-full text-mc-text-secondary">
                <thead className="text-[10px] uppercase tracking-wide opacity-70">
                  <tr>
                    <th className="text-left pb-1">Table</th>
                    <th className="text-right pb-1">Inserted</th>
                    <th className="text-right pb-1">Skipped</th>
                    <th className="text-right pb-1">FK nulled</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-[11px]">
                  {Object.keys(result.inserted)
                    .sort()
                    .map((t) => (
                      <tr key={t}>
                        <td className="pr-2">{t}</td>
                        <td className="text-right tabular-nums">
                          {result.inserted[t] ?? 0}
                        </td>
                        <td className="text-right tabular-nums">
                          {result.skipped[t] ?? 0}
                        </td>
                        <td className="text-right tabular-nums">
                          {result.fk_nulled[t] ?? 0}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {result.ignored_tables.length > 0 && (
                <p className="mt-2 opacity-70">
                  Ignored tables (filtered, transient, or not in target schema):{' '}
                  {result.ignored_tables.join(', ')}
                </p>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => submit(true)}
              disabled={submitting || (mode === 'new' && !newWorkspaceName.trim())}
              className="px-3 py-1.5 text-sm rounded border border-mc-border text-mc-text-secondary hover:bg-mc-bg-tertiary disabled:opacity-40 inline-flex items-center gap-1.5"
            >
              {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              Dry run
            </button>
            <button
              type="button"
              onClick={() => submit(false)}
              disabled={submitting || (mode === 'new' && !newWorkspaceName.trim())}
              className="px-3 py-1.5 text-sm rounded bg-mc-accent text-white disabled:opacity-40 inline-flex items-center gap-1.5"
            >
              {submitting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Upload className="w-3.5 h-3.5" />
              )}
              Import
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Refine modal — POSTs the current conventions text to the runner agent
 * and renders the structured proposal (replacement or questions) for
 * the operator to review.
 *
 * v1 keeps the flow synchronous: submit → spinner → result. Failure is
 * surfaced inline; the modal stays open so the operator can edit + retry.
 *
 * Spec: specs/workspace-conventions-structured.md §6.
 */
interface RefineModalProps {
  workspaceId: string;
  currentConventions: string;
  onClose: () => void;
  onAccept: (replacement: string) => void;
}

interface RefineProposal {
  kind: 'replacement' | 'questions';
  body?: string;
  questions?: string[];
  rationale?: string;
}

function RefineModal({
  workspaceId,
  currentConventions,
  onClose,
  onAccept,
}: RefineModalProps) {
  const [operatorNote, setOperatorNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<RefineProposal | null>(null);
  // When agent returned questions, the operator answers inline → next
  // submit appends them to operator_note for the second turn.
  const [answers, setAnswers] = useState<string[]>([]);

  const submit = async (extraNote?: string) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const composed = [operatorNote, extraNote ?? ''].filter(Boolean).join('\n\n').trim();
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/refine-conventions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            current_conventions: currentConventions,
            operator_note: composed || null,
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      }
      const p = (data as { proposal: RefineProposal }).proposal;
      setProposal(p);
      if (p.kind === 'questions') {
        setAnswers(new Array(p.questions?.length ?? 0).fill(''));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refine failed');
    } finally {
      setSubmitting(false);
    }
  };

  const sendAnswers = async () => {
    if (!proposal || proposal.kind !== 'questions') return;
    const composed = (proposal.questions ?? [])
      .map((q, i) => `Q: ${q}\nA: ${answers[i] ?? '(no answer)'}`)
      .join('\n\n');
    await submit(`Operator answers to your follow-up questions:\n\n${composed}`);
    setAnswers([]);
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50"
      role="dialog"
      aria-modal="true"
      aria-label="Refine workspace conventions"
      onClick={onClose}
    >
      <div
        className="bg-mc-bg-secondary border border-mc-border rounded-lg w-full max-w-2xl flex flex-col text-mc-text max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-2 px-5 py-3 border-b border-mc-border shrink-0">
          <div className="flex items-start gap-2">
            <Sparkles className="w-4 h-4 mt-0.5 text-mc-accent shrink-0" />
            <div>
              <h2 className="text-base font-semibold leading-tight">
                Refine conventions with an agent
              </h2>
              <p className="text-xs text-mc-text-secondary mt-0.5">
                The runner agent will review the current text and either propose
                a rewrite or ask up to 5 clarifying questions.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded hover:bg-mc-bg text-mc-text-secondary hover:text-mc-text shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto">
          {error && (
            <div
              className="p-3 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-sm"
              role="alert"
            >
              {error}
            </div>
          )}

          {!proposal && (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-xs uppercase tracking-wide text-mc-text-secondary/80">
                  Operator note <span className="normal-case opacity-70">(optional)</span>
                </span>
                <textarea
                  value={operatorNote}
                  onChange={(e) => setOperatorNote(e.target.value.slice(0, 2000))}
                  rows={4}
                  placeholder="What would you like the agent to focus on? e.g. 'tighten the testing section', 'add a deliverables policy'."
                  className="w-full px-2 py-1.5 rounded bg-mc-bg border border-mc-border text-sm text-mc-text outline-none focus:border-mc-accent/60 resize-y leading-relaxed"
                  maxLength={2000}
                />
                <span className="text-[10px] text-mc-text-secondary/70 self-end">
                  {operatorNote.length}/2000
                </span>
              </label>
            </>
          )}

          {proposal?.kind === 'replacement' && (
            <>
              {proposal.rationale && (
                <p className="text-xs text-mc-text-secondary italic">
                  {proposal.rationale}
                </p>
              )}
              <div>
                <span className="text-xs uppercase tracking-wide text-mc-text-secondary/80">
                  Proposed replacement
                </span>
                <pre className="mt-1 p-3 rounded bg-mc-bg border border-mc-border text-xs leading-relaxed whitespace-pre-wrap break-words text-mc-text max-h-[40vh] overflow-y-auto">
                  {proposal.body}
                </pre>
              </div>
            </>
          )}

          {proposal?.kind === 'questions' && (
            <>
              {proposal.rationale && (
                <p className="text-xs text-mc-text-secondary italic">
                  {proposal.rationale}
                </p>
              )}
              <div className="flex flex-col gap-3">
                <span className="text-xs uppercase tracking-wide text-mc-text-secondary/80">
                  Clarifying questions
                </span>
                {(proposal.questions ?? []).map((q, i) => (
                  <label key={i} className="flex flex-col gap-1">
                    <span className="text-sm text-mc-text">{q}</span>
                    <textarea
                      value={answers[i] ?? ''}
                      onChange={(e) =>
                        setAnswers((prev) => {
                          const next = [...prev];
                          next[i] = e.target.value;
                          return next;
                        })
                      }
                      rows={2}
                      className="w-full px-2 py-1.5 rounded bg-mc-bg border border-mc-border text-sm text-mc-text outline-none focus:border-mc-accent/60 resize-y leading-relaxed"
                    />
                  </label>
                ))}
              </div>
            </>
          )}
        </div>

        <footer className="border-t border-mc-border px-5 py-3 flex justify-end gap-2 shrink-0">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-2 rounded border border-mc-border text-mc-text-secondary text-sm disabled:opacity-50"
          >
            Cancel
          </button>
          {!proposal && (
            <button
              onClick={() => submit()}
              disabled={submitting}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded bg-mc-accent text-white text-sm disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Refining…
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  Refine
                </>
              )}
            </button>
          )}
          {proposal?.kind === 'replacement' && (
            <>
              <button
                onClick={() => {
                  setProposal(null);
                  setAnswers([]);
                }}
                disabled={submitting}
                className="px-3 py-2 rounded border border-mc-border text-mc-text-secondary text-sm disabled:opacity-50"
              >
                Refine again
              </button>
              <button
                onClick={() => proposal.body && onAccept(proposal.body)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded bg-mc-accent text-white text-sm"
              >
                Accept replacement
              </button>
            </>
          )}
          {proposal?.kind === 'questions' && (
            <button
              onClick={sendAnswers}
              disabled={submitting}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded bg-mc-accent text-white text-sm disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Sending…
                </>
              ) : (
                <>Send answers</>
              )}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function Section({
  id,
  title,
  description,
  children,
}: {
  id?: string;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="mb-6 rounded-lg border border-mc-border bg-mc-bg-secondary scroll-mt-20"
    >
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
