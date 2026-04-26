'use client';

import { useState, useEffect, useCallback, use } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  ChevronRight,
  Plus,
  Send,
  History,
  Link2,
  Sparkles,
  Pencil,
  MoveRight,
  Shuffle,
  CornerUpLeft,
  Trash2,
} from 'lucide-react';
import DecomposeWithPmModal from '@/components/DecomposeWithPmModal';
// Reuse the modal components defined alongside the list page so the detail
// page exposes the same action surface — but as visible buttons rather than
// behind a dropdown, since the operator already drilled into one initiative.
import {
  EditDrawer,
  MoveModal,
  ConvertModal,
  AddDependencyModal,
  HistoryDrawer,
  type Initiative as ListInitiative,
} from '../page';

type Kind = 'theme' | 'milestone' | 'epic' | 'story';
type Status = 'planned' | 'in_progress' | 'at_risk' | 'blocked' | 'done' | 'cancelled';

interface Initiative {
  id: string;
  workspace_id: string;
  product_id: string | null;
  parent_initiative_id: string | null;
  kind: Kind;
  title: string;
  description: string | null;
  status: Status;
  owner_agent_id: string | null;
  estimated_effort_hours: number | null;
  complexity: 'S' | 'M' | 'L' | 'XL' | null;
  target_start: string | null;
  target_end: string | null;
  derived_start: string | null;
  derived_end: string | null;
  committed_end: string | null;
  status_check_md: string | null;
  source_idea_id: string | null;
  // Required by the list-page Initiative shape that the shared modals
  // (Move/Convert/AddDependency) consume; the API returns it on every row.
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface InitiativeWithRelations extends Initiative {
  children?: Initiative[];
  tasks?: TaskRow[];
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
}

interface HistoryRow {
  id: string;
  from_parent_id: string | null;
  to_parent_id: string | null;
  reason: string | null;
  created_at: string;
}

interface DepRow {
  id: string;
  initiative_id: string;
  depends_on_initiative_id: string;
  kind: string;
  note: string | null;
  created_at: string;
}

interface DepEdges {
  outgoing: DepRow[];
  incoming: DepRow[];
}

const KIND_BADGE: Record<Kind, string> = {
  theme: 'bg-purple-500/20 text-purple-300',
  milestone: 'bg-amber-500/20 text-amber-300',
  epic: 'bg-blue-500/20 text-blue-300',
  story: 'bg-emerald-500/20 text-emerald-300',
};

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-slate-500/20 text-slate-300 border-slate-500/30',
  inbox: 'bg-pink-500/20 text-pink-300',
  planning: 'bg-purple-500/20 text-purple-300',
  assigned: 'bg-yellow-500/20 text-yellow-300',
  in_progress: 'bg-blue-500/20 text-blue-300',
  convoy_active: 'bg-cyan-500/20 text-cyan-300',
  testing: 'bg-cyan-500/20 text-cyan-300',
  review: 'bg-purple-500/20 text-purple-300',
  verification: 'bg-orange-500/20 text-orange-300',
  done: 'bg-emerald-500/20 text-emerald-300',
};

const ACTIVE_STATUSES = new Set([
  'inbox',
  'planning',
  'assigned',
  'in_progress',
  'convoy_active',
  'testing',
  'review',
  'verification',
]);

