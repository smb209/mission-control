'use client';

import { useState, useEffect, useCallback, useRef, use } from 'react';
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
  MoveRight,
  Shuffle,
  CornerUpLeft,
  Trash2,
} from 'lucide-react';
import DecomposeWithPmModal from '@/components/DecomposeWithPmModal';
import PlanWithPmPanel, {
  type PlanInitiativeSuggestions,
} from '@/components/PlanWithPmPanel';
import {
  InlineText,
  InlineTextarea,
  InlineSelect,
  InlineDate,
} from '@/components/inline/InlineEdit';
// Reuse the action modals defined alongside the list page — Move / Convert /
// AddDep / History still make sense as focused dialogs since they have
// non-trivial side effects beyond a simple field write.
import {
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

// Minimal agent shape for the owner inline-select. Mirrors the AgentLite
// declared next to EditDrawer in ../page.tsx; kept local to avoid churning
// that file's public exports.
interface AgentLite {
  id: string;
  name: string;
  role: string;
  avatar_emoji: string;
  workspace_id: string;
}

type Complexity = 'S' | 'M' | 'L' | 'XL';

const STATUS_OPTIONS: { value: Status; label: string }[] = [
  { value: 'planned', label: 'planned' },
  { value: 'in_progress', label: 'in_progress' },
  { value: 'at_risk', label: 'at_risk' },
  { value: 'blocked', label: 'blocked' },
  { value: 'done', label: 'done' },
  { value: 'cancelled', label: 'cancelled' },
];

const COMPLEXITY_OPTIONS: { value: Complexity | ''; label: string }[] = [
  { value: '', label: '(unset)' },
  { value: 'S', label: 'S' },
  { value: 'M', label: 'M' },
  { value: 'L', label: 'L' },
  { value: 'XL', label: 'XL' },
];

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
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [showPromoteModal, setShowPromoteModal] = useState(false);
  const [showDecomposeModal, setShowDecomposeModal] = useState(false);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showConvertModal, setShowConvertModal] = useState(false);
  const [showAddDepModal, setShowAddDepModal] = useState(false);
  const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);
  const [showPlanPanel, setShowPlanPanel] = useState(false);
  // Brief accent-ring on the plan panel right after it opens, so the
  // operator notices it appearing inline under the header instead of
  // wondering whether the click did anything.
  const [planPanelHighlight, setPlanPanelHighlight] = useState(false);
  const planPanelRef = useRef<HTMLDivElement>(null);

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

  // Load agents in this workspace for the owner inline-select. Mirrors the
  // pattern used in EditDrawer.
  useEffect(() => {
    if (!initiative) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/agents?workspace_id=${encodeURIComponent(initiative.workspace_id)}`,
        );
        if (!r.ok) return;
        const list = await r.json();
        if (!cancelled && Array.isArray(list)) setAgents(list);
      } catch {
        // Non-fatal: the owner select just falls back to "Unassigned".
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initiative?.workspace_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Open the inline Plan-with-PM panel and pull it into view. The panel
  // mounts directly under the header card, but a long header can still
  // push it below the fold on smaller viewports — scrollIntoView + a
  // brief accent ring gives the operator unambiguous feedback that the
  // click landed.
  const openPlanPanel = useCallback(() => {
    setShowPlanPanel(true);
    setPlanPanelHighlight(true);
    requestAnimationFrame(() => {
      planPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    window.setTimeout(() => setPlanPanelHighlight(false), 1800);
  }, []);

  // PATCH a partial update to this initiative and refresh on success. The
  // route's Zod schema treats every field as optional, so callers can send
  // exactly the slice they're editing.
  const patch = useCallback(
    async (body: Record<string, unknown>) => {
      const res = await fetch(`/api/initiatives/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Update failed (${res.status})`);
      }
      // Optimistically merge so the field reflects the new value before the
      // network round-trip completes; refresh() catches up everything else.
      const next = await res.json().catch(() => null);
      if (next) {
        setInitiative(prev => (prev ? { ...prev, ...next } : prev));
      }
      refresh();
    },
    [id, refresh],
  );

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

        {/*
          Header card layout (top → bottom):
            1. Identity row: badges + title  ·  Promote-to-task (right)
            2. Action toolbar (always above the fold so it's never buried
               under a long description)
            3. Compact metadata strip — single row of inline-editable
               schedule + sizing + owner fields
            4. Description (large click-to-edit textarea)
            5. Status check (mono click-to-edit textarea)
          The Plan-with-PM panel mounts immediately AFTER this card, so
          opening it is visually anchored to the toolbar button rather
          than appearing far below.
        */}
        <header className="mb-4 p-5 rounded-lg bg-mc-bg-secondary border border-mc-border">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2">
                {/*
                  Kind badge is a click-target that opens the ConvertModal —
                  changing kind has migration semantics (e.g. story-only
                  promote) so it shouldn't be a flat inline select.
                */}
                <button
                  onClick={() => setShowConvertModal(true)}
                  title="Change kind (opens converter)"
                  className={`px-2 py-0.5 rounded text-xs uppercase tracking-wide hover:ring-1 hover:ring-mc-accent/40 ${KIND_BADGE[initiative.kind]}`}
                >
                  {initiative.kind}
                </button>
                <InlineSelect<Status>
                  value={initiative.status}
                  options={STATUS_OPTIONS}
                  onSave={next => patch({ status: next })}
                  className="text-xs uppercase"
                  renderDisplay={v => (
                    <span className="text-mc-text-secondary uppercase">{v}</span>
                  )}
                  label="Edit status"
                />
              </div>
              <InlineText
                value={initiative.title}
                onSave={next => patch({ title: next })}
                className="text-2xl font-semibold text-mc-text block"
                inputClassName="w-full px-2 py-1 rounded bg-mc-bg border border-mc-accent/60 text-mc-text outline-none text-2xl font-semibold"
                placeholder="Untitled"
                label="Edit title"
              />
            </div>
            <div className="shrink-0">
              <PromoteButton
                kind={initiative.kind}
                onClick={() => setShowPromoteModal(true)}
              />
            </div>
          </div>

          {/*
            Action toolbar — grouped left→right by intent:
              · AI helpers (Plan / Decompose) — primary, accent-tinted
              · Structural (Move / Convert kind / Add dependency)
              · Read-only (View history)
              · Destructive (Detach / Delete) — pushed to the far right
          */}
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-mc-border/60 pt-3">
            <ToolbarButton
              icon={<Sparkles className="w-3.5 h-3.5" />}
              onClick={openPlanPanel}
              accent
              title="PM proposes refined description / sizing / window"
            >
              Plan with PM
            </ToolbarButton>
            {(initiative.kind === 'epic' || initiative.kind === 'milestone') && (
              <ToolbarButton
                icon={<Sparkles className="w-3.5 h-3.5" />}
                onClick={() => setShowDecomposeModal(true)}
                accent
                title="Ask the PM to propose 3-7 child initiatives"
              >
                Decompose with PM
              </ToolbarButton>
            )}
            <span className="w-px h-5 bg-mc-border/60 mx-1" aria-hidden />
            <ToolbarButton icon={<MoveRight className="w-3.5 h-3.5" />} onClick={() => setShowMoveModal(true)}>
              Move
            </ToolbarButton>
            <ToolbarButton icon={<Shuffle className="w-3.5 h-3.5" />} onClick={() => setShowConvertModal(true)}>
              Convert kind
            </ToolbarButton>
            <ToolbarButton icon={<Link2 className="w-3.5 h-3.5" />} onClick={() => setShowAddDepModal(true)}>
              Add dependency
            </ToolbarButton>
            <span className="w-px h-5 bg-mc-border/60 mx-1" aria-hidden />
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

          {/*
            Compact metadata strip — one horizontal row of label/value
            pairs that wraps on small viewports. Replaces the prior 4×4
            grid + separate sizing grid (8 boxes of mostly empty space)
            so the toolbar above and description below stay close.
          */}
          <dl className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
            <MetaPair label="Target start">
              <InlineDate
                value={initiative.target_start ?? ''}
                onSave={next => patch({ target_start: next || null })}
                label="Edit target start"
              />
            </MetaPair>
            <MetaPair label="Target end">
              <InlineDate
                value={initiative.target_end ?? ''}
                onSave={next => patch({ target_end: next || null })}
                label="Edit target end"
              />
            </MetaPair>
            <MetaPair label="Committed">
              <InlineDate
                value={initiative.committed_end ?? ''}
                onSave={next => patch({ committed_end: next || null })}
                label="Edit committed end"
              />
            </MetaPair>
            <MetaPair label="Owner">
              <InlineSelect<string>
                value={initiative.owner_agent_id ?? ''}
                onSave={next =>
                  patch({ owner_agent_id: next.length > 0 ? next : null })
                }
                options={[
                  { value: '', label: 'Unassigned' },
                  ...agents.map(a => ({
                    value: a.id,
                    label: `${a.avatar_emoji}  ${a.name}  ${a.role}`,
                  })),
                ]}
                renderDisplay={v => {
                  const a = agents.find(x => x.id === v);
                  return a ? (
                    <span>
                      {a.avatar_emoji} {a.name}
                    </span>
                  ) : (
                    <span className="text-mc-text-secondary">—</span>
                  );
                }}
                label="Edit owner"
              />
            </MetaPair>
            <MetaPair label="Complexity">
              <InlineSelect<Complexity | ''>
                value={(initiative.complexity ?? '') as Complexity | ''}
                options={COMPLEXITY_OPTIONS}
                onSave={next => patch({ complexity: next || null })}
                renderDisplay={v =>
                  v ? <span>{v}</span> : <span className="text-mc-text-secondary">—</span>
                }
                label="Edit complexity"
              />
            </MetaPair>
            <MetaPair label="Effort (h)">
              <InlineText
                value={
                  initiative.estimated_effort_hours == null
                    ? ''
                    : String(initiative.estimated_effort_hours)
                }
                onSave={next =>
                  patch({
                    estimated_effort_hours: next === '' ? null : Number(next),
                  })
                }
                type="number"
                step="0.5"
                placeholder="—"
                label="Edit effort hours"
              />
            </MetaPair>
          </dl>

          {/* Description — the largest editable surface */}
          <div className="mt-5">
            <div className="uppercase tracking-wide text-[10px] text-mc-text-secondary/70 mb-1">
              Description
            </div>
            <InlineTextarea
              value={initiative.description ?? ''}
              onSave={next =>
                patch({ description: next.length > 0 ? next : null })
              }
              className="text-mc-text-secondary block"
              placeholder="Add a description…"
              minRows={6}
              label="Edit description"
            />
          </div>

          <div className="mt-4">
            <div className="uppercase tracking-wide text-[10px] text-mc-text-secondary/70 mb-1">
              Status check
            </div>
            <div className="p-3 rounded border border-mc-border/60 bg-mc-bg">
              <InlineTextarea
                value={initiative.status_check_md ?? ''}
                onSave={next =>
                  patch({ status_check_md: next.length > 0 ? next : null })
                }
                placeholder="Linked PR / waiting on / customer demo / etc."
                minRows={4}
                mono
                label="Edit status check"
              />
            </div>
          </div>
        </header>

        {/*
          Plan-with-PM panel — mounts inline directly under the header
          card so opening it is visually anchored to the toolbar button
          that triggered it. Wrapper carries a brief accent ring on open
          (1.8s) so the operator notices the panel appearing.
        */}
        {showPlanPanel && (
          <div
            ref={planPanelRef}
            className={`mb-6 transition-shadow duration-300 rounded-lg ${
              planPanelHighlight ? 'ring-2 ring-mc-accent/70 shadow-lg shadow-mc-accent/20' : ''
            }`}
          >
            <PlanWithPmPanel
              open={showPlanPanel}
              workspaceId={initiative.workspace_id}
              draft={{
                title: initiative.title,
                description: initiative.description ?? '',
                kind: initiative.kind,
                complexity: initiative.complexity,
                parent_initiative_id: initiative.parent_initiative_id,
                target_start: initiative.target_start,
                target_end: initiative.target_end,
              }}
              onClose={() => setShowPlanPanel(false)}
              onApply={async (_s, ctx) => {
                // Route through the proposal-accept endpoint with our
                // initiative id as the target. The server applies the
                // field updates *and* the suggested dependencies in one
                // transaction, flips the proposal to accepted, and
                // posts a real "Applied — N updated, M deps added"
                // banner instead of the old misleading "0 changes".
                try {
                  const res = await fetch(
                    `/api/pm/proposals/${ctx.proposalId}/accept`,
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ target_initiative_id: id }),
                    },
                  );
                  if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    throw new Error(data.error || `Apply failed (${res.status})`);
                  }
                  refresh();
                } catch (e) {
                  setActionError(
                    e instanceof Error ? e.message : 'Failed to apply suggestions',
                  );
                }
                setShowPlanPanel(false);
              }}
            />
          </div>
        )}

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
  accent,
  title,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
  destructive?: boolean;
  accent?: boolean;
  title?: string;
}) {
  // Three palettes:
  //   accent     — primary AI helpers (Plan / Decompose with PM)
  //   destructive — Detach / Delete
  //   default    — everything else
  const palette = destructive
    ? 'border-red-500/30 text-red-300 hover:bg-red-500/10 hover:border-red-500/50'
    : accent
      ? 'border-mc-accent/40 text-mc-accent bg-mc-accent/5 hover:bg-mc-accent/10'
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

function MetaPair({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="uppercase tracking-wide text-[10px] text-mc-text-secondary/70">
        {label}
      </dt>
      <dd className="text-mc-text">{children}</dd>
    </div>
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
