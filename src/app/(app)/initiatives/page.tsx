'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import {
  Plus,
  ChevronRight,
  ChevronDown,
  Pencil,
  Trash2,
  MoveRight,
  Shuffle,
  Link2,
  History,
  Send,
  CornerUpLeft,
  Sparkles,
  Network,
  FileText,
  CalendarRange,
  ExternalLink,
} from 'lucide-react';
import Drawer from '@/components/Drawer';
import ActionMenu, { ActionMenuItem } from '@/components/ActionMenu';
import PlanWithPmPanel, { type PlanInitiativeSuggestions } from '@/components/PlanWithPmPanel';
import DecomposeWithPmModal from '@/components/DecomposeWithPmModal';
import { showAlertDialog } from '@/lib/show-alert';

// Local types (kept separate from src/lib/types.ts so Phase 1 doesn't touch
// the central type module — Phase 2 can promote these once the broader API
// surface stabilises).
export type Kind = 'theme' | 'milestone' | 'epic' | 'story';
export type Status = 'planned' | 'in_progress' | 'at_risk' | 'blocked' | 'done' | 'cancelled';

export interface Initiative {
  id: string;
  workspace_id: string;
  parent_initiative_id: string | null;
  kind: Kind;
  title: string;
  description: string | null;
  status: Status;
  target_start: string | null;
  target_end: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface TreeNode extends Initiative {
  children: TreeNode[];
}

// Counts of tasks linked to an initiative, broken out by status family so
// the tree can render "3 tasks: 1 draft, 2 active" inline.
interface TaskCounts {
  total: number;
  draft: number;
  active: number;
  done: number;
}

// Minimal agent shape for the owner dropdown — just what we render plus the
// id we persist. The /api/agents endpoint returns the full Agent shape; we
// don't need most of it here.
interface AgentLite {
  id: string;
  name: string;
  role: string;
  avatar_emoji: string;
  workspace_id: string;
}

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

const KIND_BADGE: Record<Kind, string> = {
  theme: 'bg-purple-500/20 text-purple-300',
  milestone: 'bg-amber-500/20 text-amber-300',
  epic: 'bg-blue-500/20 text-blue-300',
  story: 'bg-emerald-500/20 text-emerald-300',
};

const WORKSPACE_ID = 'default';

const SHOW_CANCELLED_LS_KEY = 'mc:initiatives:show_cancelled';

// Toggle persisted across the URL (`?show_cancelled=1`) so links survive
// reload + are shareable. localStorage is the fallback default when the
// URL has no opinion. URL value, when present, wins over localStorage.
function useShowCancelled(): [boolean, (next: boolean) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlValue = searchParams.get('show_cancelled');

  const initial = (() => {
    if (urlValue === '1') return true;
    if (urlValue === '0') return false;
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem(SHOW_CANCELLED_LS_KEY) === '1';
    }
    return false;
  })();

  const [value, setValue] = useState<boolean>(initial);

  useEffect(() => {
    if (urlValue === '1') setValue(true);
    else if (urlValue === '0') setValue(false);
  }, [urlValue]);

  const update = useCallback(
    (next: boolean) => {
      setValue(next);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(SHOW_CANCELLED_LS_KEY, next ? '1' : '0');
      }
      const params = new URLSearchParams(searchParams.toString());
      if (next) params.set('show_cancelled', '1');
      else params.delete('show_cancelled');
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname, searchParams],
  );

  return [value, update];
}