export default function InitiativeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [initiative, setInitiative] = useState<InitiativeWithRelations | null>(null);
  const [allInitiatives, setAllInitiatives] = useState<Initiative[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [deps, setDeps] = useState<DepEdges | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showPromoteModal, setShowPromoteModal] = useState(false);
  const [showDecomposeModal, setShowDecomposeModal] = useState(false);
  const [showEditDrawer, setShowEditDrawer] = useState(false);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showConvertModal, setShowConvertModal] = useState(false);
  const [showAddDepModal, setShowAddDepModal] = useState(false);
  const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [detailRes, listRes, histRes, depsRes] = await Promise.all([
        fetch(`/api/initiatives/${id}?include=children,tasks`),
        fetch(`/api/initiatives`),
        fetch(`/api/initiatives/${id}/history`),
        fetch(`/api/initiatives/${id}/dependencies`),
      ]);
      if (!detailRes.ok) {
        throw new Error(`Failed to load initiative (${detailRes.status})`);
      }
      const detail: InitiativeWithRelations = await detailRes.json();
      setInitiative(detail);
      setAllInitiatives(listRes.ok ? await listRes.json() : []);
      setHistory(histRes.ok ? await histRes.json() : []);
      setDeps(depsRes.ok ? await depsRes.json() : { outgoing: [], incoming: [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const titleFor = useCallback(
    (initId: string | null) => {
      if (!initId) return '(root)';
      return allInitiatives.find(i => i.id === initId)?.title ?? initId;
    },
    [allInitiatives],
  );

  // Detach (move to no parent). Mirrors the action on the list page so the
  // detail page can break a parent link without a round-trip via Move.
  const detach = useCallback(async () => {
    if (!initiative) return;
    setActionError(null);
    try {
      const res = await fetch(`/api/initiatives/${initiative.id}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to_parent_id: null, reason: 'detach' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Detach failed (${res.status})`);
      }
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Detach failed');
    }
  }, [initiative, refresh]);

  // Delete with confirm. On success, route back to the list — the detail
  // page no longer has a row to render.
  const deleteInitiative = useCallback(async () => {
    if (!initiative) return;
    if (!confirm(`Delete "${initiative.title}"? This cannot be undone.`)) return;
    setActionError(null);
    try {
      const res = await fetch(`/api/initiatives/${initiative.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Delete failed (${res.status})`);
      }
      router.push('/initiatives');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Delete failed');
    }
  }, [initiative, router]);

  const promoteDraft = async (taskId: string) => {
    setActionError(null);
    try {
      const res = await fetch(`/api/tasks/${taskId}/promote`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Promote failed (${res.status})`);
      }
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Promote failed');
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-mc-bg p-6 text-mc-text-secondary">Loading…</div>
    );
  }
  if (error || !initiative) {
    return (
      <div className="min-h-screen bg-mc-bg p-6">
        <div className="max-w-3xl mx-auto p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
          {error || 'Initiative not found'}
        </div>
        <div className="max-w-3xl mx-auto mt-4">
          <Link href="/initiatives" className="text-mc-text-secondary hover:text-mc-text text-sm">
            ← Back to initiatives
          </Link>
        </div>
      </div>
    );
  }

  const tasks = initiative.tasks ?? [];
  const drafts = tasks.filter(t => t.status === 'draft');
  const active = tasks.filter(t => ACTIVE_STATUSES.has(t.status));
  const done = tasks.filter(t => t.status === 'done');
  const other = tasks.filter(
    t => t.status !== 'draft' && !ACTIVE_STATUSES.has(t.status) && t.status !== 'done',
  );

  return (
    <div className="min-h-screen bg-mc-bg p-6">
      <div className="max-w-4xl mx-auto">
        <div className="mb-4 flex items-center gap-2">
          <Link
            href="/initiatives"
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-mc-text-secondary hover:text-mc-text text-sm"
          >
            <ArrowLeft className="w-4 h-4" /> Initiatives
          </Link>
          {initiative.parent_initiative_id && (
            <>
              <ChevronRight className="w-4 h-4 text-mc-text-secondary" />
              <Link
                href={`/initiatives/${initiative.parent_initiative_id}`}
                className="text-mc-text-secondary hover:text-mc-text text-sm"
              >
                {titleFor(initiative.parent_initiative_id)}
              </Link>
            </>
          )}
        </div>

        <header className="mb-6 p-5 rounded-lg bg-mc-bg-secondary border border-mc-border">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className={`px-2 py-0.5 rounded text-xs uppercase tracking-wide ${KIND_BADGE[initiative.kind]}`}>
                  {initiative.kind}
                </span>
                <span className="text-xs text-mc-text-secondary uppercase">{initiative.status}</span>
              </div>
              <h1 className="text-2xl font-semibold text-mc-text">{initiative.title}</h1>
              {initiative.description && (
                <p className="text-mc-text-secondary mt-2 whitespace-pre-wrap">{initiative.description}</p>
              )}
            </div>
            <div className="flex flex-col items-end gap-2">
              <PromoteButton
                kind={initiative.kind}
                onClick={() => setShowPromoteModal(true)}
              />
              {(initiative.kind === 'epic' || initiative.kind === 'milestone') && (
                <button
                  onClick={() => setShowDecomposeModal(true)}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm border border-mc-accent/40 text-mc-accent hover:bg-mc-accent/10"
                  title="Ask the PM to propose 3-7 child initiatives"
                >
                  <Sparkles className="w-4 h-4" /> Decompose with PM
                </button>
              )}
            </div>
          </div>

          {/*
            Secondary action toolbar — surfaces every action that lives in
            the ⋮ overflow menu on the list page, but as visible buttons
            since this is a dedicated detail page and the operator already
            committed to one initiative. Destructive actions (Detach,
            Delete) sit at the right with a divider and tinted styling.
          */}
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-mc-border/60 pt-3">
            <ToolbarButton icon={<Pencil className="w-3.5 h-3.5" />} onClick={() => setShowEditDrawer(true)}>
              Edit
            </ToolbarButton>
            <ToolbarButton icon={<MoveRight className="w-3.5 h-3.5" />} onClick={() => setShowMoveModal(true)}>
              Move
            </ToolbarButton>
            <ToolbarButton icon={<Shuffle className="w-3.5 h-3.5" />} onClick={() => setShowConvertModal(true)}>
              Convert kind
            </ToolbarButton>
            <ToolbarButton icon={<Link2 className="w-3.5 h-3.5" />} onClick={() => setShowAddDepModal(true)}>
              Add dependency
            </ToolbarButton>
            <ToolbarButton icon={<History className="w-3.5 h-3.5" />} onClick={() => setShowHistoryDrawer(true)}>
              View history
            </ToolbarButton>
            <div className="ml-auto flex items-center gap-2">
              {initiative.parent_initiative_id && (
                <ToolbarButton
                  icon={<CornerUpLeft className="w-3.5 h-3.5" />}
                  onClick={detach}
                  title="Move to no parent"
                >
                  Detach
                </ToolbarButton>
              )}
              <ToolbarButton
                icon={<Trash2 className="w-3.5 h-3.5" />}
                onClick={deleteInitiative}
                destructive
              >
                Delete
              </ToolbarButton>
            </div>
          </div>

          <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 text-xs text-mc-text-secondary">
            <div>
              <dt className="uppercase tracking-wide">Target start</dt>
              <dd className="text-mc-text">{initiative.target_start ?? '—'}</dd>
            </div>
            <div>
              <dt className="uppercase tracking-wide">Target end</dt>
              <dd className="text-mc-text">{initiative.target_end ?? '—'}</dd>
            </div>
            <div>
              <dt className="uppercase tracking-wide">Committed end</dt>
              <dd className="text-mc-text">{initiative.committed_end ?? '—'}</dd>
            </div>
            <div>
              <dt className="uppercase tracking-wide">Owner</dt>
              <dd className="text-mc-text">{initiative.owner_agent_id ?? '—'}</dd>
            </div>
          </dl>

          {initiative.status_check_md && (
            <div className="mt-4 p-3 rounded border border-mc-border/60 bg-mc-bg text-sm text-mc-text-secondary whitespace-pre-wrap font-mono text-xs">
              <div className="uppercase tracking-wide text-[10px] text-mc-text-secondary/70 mb-1">
                Status check
              </div>
              {initiative.status_check_md}
            </div>
          )}
        </header>

        {actionError && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
            {actionError}
          </div>
        )}

        {/* Children */}
        {initiative.children && initiative.children.length > 0 && (
          <Section title={`Children (${initiative.children.length})`}>
            <ul className="space-y-1">
              {initiative.children.map(c => (
                <li
                  key={c.id}
                  className="flex items-center gap-2 p-2 rounded bg-mc-bg-secondary border border-mc-border"
                >
                  <span className={`px-2 py-0.5 rounded text-xs uppercase tracking-wide ${KIND_BADGE[c.kind]}`}>
                    {c.kind}
                  </span>
                  <Link
                    href={`/initiatives/${c.id}`}
                    className="font-medium text-mc-text hover:text-mc-accent"
                  >
                    {c.title}
                  </Link>
                  <span className="text-xs text-mc-text-secondary ml-auto">{c.status}</span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Tasks */}
        <Section title={`Tasks (${tasks.length})`}>
          {tasks.length === 0 ? (
            <p className="text-sm text-mc-text-secondary">
              No tasks yet. {initiative.kind === 'story' ? 'Use “Promote to task” to create one.' : ''}
            </p>
          ) : (
            <div className="space-y-3">
              <TaskGroup
                label="Draft (planning)"
                rows={drafts}
                onPromote={promoteDraft}
              />
              <TaskGroup label="Active" rows={active} />
              {other.length > 0 && <TaskGroup label="Other" rows={other} />}
              <TaskGroup label="Done" rows={done} />
            </div>
          )}
        </Section>

        {/* Dependencies */}
        <Section title="Dependencies" icon={<Link2 className="w-4 h-4" />}>
          {!deps || (deps.outgoing.length === 0 && deps.incoming.length === 0) ? (
            <p className="text-sm text-mc-text-secondary">No dependencies.</p>
          ) : (
            <ul className="text-sm space-y-1">
              {deps.outgoing.map(d => (
                <li key={d.id} className="text-mc-text-secondary">
                  depends on{' '}
                  <Link
                    href={`/initiatives/${d.depends_on_initiative_id}`}
                    className="text-mc-text hover:text-mc-accent"
                  >
                    {titleFor(d.depends_on_initiative_id)}
                  </Link>
                </li>
              ))}
              {deps.incoming.map(d => (
                <li key={d.id} className="text-mc-text-secondary">
                  blocks{' '}
                  <Link
                    href={`/initiatives/${d.initiative_id}`}
                    className="text-mc-text hover:text-mc-accent"
                  >
                    {titleFor(d.initiative_id)}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* History */}
        <Section title="Parent-change history" icon={<History className="w-4 h-4" />}>
          {history.length === 0 ? (
            <p className="text-sm text-mc-text-secondary">No moves recorded.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {history.map(h => (
                <li key={h.id} className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-mc-text-secondary">
                    {h.created_at.replace('T', ' ').slice(0, 19)}
                  </span>
                  <span className="text-mc-text">
                    {titleFor(h.from_parent_id)} → {titleFor(h.to_parent_id)}
                  </span>
                  {h.reason && (
                    <span className="text-mc-text-secondary italic">— {h.reason}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {showPromoteModal && (
        <PromoteToTaskModal
          initiative={initiative}
          onClose={() => setShowPromoteModal(false)}
          onSaved={() => {
            setShowPromoteModal(false);
            refresh();
          }}
        />
      )}
      {showDecomposeModal && (
        <DecomposeWithPmModal
          initiative={{
            id: initiative.id,
            title: initiative.title,
            kind: initiative.kind,
            workspace_id: initiative.workspace_id,
          }}
          onClose={() => setShowDecomposeModal(false)}
          onAccepted={() => {
            setShowDecomposeModal(false);
            refresh();
          }}
        />
      )}
      <EditDrawer
        initiative={showEditDrawer ? (initiative as ListInitiative) : null}
        onClose={() => setShowEditDrawer(false)}
        onSaved={() => {
          setShowEditDrawer(false);
          refresh();
        }}
      />
      {showMoveModal && (
        <MoveModal
          initiative={initiative as ListInitiative}
          allInitiatives={allInitiatives as ListInitiative[]}
          onClose={() => setShowMoveModal(false)}
          onSaved={() => {
            setShowMoveModal(false);
            refresh();
          }}
        />
      )}
      {showConvertModal && (
        <ConvertModal
          initiative={initiative as ListInitiative}
          onClose={() => setShowConvertModal(false)}
          onSaved={() => {
            setShowConvertModal(false);
            refresh();
          }}
        />
      )}
      {showAddDepModal && (
        <AddDependencyModal
          initiative={initiative as ListInitiative}
          allInitiatives={allInitiatives as ListInitiative[]}
          onClose={() => setShowAddDepModal(false)}
          onSaved={() => {
            setShowAddDepModal(false);
            refresh();
          }}
        />
      )}
      {showHistoryDrawer && (
        <HistoryDrawer
          initiative={initiative as ListInitiative}
          allInitiatives={allInitiatives as ListInitiative[]}
          onClose={() => setShowHistoryDrawer(false)}
        />
      )}
    </div>
  );
}

function ToolbarButton({
  icon,
  onClick,
  children,
  destructive,
  title,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
  destructive?: boolean;
  title?: string;
}) {
  const palette = destructive
    ? 'border-red-500/30 text-red-300 hover:bg-red-500/10 hover:border-red-500/50'
    : 'border-mc-border text-mc-text-secondary hover:text-mc-text hover:border-mc-accent/40';
  return (
    <button
      onClick={onClick}
      title={title}
      className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border ${palette}`}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

function PromoteButton({ kind, onClick }: { kind: Kind; onClick: () => void }) {
  const isStory = kind === 'story';
  return (
    <button
      onClick={isStory ? onClick : undefined}
      disabled={!isStory}
      title={
        isStory
          ? 'Create a draft task linked to this initiative'
          : 'Only story-kind initiatives can be promoted to tasks. Convert this initiative to a story first.'
      }
      className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
        isStory
          ? 'bg-mc-accent text-white hover:bg-mc-accent/90'
          : 'bg-mc-bg-tertiary text-mc-text-secondary cursor-not-allowed border border-mc-border'
      }`}
    >
      <Plus className="w-4 h-4" /> Promote to task
    </button>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6 p-4 rounded-lg bg-mc-bg-secondary border border-mc-border">
      <h2 className="font-medium text-mc-text mb-3 flex items-center gap-2">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function TaskGroup({
  label,
  rows,
  onPromote,
}: {
  label: string;
  rows: TaskRow[];
  onPromote?: (taskId: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-mc-text-secondary mb-1">
        {label} ({rows.length})
      </div>
      <ul className="space-y-1">
        {rows.map(t => (
          <li
            key={t.id}
            className="flex items-center gap-2 p-2 rounded bg-mc-bg border border-mc-border/60"
          >
            <span
              className={`px-2 py-0.5 rounded text-[10px] uppercase tracking-wide border ${
                STATUS_BADGE[t.status] || 'bg-slate-500/20 text-slate-300 border-slate-500/30'
              }`}
            >
              {t.status}
            </span>
            <span className="text-sm text-mc-text flex-1">{t.title}</span>
            {onPromote && t.status === 'draft' && (
              <button
                onClick={() => onPromote(t.id)}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-mc-accent/15 text-mc-accent border border-mc-accent/30 hover:bg-mc-accent/25"
                title="Promote draft to execution queue (status → inbox)"
              >
                <Send className="w-3 h-3" /> Promote
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PromoteToTaskModal({
  initiative,
  onClose,
  onSaved,
}: {
  initiative: Initiative;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(initiative.title);
  const [description, setDescription] = useState(initiative.description ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch(`/api/initiatives/${initiative.id}/promote-to-task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_title: title,
          task_description: description || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Promote failed (${res.status})`);
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Promote failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div
        className="bg-mc-bg-secondary border border-mc-border rounded-lg p-6 w-full max-w-lg text-mc-text"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-4">Promote story to task draft</h2>
        <p className="text-sm text-mc-text-secondary mb-4">
          Creates one task in <code>status=draft</code>, linked to this initiative.
          The draft lives on the planning board until you explicitly promote it
          to the execution queue.
        </p>
        <div className="space-y-3">
          <label className="block">
            <span className="text-sm text-mc-text-secondary">Task title</span>
            <input
              className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border"
              value={title}
              onChange={e => setTitle(e.target.value)}
              autoFocus
            />
          </label>
          <label className="block">
            <span className="text-sm text-mc-text-secondary">Description (optional)</span>
            <textarea
              className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border h-28"
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </label>
          {err && <div className="text-red-400 text-sm">{err}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="px-3 py-2 rounded border border-mc-border text-mc-text-secondary text-sm"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={submitting || !title.trim()}
              className="px-3 py-2 rounded bg-mc-accent text-white disabled:opacity-50 text-sm"
            >
              Promote to draft
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