export default function InitiativesPage() {
  const [flat, setFlat] = useState<Initiative[]>([]);
  const [taskCounts, setTaskCounts] = useState<Record<string, TaskCounts>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Initiative | null>(null);
  const [creating, setCreating] = useState<{ parent_id: string | null } | null>(null);
  const [moving, setMoving] = useState<Initiative | null>(null);
  const [converting, setConverting] = useState<Initiative | null>(null);
  const [promoting, setPromoting] = useState<Initiative | null>(null);
  const [historyFor, setHistoryFor] = useState<Initiative | null>(null);
  const [addingDepFor, setAddingDepFor] = useState<Initiative | null>(null);
  const [decomposing, setDecomposing] = useState<Initiative | null>(null);
  const [showCancelled, setShowCancelled] = useShowCancelled();

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [iRes, tRes] = await Promise.all([
        fetch(`/api/initiatives?workspace_id=${WORKSPACE_ID}`),
        fetch(`/api/tasks?workspace_id=${WORKSPACE_ID}`),
      ]);
      if (!iRes.ok) throw new Error(`Failed to load (${iRes.status})`);
      const rows: Initiative[] = await iRes.json();
      setFlat(rows);

      // Count tasks per initiative_id, partitioned by status family.
      const counts: Record<string, TaskCounts> = {};
      if (tRes.ok) {
        const tasks: Array<{ initiative_id: string | null; status: string }> = await tRes.json();
        for (const t of tasks) {
          if (!t.initiative_id) continue;
          const entry =
            counts[t.initiative_id] ||
            (counts[t.initiative_id] = { total: 0, draft: 0, active: 0, done: 0 });
          entry.total += 1;
          if (t.status === 'draft') entry.draft += 1;
          else if (t.status === 'done') entry.done += 1;
          else if (ACTIVE_STATUSES.has(t.status)) entry.active += 1;
        }
      }
      setTaskCounts(counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Tree + picker list derive from flat + the cancelled-filter toggle.
  // Cancelled rows are spliced out and their non-cancelled children
  // re-parent to the cancelled row's effective parent so the subtree
  // doesn't get orphaned.
  const tree = useMemo(() => buildTree(flat, !showCancelled), [flat, showCancelled]);
  const pickableInitiatives = useMemo(
    () => (showCancelled ? flat : flat.filter(i => i.status !== 'cancelled')),
    [flat, showCancelled],
  );
  const cancelledCount = useMemo(
    () => flat.filter(i => i.status === 'cancelled').length,
    [flat],
  );

  // Detach = move to no parent. Surfaced from the action menu when the
  // initiative currently has a parent.
  const detach = useCallback(
    async (init: Initiative) => {
      try {
        const res = await fetch(`/api/initiatives/${init.id}/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to_parent_id: null, reason: 'detach' }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          showAlertDialog('Detach failed', body.error || 'Detach failed');
          return;
        }
        refresh();
      } catch (e) {
        showAlertDialog('Detach failed', e instanceof Error ? e.message : 'Detach failed');
      }
    },
    [refresh],
  );

  return (
    <div className="min-h-screen bg-mc-bg p-6">
      <header className="max-w-5xl mx-auto mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-mc-text">Initiatives</h1>
          <p className="text-sm text-mc-text-secondary">Planning tree (Phase 1 — list view).</p>
        </div>
        <div className="flex items-center gap-2">
          {/* "Workspaces" button removed — global workspace switcher lives
              in the unified left nav now. */}
          <label
            className="inline-flex items-center gap-1.5 text-xs text-mc-text-secondary cursor-pointer select-none"
            title="Toggle visibility of cancelled initiatives. Persisted in URL (?show_cancelled=1) and localStorage."
          >
            <input
              type="checkbox"
              className="accent-mc-accent"
              checked={showCancelled}
              onChange={e => setShowCancelled(e.target.checked)}
            />
            Show cancelled
            {cancelledCount > 0 && (
              <span className="text-[11px] text-mc-text-secondary/70">({cancelledCount})</span>
            )}
          </label>
          <button
            onClick={() => setCreating({ parent_id: null })}
            className="px-3 py-2 rounded-lg bg-mc-accent text-white hover:bg-mc-accent/90 text-sm flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> New initiative
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto">
        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
            {error}
          </div>
        )}
        {loading ? (
          <p className="text-mc-text-secondary">Loading…</p>
        ) : tree.length === 0 ? (
          <p className="text-mc-text-secondary">No initiatives yet. Click <em>New initiative</em> to start a planning tree.</p>
        ) : (
          <ul className="space-y-1">
            {tree.map(node => (
              <InitiativeRow
                key={node.id}
                node={node}
                depth={0}
                allInitiatives={flat}
                pickableInitiatives={pickableInitiatives}
                taskCounts={taskCounts}
                onEdit={setEditing}
                onAddChild={parent => setCreating({ parent_id: parent.id })}
                onMove={setMoving}
                onConvert={setConverting}
                onPromote={setPromoting}
                onShowHistory={setHistoryFor}
                onAddDependency={setAddingDepFor}
                onDetach={detach}
                onDecompose={setDecomposing}
                onDelete={async (init) => {
                  if (!confirm(`Delete "${init.title}"?`)) return;
                  const res = await fetch(`/api/initiatives/${init.id}`, { method: 'DELETE' });
                  if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    showAlertDialog('Delete failed', body.error || 'Delete failed');
                    return;
                  }
                  refresh();
                }}
              />
            ))}
          </ul>
        )}
      </main>

      {creating && (
        <CreateModal
          parentId={creating.parent_id}
          allInitiatives={pickableInitiatives}
          onClose={() => setCreating(null)}
          onSaved={() => {
            setCreating(null);
            refresh();
          }}
        />
      )}
      <EditDrawer
        initiative={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
      />
      {moving && (
        <MoveModal
          initiative={moving}
          allInitiatives={pickableInitiatives}
          onClose={() => setMoving(null)}
          onSaved={() => {
            setMoving(null);
            refresh();
          }}
        />
      )}
      {converting && (
        <ConvertModal
          initiative={converting}
          onClose={() => setConverting(null)}
          onSaved={() => {
            setConverting(null);
            refresh();
          }}
        />
      )}
      {promoting && (
        <PromoteModal
          initiative={promoting}
          onClose={() => setPromoting(null)}
          onSaved={() => {
            setPromoting(null);
            refresh();
          }}
        />
      )}
      {historyFor && (
        <HistoryDrawer
          initiative={historyFor}
          allInitiatives={flat}
          onClose={() => setHistoryFor(null)}
        />
      )}
      {addingDepFor && (
        <AddDependencyModal
          initiative={addingDepFor}
          allInitiatives={pickableInitiatives}
          onClose={() => setAddingDepFor(null)}
          onSaved={() => {
            setAddingDepFor(null);
            refresh();
          }}
        />
      )}
      {decomposing && (
        <DecomposeWithPmModal
          initiative={decomposing}
          onClose={() => setDecomposing(null)}
          onAccepted={() => {
            setDecomposing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function buildTree(rows: Initiative[], hideCancelled: boolean): TreeNode[] {
  const byId = new Map(rows.map(r => [r.id, r] as const));
  const isHidden = (r: Initiative | undefined) =>
    !!r && hideCancelled && r.status === 'cancelled';

  // If a parent is hidden (cancelled), walk up until we hit a visible
  // ancestor — that's where the visible child should attach so the
  // subtree doesn't render as orphaned root rows.
  function effectiveParent(parentId: string | null): string | null {
    if (parentId == null) return null;
    const p = byId.get(parentId);
    if (!p) return null;
    if (isHidden(p)) return effectiveParent(p.parent_initiative_id);
    return parentId;
  }

  const visible = rows.filter(r => !isHidden(r));
  const byParent = new Map<string | null, Initiative[]>();
  for (const r of visible) {
    const k = effectiveParent(r.parent_initiative_id);
    const list = byParent.get(k) ?? [];
    list.push(r);
    byParent.set(k, list);
  }
  function build(parentId: string | null): TreeNode[] {
    const kids = byParent.get(parentId) ?? [];
    return kids.map(k => ({ ...k, children: build(k.id) }));
  }
  return build(null);
}

function InitiativeRow({
  node,
  depth,
  allInitiatives,
  pickableInitiatives,
  taskCounts,
  onEdit,
  onAddChild,
  onMove,
  onConvert,
  onPromote,
  onShowHistory,
  onAddDependency,
  onDetach,
  onDecompose,
  onDelete,
}: {
  node: TreeNode;
  depth: number;
  allInitiatives: Initiative[];
  pickableInitiatives: Initiative[];
  taskCounts: Record<string, TaskCounts>;
  onEdit: (init: Initiative) => void;
  onAddChild: (parent: Initiative) => void;
  onMove: (init: Initiative) => void;
  onConvert: (init: Initiative) => void;
  onPromote: (init: Initiative) => void;
  onShowHistory: (init: Initiative) => void;
  onAddDependency: (init: Initiative) => void;
  onDetach: (init: Initiative) => void;
  onDelete: (init: Initiative) => void;
  onDecompose: (init: Initiative) => void;
}) {
  // Two independent expansion states. Earlier the single `expanded`
  // controlled the details panel AND children stayed always-rendered,
  // which made the tree exhausting to navigate (collapsing a parent
  // didn't actually collapse the subtree below). Splitting into two
  // gestures:
  //   1. Chevron toggles CHILDREN visibility (default: expanded).
  //      Collapsing shows a compact "(N direct, M total)" summary.
  //   2. Clicking the title toggles the DETAILS panel inline (description
  //      + dependencies + parent-history). Default: collapsed.
  // Plus an explicit ExternalLink icon next to the title that navigates
  // to /initiatives/[id] for the full-page edit UI.
  const [childrenExpanded, setChildrenExpanded] = useState(true);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const counts = taskCounts[node.id];
  const isStory = node.kind === 'story';
  const isContainer = node.kind !== 'story';
  const hasParent = !!node.parent_initiative_id;
  const isDecomposable = node.kind === 'epic' || node.kind === 'milestone';

  // Direct + total descendant counts for the collapsed-children summary.
  // useMemo keeps the recursion off the render hot path; node identity
  // changes when the parent reflows after a CRUD operation.
  const directChildrenCount = node.children.length;
  const totalDescendantCount = useMemo(() => {
    function walk(n: TreeNode): number {
      let total = n.children.length;
      for (const c of n.children) total += walk(c);
      return total;
    }
    return walk(node);
  }, [node]);

  // High-frequency actions ("Promote to task" for stories, "Add child" for
  // containers) get inline labelled buttons; everything else is in the ⋮
  // overflow menu.
  const menuItems: ActionMenuItem[] = [
    { label: 'Edit', icon: <Pencil className="w-3.5 h-3.5" />, onClick: () => onEdit(node) },
    ...(isDecomposable
      ? [
          {
            label: 'Decompose with PM',
            icon: <Network className="w-3.5 h-3.5" />,
            onClick: () => onDecompose(node),
          },
        ]
      : []),
    { label: 'Move', icon: <MoveRight className="w-3.5 h-3.5" />, onClick: () => onMove(node) },
    { label: 'Convert kind', icon: <Shuffle className="w-3.5 h-3.5" />, onClick: () => onConvert(node) },
    { label: 'Add dependency', icon: <Link2 className="w-3.5 h-3.5" />, onClick: () => onAddDependency(node) },
    { label: 'View history', icon: <History className="w-3.5 h-3.5" />, onClick: () => onShowHistory(node) },
    ...(hasParent
      ? [
          {
            label: 'Detach (no parent)',
            icon: <CornerUpLeft className="w-3.5 h-3.5" />,
            onClick: () => onDetach(node),
          },
        ]
      : []),
    {
      label: 'Delete',
      icon: <Trash2 className="w-3.5 h-3.5" />,
      onClick: () => onDelete(node),
      destructive: true,
    },
  ];

  return (
    <>
      <li
        className={`flex items-center gap-2 p-2 rounded-lg bg-mc-bg-secondary border border-mc-border hover:border-mc-accent/40 ${
          node.status === 'cancelled' ? 'opacity-60' : ''
        }`}
        style={{ marginLeft: depth * 24 }}
      >
        <button
          title={
            childrenExpanded
              ? `Collapse subtree (${directChildrenCount} direct, ${totalDescendantCount} total)`
              : `Expand subtree (${directChildrenCount} direct, ${totalDescendantCount} total)`
          }
          onClick={() => setChildrenExpanded(v => !v)}
          aria-label={childrenExpanded ? 'Collapse subtree' : 'Expand subtree'}
          aria-expanded={childrenExpanded}
          disabled={directChildrenCount === 0}
          className="p-1 rounded hover:bg-mc-bg text-mc-text-secondary hover:text-mc-text disabled:opacity-30 disabled:hover:bg-transparent"
        >
          {childrenExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <span className={`px-2 py-0.5 rounded text-xs uppercase tracking-wide ${KIND_BADGE[node.kind]}`}>
          {node.kind}
        </span>
        <button
          type="button"
          onClick={() => setDetailsExpanded(v => !v)}
          aria-expanded={detailsExpanded}
          aria-label={detailsExpanded ? `Hide details for ${node.title}` : `Show details for ${node.title}`}
          title={detailsExpanded ? 'Hide details (description + dependencies + history)' : 'Show details (description + dependencies + history)'}
          className="font-medium text-mc-text hover:text-mc-accent text-left cursor-pointer"
        >
          {node.title}
        </button>
        <Link
          href={`/initiatives/${node.id}`}
          title="Open the full initiative page (edit UI, full description, etc.)"
          aria-label={`Open ${node.title} detail page`}
          className="text-mc-text-secondary hover:text-mc-accent inline-flex items-center"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </Link>
        {node.status === 'cancelled' ? (
          <span
            className="text-[11px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/30"
            title="This initiative is cancelled"
          >
            cancelled
          </span>
        ) : (
          <span className="text-xs text-mc-text-secondary">{node.status}</span>
        )}
        {!childrenExpanded && directChildrenCount > 0 && (
          <span
            className="text-[11px] text-mc-text-secondary/80"
            title={`${directChildrenCount} direct children, ${totalDescendantCount} total descendants in collapsed subtree`}
          >
            · {directChildrenCount} direct
            {totalDescendantCount > directChildrenCount && `, ${totalDescendantCount} total`}
          </span>
        )}
        {counts && counts.total > 0 && (
          <span
            className="text-[11px] text-mc-text-secondary"
            title={`${counts.total} tasks: ${counts.draft} draft, ${counts.active} active, ${counts.done} done`}
          >
            · {counts.total} task{counts.total === 1 ? '' : 's'}
            {counts.draft > 0 && (
              <span className="ml-1 px-1 rounded bg-slate-500/20 text-slate-300">{counts.draft} draft</span>
            )}
            {counts.active > 0 && (
              <span className="ml-1 px-1 rounded bg-blue-500/20 text-blue-300">{counts.active} active</span>
            )}
            {counts.done > 0 && (
              <span className="ml-1 px-1 rounded bg-emerald-500/20 text-emerald-300">{counts.done} done</span>
            )}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {isStory && (
            <button
              title="Create a draft task linked to this initiative"
              onClick={() => onPromote(node)}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-mc-accent/15 text-mc-accent border border-mc-accent/30 hover:bg-mc-accent/25"
            >
              <Send className="w-3 h-3" /> Promote to task
            </button>
          )}
          {isContainer && (
            <button
              title="Add a child initiative under this one"
              onClick={() => onAddChild(node)}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-mc-border text-mc-text-secondary hover:text-mc-text hover:border-mc-accent/40"
            >
              <Plus className="w-3 h-3" /> Add child
            </button>
          )}
          <ActionMenu items={menuItems} ariaLabel={`Actions for ${node.title}`} />
        </div>
      </li>
      {detailsExpanded && (
        <li
          className="rounded-lg bg-mc-bg border border-mc-border/60 px-3 py-2 -mt-1 text-sm"
          style={{ marginLeft: depth * 24 + 12 }}
        >
          <DetailsPanel
            initiative={node}
            allInitiatives={allInitiatives}
            pickableInitiatives={pickableInitiatives}
          />
          <div className="mt-2 pt-2 border-t border-mc-border/60 flex justify-end">
            <Link
              href={`/initiatives/${node.id}`}
              className="text-xs text-mc-text-secondary hover:text-mc-accent inline-flex items-center gap-1"
            >
              <ExternalLink className="w-3 h-3" /> Open full page
            </Link>
          </div>
        </li>
      )}
      {childrenExpanded &&
        node.children.map(c => (
          <InitiativeRow
            key={c.id}
            node={c}
            depth={depth + 1}
            allInitiatives={allInitiatives}
            pickableInitiatives={pickableInitiatives}
            taskCounts={taskCounts}
            onEdit={onEdit}
            onAddChild={onAddChild}
            onMove={onMove}
            onConvert={onConvert}
            onPromote={onPromote}
            onShowHistory={onShowHistory}
            onAddDependency={onAddDependency}
            onDetach={onDetach}
            onDecompose={onDecompose}
            onDelete={onDelete}
          />
        ))}
    </>
  );
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

function DetailsPanel({
  initiative,
  allInitiatives,
  pickableInitiatives,
}: {
  initiative: Initiative;
  allInitiatives: Initiative[];
  pickableInitiatives: Initiative[];
}) {
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [deps, setDeps] = useState<DepEdges | null>(null);
  const [adding, setAdding] = useState(false);
  const [chosenDep, setChosenDep] = useState<string>('');
  const [err, setErr] = useState<string | null>(null);

  const titleFor = useCallback(
    (id: string | null) => (id ? allInitiatives.find(i => i.id === id)?.title ?? id : '(root)'),
    [allInitiatives],
  );

  const refresh = useCallback(async () => {
    try {
      const [h, d] = await Promise.all([
        fetch(`/api/initiatives/${initiative.id}/history`).then(r => r.json()),
        fetch(`/api/initiatives/${initiative.id}/dependencies`).then(r => r.json()),
      ]);
      setHistory(Array.isArray(h) ? h : []);
      setDeps(d && d.outgoing ? d : { outgoing: [], incoming: [] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load details');
    }
  }, [initiative.id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addDep = async () => {
    if (!chosenDep) return;
    setErr(null);
    try {
      const res = await fetch(`/api/initiatives/${initiative.id}/dependencies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ depends_on_initiative_id: chosenDep }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Add failed (${res.status})`);
      }
      setAdding(false);
      setChosenDep('');
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Add failed');
    }
  };

  const removeDep = async (depId: string) => {
    setErr(null);
    try {
      const res = await fetch(`/api/initiative-dependencies/${depId}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Remove failed (${res.status})`);
      }
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Remove failed');
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-2 text-mc-text-secondary mb-1">
          <FileText className="w-3.5 h-3.5" />
          <span className="font-medium">Description</span>
        </div>
        {initiative.description ? (
          <p className="text-xs text-mc-text whitespace-pre-wrap">{initiative.description}</p>
        ) : (
          <p className="text-xs text-mc-text-secondary italic">No description.</p>
        )}
      </div>
      {(initiative.target_start || initiative.target_end) && (
        <div>
          <div className="flex items-center gap-2 text-mc-text-secondary mb-1">
            <CalendarRange className="w-3.5 h-3.5" />
            <span className="font-medium">Target window</span>
          </div>
          <p className="text-xs text-mc-text">
            {initiative.target_start ? initiative.target_start.slice(0, 10) : '—'} → {initiative.target_end ? initiative.target_end.slice(0, 10) : '—'}
          </p>
        </div>
      )}
      <div>
        <div className="flex items-center gap-2 text-mc-text-secondary mb-1">
          <Link2 className="w-3.5 h-3.5" />
          <span className="font-medium">Dependencies</span>
          <button
            onClick={() => setAdding(v => !v)}
            className="ml-auto text-xs px-2 py-0.5 rounded border border-mc-border hover:border-mc-accent/40"
          >
            {adding ? 'Cancel' : '+ Add dependency'}
          </button>
        </div>
        {adding && (
          <div className="flex items-center gap-2 mb-2">
            <select
              className="px-2 py-1 rounded bg-mc-bg border border-mc-border text-xs flex-1"
              value={chosenDep}
              onChange={e => setChosenDep(e.target.value)}
            >
              <option value="">(choose initiative this depends on)</option>
              {pickableInitiatives
                .filter(i => i.id !== initiative.id)
                .map(i => (
                  <option key={i.id} value={i.id}>
                    {i.kind} — {i.title}
                  </option>
                ))}
            </select>
            <button
              disabled={!chosenDep}
              onClick={addDep}
              className="text-xs px-2 py-1 rounded bg-mc-accent text-white disabled:opacity-50"
            >
              Add
            </button>
          </div>
        )}
        {deps === null ? (
          <p className="text-xs text-mc-text-secondary">Loading…</p>
        ) : deps.outgoing.length === 0 && deps.incoming.length === 0 ? (
          <p className="text-xs text-mc-text-secondary">No dependencies.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {deps.outgoing.map(d => (
              <li key={d.id} className="flex items-center gap-2">
                <span className="text-mc-text-secondary">depends on</span>
                <span className="text-mc-text">{titleFor(d.depends_on_initiative_id)}</span>
                <button
                  onClick={() => removeDep(d.id)}
                  className="ml-auto text-mc-text-secondary hover:text-red-400"
                  title="Remove"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
            {deps.incoming.map(d => (
              <li key={d.id} className="flex items-center gap-2 text-mc-text-secondary">
                <span>blocks</span>
                <span>{titleFor(d.initiative_id)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="flex items-center gap-2 text-mc-text-secondary mb-1">
          <History className="w-3.5 h-3.5" />
          <span className="font-medium">Parent-change history</span>
        </div>
        {history.length === 0 ? (
          <p className="text-xs text-mc-text-secondary">No moves recorded.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {history.map(h => (
              <li key={h.id} className="flex items-center gap-2">
                <span className="text-mc-text-secondary">{h.created_at.replace('T', ' ').slice(0, 19)}</span>
                <span className="text-mc-text">
                  {titleFor(h.from_parent_id)} → {titleFor(h.to_parent_id)}
                </span>
                {h.reason && <span className="text-mc-text-secondary italic">— {h.reason}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {err && <div className="text-xs text-red-400">{err}</div>}
    </div>
  );
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div
        className="bg-mc-bg-secondary border border-mc-border rounded-lg p-6 w-full max-w-md text-mc-text"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-4">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function CreateModal({
  parentId,
  allInitiatives,
  onClose,
  onSaved,
}: {
  parentId: string | null;
  allInitiatives: Initiative[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<Kind>('story');
  const [chosenParent, setChosenParent] = useState<string | null>(parentId);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch('/api/initiatives', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: WORKSPACE_ID,
          title,
          kind,
          parent_initiative_id: chosenParent,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Create failed (${res.status})`);
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title="New initiative" onClose={onClose}>
      <div className="space-y-3">
        <label className="block">
          <span className="text-sm text-mc-text-secondary">Title</span>
          <input
            className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border"
            value={title}
            onChange={e => setTitle(e.target.value)}
            autoFocus
          />
        </label>
        <label className="block">
          <span className="text-sm text-mc-text-secondary">Kind</span>
          <select
            className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border"
            value={kind}
            onChange={e => setKind(e.target.value as Kind)}
          >
            <option value="theme">theme</option>
            <option value="milestone">milestone</option>
            <option value="epic">epic</option>
            <option value="story">story</option>
          </select>
        </label>
        <label className="block">
          <span className="text-sm text-mc-text-secondary">Parent</span>
          <select
            className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border"
            value={chosenParent ?? ''}
            onChange={e => setChosenParent(e.target.value || null)}
          >
            <option value="">(no parent)</option>
            {allInitiatives.map(i => (
              <option key={i.id} value={i.id}>
                {i.kind} — {i.title}
              </option>
            ))}
          </select>
        </label>
        {err && <div className="text-red-400 text-sm">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-2 rounded border border-mc-border text-mc-text-secondary text-sm">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting || !title}
            className="px-3 py-2 rounded bg-mc-accent text-white disabled:opacity-50 text-sm"
          >
            Create
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

type Complexity = 'S' | 'M' | 'L' | 'XL';

/**
 * Edit drawer — slide-over replacement for the prior narrow modal.
 *
 * Renders nothing when `initiative` is null so the parent can keep using a
 * single piece of state (`editing`) to control open/close.
 *
 * Fields are grouped into vertical sections: Identity, Sizing, Schedule,
 * Ownership, Status check. The Save button lives in a sticky footer so it
 * stays reachable when the form scrolls. All save semantics are preserved
 * from the previous modal.
 */
export function EditDrawer({
  initiative,
  onClose,
  onSaved,
}: {
  initiative: Initiative | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<Status>('planned');
  const [targetStart, setTargetStart] = useState('');
  const [targetEnd, setTargetEnd] = useState('');
  const [committedEnd, setCommittedEnd] = useState('');
  const [complexity, setComplexity] = useState<Complexity | ''>('');
  const [effort, setEffort] = useState('');
  const [statusCheck, setStatusCheck] = useState('');
  const [ownerAgentId, setOwnerAgentId] = useState('');
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  // The plan panel needs a stable draft snapshot — re-running the plan
  // on every keystroke would spam the synthesizer. We snapshot the form
  // state at the moment the operator clicks "Plan with PM".
  const [planDraft, setPlanDraft] = useState<{
    title: string;
    description: string;
    complexity?: 'S' | 'M' | 'L' | 'XL';
    target_start?: string | null;
    target_end?: string | null;
    parent_initiative_id?: string | null;
  } | null>(null);

  // Reset form state when a new initiative is opened.
  useEffect(() => {
    if (!initiative) return;
    setTitle(initiative.title);
    setDescription(initiative.description ?? '');
    setStatus(initiative.status);
    setTargetStart(initiative.target_start ?? '');
    setTargetEnd(initiative.target_end ?? '');
    setCommittedEnd('');
    setComplexity('');
    setEffort('');
    setStatusCheck('');
    setOwnerAgentId('');
    setLoaded(false);
    setErr(null);
    setPlanOpen(false);
    setPlanDraft(null);
  }, [initiative]);

  // Pull the full record so we have the optional fields not in the list view.
  useEffect(() => {
    if (!initiative) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/initiatives/${initiative.id}`);
        if (!r.ok) return;
        const full = await r.json();
        if (cancelled) return;
        setComplexity((full.complexity as Complexity) ?? '');
        setEffort(full.estimated_effort_hours == null ? '' : String(full.estimated_effort_hours));
        setStatusCheck(full.status_check_md ?? '');
        setOwnerAgentId(full.owner_agent_id ?? '');
        setCommittedEnd(full.committed_end ?? '');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initiative]);

  // Fetch the agents list once when the drawer opens. The /api/agents
  // endpoint already filters by workspace_id, matching the pattern used by
  // /pm/page.tsx and /workspace/[slug]/page.tsx.
  useEffect(() => {
    if (!initiative) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/agents?workspace_id=${encodeURIComponent(initiative.workspace_id)}`);
        if (!r.ok) return;
        const list = await r.json();
        if (cancelled) return;
        setAgents(Array.isArray(list) ? list : []);
      } finally {
        if (!cancelled) setAgentsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initiative]);

  const submit = async () => {
    if (!initiative) return;
    setSubmitting(true);
    setErr(null);
    try {
      const patch: Record<string, unknown> = {
        title,
        description: description || null,
        status,
        target_start: targetStart || null,
        target_end: targetEnd || null,
        committed_end: committedEnd || null,
        complexity: complexity || null,
        estimated_effort_hours: effort ? Number(effort) : null,
        status_check_md: statusCheck || null,
        owner_agent_id: ownerAgentId || null,
      };
      const res = await fetch(`/api/initiatives/${initiative.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Update failed (${res.status})`);
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setSubmitting(false);
    }
  };

  // Enter-to-save anywhere in the form (except inside textareas where Enter
  // is a newline).
  const onFormKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && (e.target as HTMLElement).tagName !== 'TEXTAREA') {
      e.preventDefault();
      if (title && !submitting) submit();
    }
  };

  return (
    <Drawer
      open={!!initiative}
      title={initiative ? `Edit "${initiative.title}"` : 'Edit initiative'}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          {err && <div className="text-red-400 text-sm mr-auto self-center">{err}</div>}
          <button
            onClick={() => {
              if (!title) return;
              // Snapshot the current draft. The panel re-fetches on open
              // so re-clicking after edits triggers a fresh plan.
              setPlanDraft({
                title,
                description,
                complexity: complexity || undefined,
                target_start: targetStart || null,
                target_end: targetEnd || null,
                parent_initiative_id: initiative?.parent_initiative_id ?? null,
              });
              setPlanOpen(true);
            }}
            disabled={!title}
            className="px-3 py-2 rounded border border-mc-accent/50 text-mc-accent text-sm inline-flex items-center gap-1 disabled:opacity-50"
            title="Ask the PM agent to suggest description / complexity / window / dependencies"
          >
            <Sparkles className="w-3.5 h-3.5" /> Plan with PM
          </button>
          <button
            onClick={onClose}
            className="px-3 py-2 rounded border border-mc-border text-mc-text-secondary text-sm"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting || !title}
            className="px-3 py-2 rounded bg-mc-accent text-white disabled:opacity-50 text-sm"
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      }
    >
      <form onKeyDown={onFormKey} onSubmit={e => e.preventDefault()} className="space-y-6">
        <FormSection heading="Identity">
          <label className="block">
            <span className="text-sm text-mc-text-secondary">Title</span>
            <input
              className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border"
              value={title}
              onChange={e => setTitle(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-sm text-mc-text-secondary">Description</span>
            <textarea
              className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border h-28"
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </label>
        </FormSection>

        <FormSection heading="Sizing">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-sm text-mc-text-secondary">Complexity</span>
              <select
                className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border"
                value={complexity}
                onChange={e => setComplexity(e.target.value as Complexity | '')}
                disabled={!loaded}
              >
                <option value="">(unset)</option>
                <option value="S">S</option>
                <option value="M">M</option>
                <option value="L">L</option>
                <option value="XL">XL</option>
              </select>
            </label>
            <label className="block">
              <span className="text-sm text-mc-text-secondary">Effort (hours)</span>
              <input
                type="number"
                step="0.5"
                className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border"
                value={effort}
                onChange={e => setEffort(e.target.value)}
                disabled={!loaded}
              />
            </label>
          </div>
        </FormSection>

        <FormSection heading="Schedule">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-sm text-mc-text-secondary">Target start</span>
              <input
                type="date"
                className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border"
                value={targetStart.slice(0, 10)}
                onChange={e => setTargetStart(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-sm text-mc-text-secondary">Target end</span>
              <input
                type="date"
                className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border"
                value={targetEnd.slice(0, 10)}
                onChange={e => setTargetEnd(e.target.value)}
              />
            </label>
            <label className="block col-span-2">
              <span className="text-sm text-mc-text-secondary">Committed end</span>
              <input
                type="date"
                className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border"
                value={committedEnd.slice(0, 10)}
                onChange={e => setCommittedEnd(e.target.value)}
                disabled={!loaded}
              />
            </label>
          </div>
        </FormSection>

        <FormSection heading="Ownership">
          <label className="block">
            <span className="text-sm text-mc-text-secondary">Owner agent</span>
            <select
              className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border"
              value={ownerAgentId}
              onChange={e => setOwnerAgentId(e.target.value)}
              disabled={!loaded || !agentsLoaded}
            >
              <option value="">Unassigned</option>
              {agents.map(a => (
                <option key={a.id} value={a.id}>
                  {a.avatar_emoji}  {a.name}  {a.role}
                </option>
              ))}
            </select>
            {agentsLoaded && agents.length === 0 && (
              <p className="text-xs text-mc-text-secondary mt-1">
                No agents in this workspace yet.
              </p>
            )}
          </label>
          <label className="block">
            <span className="text-sm text-mc-text-secondary">Status</span>
            <select
              className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border"
              value={status}
              onChange={e => setStatus(e.target.value as Status)}
            >
              <option value="planned">planned</option>
              <option value="in_progress">in_progress</option>
              <option value="at_risk">at_risk</option>
              <option value="blocked">blocked</option>
              <option value="done">done</option>
              <option value="cancelled">cancelled</option>
            </select>
          </label>
        </FormSection>

        <FormSection heading="Status check">
          <label className="block">
            <span className="text-sm text-mc-text-secondary">Markdown — linked PR / waiting on / customer demo / etc.</span>
            <textarea
              className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border h-28 font-mono text-xs"
              value={statusCheck}
              onChange={e => setStatusCheck(e.target.value)}
              disabled={!loaded}
              placeholder="Linked PR / waiting on / customer demo / etc."
            />
          </label>
        </FormSection>

        {planOpen && planDraft && initiative && (
          <PlanWithPmPanel
            open={planOpen}
            workspaceId={initiative.workspace_id}
            draft={planDraft}
            onClose={() => setPlanOpen(false)}
            onApply={s => {
              // EditDrawer is still a "fill-the-form, then Save" UX —
              // we don't go through the proposal-accept path here
              // because the operator may keep tweaking before clicking
              // Save (which then PATCHes everything in one shot). The
              // proposal-id is ignored on this path; the field-level
              // population mirrors what the PM suggested.
              if (s.refined_description) setDescription(s.refined_description);
              if (s.complexity) setComplexity(s.complexity);
              if (s.target_start) setTargetStart(s.target_start);
              if (s.target_end) setTargetEnd(s.target_end);
              if (s.status_check_md) setStatusCheck(s.status_check_md);
              setPlanOpen(false);
            }}
          />
        )}
      </form>
    </Drawer>
  );
}

function FormSection({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-xs uppercase tracking-wide text-mc-text-secondary">{heading}</h3>
      {children}
    </section>
  );
}

export function MoveModal({
  initiative,
  allInitiatives,
  onClose,
  onSaved,
}: {
  initiative: Initiative;
  allInitiatives: Initiative[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [parentId, setParentId] = useState<string | null>(initiative.parent_initiative_id);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Filter out self — the API will also reject cycles, but trim the
  // obvious case from the picker.
  const candidates = allInitiatives.filter(i => i.id !== initiative.id);

  const submit = async () => {
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch(`/api/initiatives/${initiative.id}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to_parent_id: parentId, reason: reason || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Move failed (${res.status})`);
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Move failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title={`Move "${initiative.title}"`} onClose={onClose}>
      <div className="space-y-3">
        <label className="block">
          <span className="text-sm text-mc-text-secondary">New parent</span>
          <select
            className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border"
            value={parentId ?? ''}
            onChange={e => setParentId(e.target.value || null)}
          >
            <option value="">(no parent)</option>
            {candidates.map(i => (
              <option key={i.id} value={i.id}>
                {i.kind} — {i.title}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-sm text-mc-text-secondary">Reason (optional)</span>
          <input
            className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border"
            value={reason}
            onChange={e => setReason(e.target.value)}
          />
        </label>
        {err && <div className="text-red-400 text-sm">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-2 rounded border border-mc-border text-mc-text-secondary text-sm">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="px-3 py-2 rounded bg-mc-accent text-white disabled:opacity-50 text-sm"
          >
            Move
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

export function ConvertModal({
  initiative,
  onClose,
  onSaved,
}: {
  initiative: Initiative;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [newKind, setNewKind] = useState<Kind>(initiative.kind);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch(`/api/initiatives/${initiative.id}/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_kind: newKind, reason: reason || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Convert failed (${res.status})`);
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Convert failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title={`Convert "${initiative.title}"`} onClose={onClose}>
      <div className="space-y-3">
        <label className="block">
          <span className="text-sm text-mc-text-secondary">New kind</span>
          <select
            className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border"
            value={newKind}
            onChange={e => setNewKind(e.target.value as Kind)}
          >
            <option value="theme">theme</option>
            <option value="milestone">milestone</option>
            <option value="epic">epic</option>
            <option value="story">story</option>
          </select>
        </label>
        <label className="block">
          <span className="text-sm text-mc-text-secondary">Reason (optional)</span>
          <input
            className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border"
            value={reason}
            onChange={e => setReason(e.target.value)}
          />
        </label>
        {err && <div className="text-red-400 text-sm">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-2 rounded border border-mc-border text-mc-text-secondary text-sm">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="px-3 py-2 rounded bg-mc-accent text-white disabled:opacity-50 text-sm"
          >
            Convert
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function PromoteModal({
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
    <ModalShell title={`Promote "${initiative.title}" to task draft`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-mc-text-secondary">
          Creates one task in <code>status=draft</code>, linked to this initiative.
          The draft stays on the planning board until you promote it to the
          execution queue.
        </p>
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
            className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border h-24"
            value={description}
            onChange={e => setDescription(e.target.value)}
          />
        </label>
        {err && <div className="text-red-400 text-sm">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-2 rounded border border-mc-border text-mc-text-secondary text-sm">
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
    </ModalShell>
  );
}

/**
 * Standalone "Add dependency" modal — fired from the action menu, since the
 * inline DetailsPanel only appears when the row is expanded.
 */
export function AddDependencyModal({
  initiative,
  allInitiatives,
  onClose,
  onSaved,
}: {
  initiative: Initiative;
  allInitiatives: Initiative[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [chosen, setChosen] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!chosen) return;
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch(`/api/initiatives/${initiative.id}/dependencies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ depends_on_initiative_id: chosen }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Add failed (${res.status})`);
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Add failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell title={`Add dependency for "${initiative.title}"`} onClose={onClose}>
      <div className="space-y-3">
        <label className="block">
          <span className="text-sm text-mc-text-secondary">This initiative depends on…</span>
          <select
            className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border"
            value={chosen}
            onChange={e => setChosen(e.target.value)}
            autoFocus
          >
            <option value="">(choose initiative)</option>
            {allInitiatives
              .filter(i => i.id !== initiative.id)
              .map(i => (
                <option key={i.id} value={i.id}>
                  {i.kind} — {i.title}
                </option>
              ))}
          </select>
        </label>
        {err && <div className="text-red-400 text-sm">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="px-3 py-2 rounded border border-mc-border text-mc-text-secondary text-sm">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting || !chosen}
            className="px-3 py-2 rounded bg-mc-accent text-white disabled:opacity-50 text-sm"
          >
            Add
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/**
 * Read-only history drawer launched from the action menu. Reuses the
 * Drawer shell so it matches the edit affordance shape.
 */
export function HistoryDrawer({
  initiative,
  allInitiatives,
  onClose,
}: {
  initiative: Initiative;
  allInitiatives: Initiative[];
  onClose: () => void;
}) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/initiatives/${initiative.id}/history`);
        const body = r.ok ? await r.json() : [];
        if (!cancelled) setRows(Array.isArray(body) ? body : []);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : 'Failed to load');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initiative.id]);

  const titleFor = (id: string | null) =>
    id ? allInitiatives.find(i => i.id === id)?.title ?? id : '(root)';

  return (
    <Drawer open={true} title={`History — ${initiative.title}`} onClose={onClose}>
      {err && <div className="text-red-400 text-sm">{err}</div>}
      {rows === null ? (
        <p className="text-sm text-mc-text-secondary">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-mc-text-secondary">No moves recorded.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {rows.map(h => (
            <li key={h.id} className="p-2 rounded border border-mc-border bg-mc-bg">
              <div className="text-xs text-mc-text-secondary">
                {h.created_at.replace('T', ' ').slice(0, 19)}
              </div>
              <div className="text-mc-text">
                {titleFor(h.from_parent_id)} → {titleFor(h.to_parent_id)}
              </div>
              {h.reason && (
                <div className="text-xs text-mc-text-secondary italic mt-1">— {h.reason}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
