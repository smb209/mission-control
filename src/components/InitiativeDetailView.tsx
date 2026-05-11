'use client';

/**
 * Shared initiative-detail view used by both the standalone
 * /initiatives/[id] route (variant="full") and the master-detail right
 * pane on /initiatives (variant="pane"). Owns its own data fetching,
 * modal state, and patch lifecycle so the two callers don't duplicate
 * the 1300-line surface.
 *
 * Variants:
 *   - "full": renders the breadcrumb back-link, wraps in
 *     `min-h-screen p-6 max-w-4xl mx-auto` so it fills the page.
 *   - "pane": no back-link, no outer wrapper — the host page
 *     (PageWithRails main column) supplies the sizing/spacing.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
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
  Search,
  Activity,
  MoreHorizontal,
  List,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import DecomposeWithPmModal from '@/components/DecomposeWithPmModal';
import DecomposeStoryToTasksModal from '@/components/DecomposeStoryToTasksModal';
import { DecomposerAgentPicker, type DecomposerOption } from '@/components/inline/DecomposerAgentPicker';
import { InvestigatePicker, type InvestigateOption } from '@/components/inline/InvestigatePicker';
import InvestigateModal from '@/components/InvestigateModal';
import { NotesRail } from '@/components/notes/NotesRail';
import { InitiativeRunsStrip } from '@/components/initiative/InitiativeRunsStrip';
import { AuditProposalsSection } from '@/components/audit-proposals/AuditProposalsSection';
import { useAgentNotes } from '@/hooks/useAgentNotes';
import { countPriorAudits } from '@/components/inline/investigate-helpers';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { TaskModal } from '@/components/TaskModal';
import type { Task } from '@/lib/types';
import PlanWithPmPanel, {
  type PlanInitiativeSuggestions,
} from '@/components/PlanWithPmPanel';
import { InitiativeResearchSection } from '@/components/research/InitiativeResearchSection';
import {
  InlineText,
  InlineTextarea,
  InlineSelect,
  InlineDate,
} from '@/components/inline/InlineEdit';
import { SplitToolbarButton } from '@/components/inline/SplitToolbarButton';
// Reuse the action modals defined alongside the list page — Move / Convert /
// AddDep / History still make sense as focused dialogs since they have
// non-trivial side effects beyond a simple field write.
import {
  MoveModal,
  ConvertModal,
  AddDependencyModal,
  HistoryDrawer,
  type Initiative as ListInitiative,
} from '@/app/(app)/initiatives/page';

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
  is_pm?: number | boolean | null;
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

/**
 * Pill styling for each status. Mirrors STATUS_BADGE in
 * `(app)/initiatives/page.tsx` for the four notable states; adds
 * muted treatments for `planned` / `in_progress` so the picker
 * popover renders every option as a recognisable pill.
 *
 * Keep these two maps in sync — if you tweak a color here, update
 * the tree row map too (or factor both to a shared module).
 */
const STATUS_PILL: Record<Status, { label: string; className: string }> = {
  planned:     { label: 'planned',     className: 'bg-mc-bg-tertiary text-mc-text-secondary border border-mc-border' },
  in_progress: { label: 'in progress', className: 'bg-blue-500/15 text-blue-300 border border-blue-500/30' },
  at_risk:     { label: 'at risk',     className: 'bg-amber-500/15 text-amber-300 border border-amber-500/30' },
  blocked:     { label: 'blocked',     className: 'bg-red-500/15 text-red-300 border border-red-500/30' },
  done:        { label: 'done',        className: 'bg-green-500/15 text-green-300 border border-green-500/30' },
  cancelled:   { label: 'cancelled',   className: 'bg-red-500/15 text-red-300 border border-red-500/30' },
};

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

export interface InitiativeDetailViewProps {
  initiativeId: string;
  /** "full" renders breadcrumb + page-shell wrapper (used by the
   *  standalone /initiatives/[id] route). "pane" omits both so the
   *  caller can host it inside a PageWithRails main column. */
  variant: 'full' | 'pane';
  /** Called after a successful delete so the host can navigate / clear
   *  the master-detail selection. Defaults to no-op. */
  onDeleted?: () => void;
  /** Optional handler for in-pane navigation between initiatives:
   *  parent breadcrumb, child list rows, dependency rows. When
   *  provided, those click targets call this with the target id
   *  instead of navigating to the target's standalone /initiatives/[id]
   *  route — the master-detail host uses this to flip the selection
   *  and reveal the row in the rail. */
  onSelectInitiative?: (id: string) => void;
  /** Fired after any successful PATCH on the initiative so the host
   *  (e.g. the master-detail tree) can refetch its own state. The
   *  detail view already optimistically merges the changed fields
   *  locally, but tree rows are owned by the host page. */
  onChanged?: () => void;
  /** When true, render a floating bottom-right TOC FAB that scrolls to
   *  the visible sections. Only the standalone /initiatives/[id] route
   *  passes true — inside the planning-tree right pane the FAB would
   *  float over the wrong content. Default false. */
  showFloatingToc?: boolean;
}

export function InitiativeDetailView({
  initiativeId,
  variant,
  onDeleted,
  onSelectInitiative,
  onChanged,
  showFloatingToc = false,
}: InitiativeDetailViewProps) {
  const id = initiativeId;
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
  // Story → tasks decomposition (sibling of decompose for epics/milestones).
  const [showDecomposeStoryModal, setShowDecomposeStoryModal] = useState(false);
  const [decomposeStoryAgent, setDecomposeStoryAgent] = useState<{ id: string; label: string } | null>(null);
  // Generic destructive-action confirm. One slot is enough — we only ever
  // prompt for one action at a time. Replaces native window.confirm() so
  // the modal renders in the same visual style as the rest of the app and
  // is preview/automation-driveable.
  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string;
    body: React.ReactNode;
    confirmLabel: string;
    action: () => void;
  } | null>(null);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showConvertModal, setShowConvertModal] = useState(false);
  const [showAddDepModal, setShowAddDepModal] = useState(false);
  const [showHistoryDrawer, setShowHistoryDrawer] = useState(false);
  const [showPlanPanel, setShowPlanPanel] = useState(false);
  // True while there is a known unresolved draft proposal for this initiative.
  // Disables the "Plan with PM" button to prevent duplicate dispatches.
  const [hasDraftProposal, setHasDraftProposal] = useState(false);
  // True while there is a known unresolved draft decompose proposal.
  const [hasDraftDecomposeProposal, setHasDraftDecomposeProposal] = useState(false);
  // Once the initiative loads, check once for existing draft proposals so
  // we can surface them and prevent duplicate dispatches.
  const draftProposalCheckDone = useRef(false);
  // Operator guidance captured via the "Plan with PM ▾ → With guidance"
  // option in the toolbar split-button. Threaded into the initial PM
  // dispatch (POST body's `guidance` field). Cleared on panel close
  // so the next default click runs without stale guidance.
  const [planGuidance, setPlanGuidance] = useState<string | null>(null);
  // Brief accent-ring on the plan panel right after it opens, so the
  // operator notices it appearing inline under the header instead of
  // wondering whether the click did anything.
  const [planPanelHighlight, setPlanPanelHighlight] = useState(false);
  const planPanelRef = useRef<HTMLDivElement>(null);
  // Operator guidance for the initial Decompose dispatch. Same idea
  // as planGuidance but persists for the lifetime of the modal.
  const [decomposeHint, setDecomposeHint] = useState<string | null>(null);
  // Investigate ▾ — narrow-mode audit modal (PR 3 of
  // docs/archive/initiative-investigate.md). Subtree mode lives in PR 4.
  const [showInvestigateModal, setShowInvestigateModal] = useState(false);
  // PR 4 of docs/archive/initiative-investigate.md — subtree mode added.
  const [investigateMode, setInvestigateMode] = useState<'narrow' | 'subtree-proposal'>('narrow');
  // Selected task for the inline TaskModal — clicking a task in the
  // children list opens it here instead of navigating away.
  const [taskModalTask, setTaskModalTask] = useState<Task | null>(null);
  const [taskModalLoading, setTaskModalLoading] = useState<string | null>(null);
  const openTaskModal = useCallback(async (taskId: string) => {
    setTaskModalLoading(taskId);
    try {
      const res = await fetch(`/api/tasks/${taskId}`);
      if (!res.ok) throw new Error(`Failed to load task (${res.status})`);
      const t = (await res.json()) as Task;
      setTaskModalTask(t);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to open task');
    } finally {
      setTaskModalLoading(null);
    }
  }, []);

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

  // On first load, check for existing draft proposals (plan + decompose) to
  // surface them and disable the buttons that would create duplicates.
  useEffect(() => {
    if (!initiative || draftProposalCheckDone.current) return;
    draftProposalCheckDone.current = true;
    const ws = encodeURIComponent(initiative.workspace_id);
    const iid = encodeURIComponent(initiative.id);
    fetch(`/api/pm/plan-initiative?workspace_id=${ws}&target_initiative_id=${iid}`)
      .then(r => r.json())
      .then((body: { proposal?: unknown }) => {
        if (body?.proposal) {
          setHasDraftProposal(true);
          setShowPlanPanel(true);
        }
      })
      .catch(() => {});
    fetch(`/api/pm/decompose-initiative?workspace_id=${ws}&initiative_id=${iid}`)
      .then(r => r.json())
      .then((body: { proposal?: unknown }) => {
        if (body?.proposal) setHasDraftDecomposeProposal(true);
      })
      .catch(() => {});
  }, [initiative]);

  // Open the inline Plan-with-PM panel and pull it into view. The panel
  // mounts directly under the header card, but a long header can still
  // push it below the fold on smaller viewports — scrollIntoView + a
  // brief accent ring gives the operator unambiguous feedback that the
  // click landed. `guidance` is the optional steering text from the
  // toolbar split-button's "With guidance" popover.
  const openPlanPanel = useCallback((guidance?: string) => {
    setPlanGuidance(guidance && guidance.length > 0 ? guidance : null);
    setShowPlanPanel(true);
    setPlanPanelHighlight(true);
    requestAnimationFrame(() => {
      planPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    window.setTimeout(() => setPlanPanelHighlight(false), 1800);
  }, []);

  // Decomposer agent options for the story → tasks picker. Today only the
  // workspace PM has a task-decomposition prompt; other agents will be
  // added once Builder/Coordinator/custom prompts exist (the picker is
  // already shaped for it).
  // Notes scoped to this initiative — drives the NotesRail at the
  // bottom of the page and the "Build on prior audit" gate inside
  // the Investigate modal. Fetches even before `initiative` resolves
  // so the rail can render its own loading state; `id` alone is enough
  // since the API filters server-side by initiative_id.
  const initiativeNotes = useAgentNotes({ initiative_id: id, limit: 50 });
  const priorAuditCount = countPriorAudits(initiativeNotes.notes);

  const decomposerOptions: DecomposerOption[] = (() => {
    const out: DecomposerOption[] = [];
    const pm = agents.find(a => a.is_pm === 1 || a.is_pm === true || a.role === 'pm');
    if (pm) {
      out.push({
        id: pm.id,
        label: 'PM',
        description: 'Workspace PM. Proposes a small set of draft tasks the operator can review before promoting to Inbox.',
      });
    }
    return out;
  })();

  const openDecompose = useCallback((hint?: string) => {
    setDecomposeHint(hint && hint.length > 0 ? hint : null);
    setShowDecomposeModal(true);
  }, []);

  const closeDecompose = useCallback(() => {
    setShowDecomposeModal(false);
    setHasDraftDecomposeProposal(false);
  }, []);

  // Closes the plan panel AND clears any guidance so the next default
  // "Plan with PM" click runs from a clean baseline. Used by both
  // onClose and the post-Apply path inside the panel's onApply.
  const closePlanPanel = useCallback(() => {
    setShowPlanPanel(false);
    setPlanGuidance(null);
    setHasDraftProposal(false);
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
      // Notify the host (e.g. the initiatives tree) so its own copy of
      // the row reflects the change without a manual page reload.
      onChanged?.();
    },
    [id, refresh, onChanged],
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
  const deleteInitiative = useCallback(() => {
    if (!initiative) return;
    setPendingConfirm({
      title: `Delete "${initiative.title}"?`,
      body: 'This cannot be undone.',
      confirmLabel: 'Delete',
      action: async () => {
        setActionError(null);
        try {
          const res = await fetch(`/api/initiatives/${initiative.id}`, { method: 'DELETE' });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `Delete failed (${res.status})`);
          }
          // Host decides what "after delete" means: the standalone route
          // navigates back to /initiatives, the master-detail pane clears
          // the selection.
          if (onDeleted) {
            onDeleted();
          } else {
            router.push('/initiatives');
          }
        } catch (e) {
          setActionError(e instanceof Error ? e.message : 'Delete failed');
        }
      },
    });
  }, [initiative, router, onDeleted]);

  const deleteDraft = (taskId: string) => {
    setPendingConfirm({
      title: 'Delete this draft task?',
      body: 'This cannot be undone.',
      confirmLabel: 'Delete',
      action: async () => {
        setActionError(null);
        try {
          const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || `Delete failed (${res.status})`);
          }
          refresh();
        } catch (e) {
          setActionError(e instanceof Error ? e.message : 'Delete failed');
        }
      },
    });
  };

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

  // Wrapper classes vary by variant: "full" page-fills, "pane" defers
  // to the host (PageWithRails main column).
  const isFull = variant === 'full';
  const wrapperClass = isFull ? 'min-h-screen bg-mc-bg p-6' : '';
  const innerClass = isFull ? 'max-w-4xl mx-auto' : '';
  const errorInnerClass = isFull ? 'max-w-3xl mx-auto' : '';

  if (loading) {
    return (
      <div className={`${wrapperClass} text-mc-text-secondary`}>Loading…</div>
    );
  }
  if (error || !initiative) {
    return (
      <div className={wrapperClass}>
        <div className={`${errorInnerClass} p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm`}>
          {error || 'Initiative not found'}
        </div>
        {isFull && (
          <div className="max-w-3xl mx-auto mt-4">
            <Link href="/initiatives" className="text-mc-text-secondary hover:text-mc-text text-sm">
              ← Back to initiatives
            </Link>
          </div>
        )}
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
    <div className={wrapperClass}>
      <div className={innerClass}>
        {/* Breadcrumb: only the "← Initiatives" back-link is hidden in
            the pane variant (the master list IS the back target). The
            parent-of breadcrumb stays useful in both modes. */}
        {(isFull || initiative.parent_initiative_id) && (
          <div className="mb-4 flex items-center gap-2">
            {isFull && (
              <Link
                href="/initiatives"
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-mc-text-secondary hover:text-mc-text text-sm"
              >
                <ArrowLeft className="w-4 h-4" /> Initiatives
              </Link>
            )}
            {initiative.parent_initiative_id && (
              <>
                {isFull && <ChevronRight className="w-4 h-4 text-mc-text-secondary" />}
                {onSelectInitiative ? (
                  <button
                    type="button"
                    onClick={() => onSelectInitiative(initiative.parent_initiative_id!)}
                    className="text-mc-text-secondary hover:text-mc-text text-sm"
                    title="Select parent in the tree"
                  >
                    ↑ Parent: {titleFor(initiative.parent_initiative_id)}
                  </button>
                ) : (
                  <Link
                    href={`/initiatives/${initiative.parent_initiative_id}`}
                    className="text-mc-text-secondary hover:text-mc-text text-sm"
                  >
                    ↑ Parent: {titleFor(initiative.parent_initiative_id)}
                  </Link>
                )}
              </>
            )}
          </div>
        )}

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
          <div className="flex items-start gap-3">
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
                <StatusPickerPill
                  value={initiative.status}
                  onSave={next => patch({ status: next })}
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
          </div>

          {/*
            Action toolbar — restructured per Direction 1:
              · Primary row (left): labelled AI CTAs — Plan / Decompose / Investigate
              · Secondary icon strip (right via ml-auto): structural + read-only
                actions as 32×32 icon-only buttons with title= tooltips
              · Overflow ⋯ More: destructive (Detach / Delete) tucked behind
                a popover so they can't ml-auto orphan at narrow widths
          */}
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-mc-border/60 pt-3">
            <SplitToolbarButton
              icon={<Sparkles className="w-3.5 h-3.5" />}
              onClick={() => openPlanPanel()}
              onClickWithGuidance={(g) => openPlanPanel(g)}
              guidanceLabel="What should the PM focus the enrichment on?"
              guidancePlaceholder={`e.g. "size for v1 only — defer fertility/pregnancy features"
or "treat memory + checklist as MVP, exclude dashboard widgets"`}
              guidanceCta="Enrich with guidance"
              title={hasDraftProposal ? 'Resolve the existing draft proposal first' : 'Enrich with PM — proposes refined description / sizing / window'}
              disabled={hasDraftProposal}
            >
              Enrich
            </SplitToolbarButton>
            {(initiative.kind === 'theme' || initiative.kind === 'milestone' || initiative.kind === 'epic') && (
              <SplitToolbarButton
                icon={<Sparkles className="w-3.5 h-3.5" />}
                onClick={() => openDecompose()}
                onClickWithGuidance={(g) => openDecompose(g)}
                guidanceLabel="How should the PM split this?"
                guidancePlaceholder={`e.g. "split by frontend / backend / data"
or "carve out the onboarding flow as its own story first"`}
                guidanceCta="Split with guidance"
                title={hasDraftDecomposeProposal ? 'Resolve the existing draft split first' : 'Split with PM — propose 3-7 child initiatives'}
                disabled={hasDraftDecomposeProposal}
              >
                Split
              </SplitToolbarButton>
            )}
            {initiative.kind === 'story' && (
              <DecomposerAgentPicker
                icon={<Sparkles className="w-3.5 h-3.5" />}
                agents={decomposerOptions}
                onPick={(id, label) => {
                  setDecomposeStoryAgent({ id, label });
                  setShowDecomposeStoryModal(true);
                }}
                title="Create draft tasks from this story"
              >
                Create tasks
              </DecomposerAgentPicker>
            )}
            <InvestigatePicker
              options={INVESTIGATE_OPTIONS}
              onPick={(scope) => {
                setInvestigateMode(scope);
                setShowInvestigateModal(true);
              }}
            />
            {/* Everything that isn't a primary CTA lives behind one
                ⋯ overflow button, so the toolbar fits on a single
                line at desktop and the standard actions read with
                their full labels (icons-only are easy to misread). */}
            <OverflowMenu
              isStory={initiative.kind === 'story'}
              hasParent={!!initiative.parent_initiative_id}
              onPromote={() => setShowPromoteModal(true)}
              onMove={() => setShowMoveModal(true)}
              onConvertKind={() => setShowConvertModal(true)}
              onAddDependency={() => setShowAddDepModal(true)}
              onViewHistory={() => setShowHistoryDrawer(true)}
              onDetach={detach}
              onDelete={deleteInitiative}
            />
          </div>

          {/*
            Direction A metadata grid — two columns grouped by intent
            (Schedule / Sizing) at md+, single column stacked at narrow.
            Each row uses a fixed-width label column so the values line
            up vertically and the strip reads as a structured table
            instead of the prior wrap-anywhere flex chain.
          */}
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1 text-sm">
            <div>
              <div className="text-xs uppercase tracking-wide text-mc-text-secondary/70 mb-1.5">
                Schedule
              </div>
              <MetaRow label="target start">
                <InlineDate
                  value={initiative.target_start ?? ''}
                  onSave={next => patch({ target_start: next || null })}
                  label="Edit target start"
                />
              </MetaRow>
              <MetaRow label="target end">
                <InlineDate
                  value={initiative.target_end ?? ''}
                  onSave={next => patch({ target_end: next || null })}
                  label="Edit target end"
                />
              </MetaRow>
              <MetaRow label="committed">
                <InlineDate
                  value={initiative.committed_end ?? ''}
                  onSave={next => patch({ committed_end: next || null })}
                  label="Edit committed end"
                />
              </MetaRow>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-mc-text-secondary/70 mb-1.5">
                Sizing
              </div>
              <MetaRow label="owner">
                <OwnerPicker
                  value={initiative.owner_agent_id}
                  agents={agents}
                  onSave={async next => {
                    await patch({ owner_agent_id: next });
                  }}
                />
              </MetaRow>
              <MetaRow label="complexity">
                <InlineSelect<Complexity | ''>
                  value={(initiative.complexity ?? '') as Complexity | ''}
                  options={COMPLEXITY_OPTIONS}
                  onSave={next => patch({ complexity: next || null })}
                  renderDisplay={v =>
                    v ? <span>{v}</span> : <span className="text-mc-text-secondary">—</span>
                  }
                  label="Edit complexity"
                />
              </MetaRow>
              <MetaRow label="effort (h)">
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
              </MetaRow>
            </div>
          </div>

          {/* Description — the largest editable surface. Header
              sized to match the Section component so the eye can
              chunk these as page sections, not as field labels. */}
          <div id="description" className="mt-6 scroll-mt-20">
            <h2 className="font-medium text-mc-text mb-2">Description</h2>
            <InlineTextarea
              value={initiative.description ?? ''}
              onSave={next =>
                patch({ description: next.length > 0 ? next : null })
              }
              className="text-mc-text-secondary block"
              placeholder="Add a description…"
              minRows={6}
              label="Edit description"
              // Render the saved value as markdown so links, lists, and
              // headings show up. Editing falls back to the raw textarea.
              renderDisplay={v => (
                <div className="mc-md text-sm text-mc-text">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{v}</ReactMarkdown>
                </div>
              )}
              preWrap={false}
            />
          </div>

          <div id="status-check" className="mt-6 scroll-mt-20">
            <h2 className="font-medium text-mc-text mb-2">Status check</h2>
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
                renderDisplay={v => (
                  <div className="mc-md text-xs text-mc-text">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{v}</ReactMarkdown>
                  </div>
                )}
                preWrap={false}
              />
            </div>
          </div>

          {/* Research — initiative-scoped briefs + Suggest research /
              New brief entry points. Sits inside the header card
              alongside Description / Status check so the loop is
              visible even when the operator hasn't scrolled. */}
          <div className="mt-6">
            <InitiativeResearchSection
              workspaceId={initiative.workspace_id}
              initiativeId={initiative.id}
            />
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
              targetInitiativeId={initiative.id}
              initialGuidance={planGuidance}
              draft={{
                title: initiative.title,
                description: initiative.description ?? '',
                kind: initiative.kind,
                complexity: initiative.complexity,
                parent_initiative_id: initiative.parent_initiative_id,
                target_start: initiative.target_start,
                target_end: initiative.target_end,
              }}
              onClose={() => closePlanPanel()}
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
                closePlanPanel();
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
          <Section id="children" title={`Children (${initiative.children.length})`}>
            <ul className="space-y-1">
              {initiative.children.map(c => (
                <li
                  key={c.id}
                  className="flex items-center gap-2 p-2 rounded bg-mc-bg-secondary border border-mc-border"
                >
                  <span className={`px-2 py-0.5 rounded text-xs uppercase tracking-wide ${KIND_BADGE[c.kind]}`}>
                    {c.kind}
                  </span>
                  {onSelectInitiative ? (
                    <button
                      type="button"
                      onClick={() => onSelectInitiative(c.id)}
                      className="text-sm font-medium text-mc-text hover:text-mc-accent text-left"
                    >
                      {c.title}
                    </button>
                  ) : (
                    <Link
                      href={`/initiatives/${c.id}`}
                      className="text-sm font-medium text-mc-text hover:text-mc-accent"
                    >
                      {c.title}
                    </Link>
                  )}
                  <span
                    className={`ml-auto text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${STATUS_PILL[c.status].className}`}
                  >
                    {STATUS_PILL[c.status].label}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Tasks */}
        <Section id="tasks" title={`Tasks (${tasks.length})`}>
          {tasks.length === 0 ? (
            <p className="text-sm text-mc-text-secondary">
              No tasks yet. {initiative.kind === 'story' ? 'Use “Use as task” to create one directly, or “Create tasks” for an agent-drafted set.' : ''}
            </p>
          ) : (
            <div className="space-y-3">
              <TaskGroup
                label="Draft (planning)"
                rows={drafts}
                onPromote={promoteDraft}
                onDelete={deleteDraft}
                onOpen={openTaskModal}
                openingTaskId={taskModalLoading}
              />
              <TaskGroup label="Active" rows={active} onOpen={openTaskModal} openingTaskId={taskModalLoading} />
              {other.length > 0 && <TaskGroup label="Other" rows={other} onOpen={openTaskModal} openingTaskId={taskModalLoading} />}
              <TaskGroup label="Done" rows={done} onOpen={openTaskModal} openingTaskId={taskModalLoading} />
            </div>
          )}
        </Section>

        {/* Dependencies */}
        <Section id="dependencies" title="Dependencies" icon={<Link2 className="w-4 h-4" />}>
          {!deps || (deps.outgoing.length === 0 && deps.incoming.length === 0) ? (
            <p className="text-sm text-mc-text-secondary">No dependencies.</p>
          ) : (
            <ul className="text-sm space-y-1">
              {deps.outgoing.map(d => (
                <li key={d.id} className="text-mc-text-secondary">
                  depends on{' '}
                  {onSelectInitiative ? (
                    <button
                      type="button"
                      onClick={() => onSelectInitiative(d.depends_on_initiative_id)}
                      className="text-mc-text hover:text-mc-accent"
                    >
                      {titleFor(d.depends_on_initiative_id)}
                    </button>
                  ) : (
                    <Link
                      href={`/initiatives/${d.depends_on_initiative_id}`}
                      className="text-mc-text hover:text-mc-accent"
                    >
                      {titleFor(d.depends_on_initiative_id)}
                    </Link>
                  )}
                </li>
              ))}
              {deps.incoming.map(d => (
                <li key={d.id} className="text-mc-text-secondary">
                  blocks{' '}
                  {onSelectInitiative ? (
                    <button
                      type="button"
                      onClick={() => onSelectInitiative(d.initiative_id)}
                      className="text-mc-text hover:text-mc-accent"
                    >
                      {titleFor(d.initiative_id)}
                    </button>
                  ) : (
                    <Link
                      href={`/initiatives/${d.initiative_id}`}
                      className="text-mc-text hover:text-mc-accent"
                    >
                      {titleFor(d.initiative_id)}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Audit Proposals — operator-facing review queue produced by
            the subtree-audit pipeline. Auto-hides when there's nothing
            to show. See docs/archive/subtree-audit-proposals-spec.md §8. */}
        <div id="audit-proposals" className="scroll-mt-20">
          <AuditProposalsSection initiativeId={initiative.id} />
        </div>

        {/* Activity — live + recent agent_runs touching this initiative.
            Closes the "what did I just queue?" gap after page refresh and
            gives investigations a durable surface beyond the dispatch
            toast. See docs/archive/audit-actions-and-tracking.md PR 2. */}
        <Section id="activity" title="Activity" icon={<Activity className="w-4 h-4" />}>
          <InitiativeRunsStrip
            workspaceId={initiative.workspace_id}
            initiativeId={initiative.id}
          />
        </Section>

        {/* Notes — agent-generated observations for this initiative.
            Surface for the Investigate flow's take_note output. Filters
            to scoped notes only (no child-task rollup) since the audit
            writes its report row directly against this initiative_id. */}
        <Section id="notes" title="Notes" icon={<Search className="w-4 h-4" />}>
          <NotesRail
            initiative_id={initiative.id}
            workspace_id={initiative.workspace_id}
            limit={50}
            title=""
          />
        </Section>

        {/* History */}
        <Section id="parent-history" title="Parent-change history" icon={<History className="w-4 h-4" />}>
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
          existingDraftCount={drafts.length}
          existingActiveCount={active.length}
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
          initialHint={decomposeHint}
          onClose={() => { closeDecompose(); setDecomposeHint(null); }}
          onAccepted={() => {
            closeDecompose();
            setDecomposeHint(null);
            refresh();
          }}
        />
      )}
      {showDecomposeStoryModal && initiative.kind === 'story' && (
        <DecomposeStoryToTasksModal
          initiative={{
            id: initiative.id,
            title: initiative.title,
            kind: initiative.kind,
            workspace_id: initiative.workspace_id,
          }}
          agentId={decomposeStoryAgent?.id ?? null}
          agentLabel={decomposeStoryAgent?.label}
          onClose={() => setShowDecomposeStoryModal(false)}
          onAccepted={() => {
            setShowDecomposeStoryModal(false);
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
      {showInvestigateModal && (
        <InvestigateModal
          initiative={{
            id: initiative.id,
            title: initiative.title,
            workspace_id: initiative.workspace_id,
          }}
          priorAuditCount={priorAuditCount}
          mode={investigateMode}
          onClose={() => setShowInvestigateModal(false)}
          onDispatched={() => {
            // Modal swaps to a persistent confirmation panel — DO NOT
            // close here (audit-actions PR 3). The operator dismisses
            // via "Done" or jumps to the Activity strip via "View
            // activity" (handled by onViewActivity below).
          }}
          onViewActivity={() => {
            setShowInvestigateModal(false);
            // Defer one frame so the modal's unmount completes before
            // we scroll, otherwise the modal's overflow:hidden parent
            // wins and the scroll is a no-op.
            requestAnimationFrame(() => {
              const heading = Array.from(
                document.querySelectorAll('h2, h3'),
              ).find((el) => el.textContent?.trim() === 'Activity');
              heading?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            });
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
      {taskModalTask && (
        <TaskModal
          task={taskModalTask}
          workspaceId={initiative.workspace_id}
          onClose={() => {
            setTaskModalTask(null);
            // Refresh in case status / counts changed inside the modal so
            // the children list reflects the latest state.
            refresh();
          }}
        />
      )}
      {showFloatingToc && (
        <DetailTOC
          sections={[
            { id: 'description', label: 'Description', visible: true },
            { id: 'status-check', label: 'Status check', visible: true },
            { id: 'research', label: 'Research', visible: true },
            { id: 'audit-proposals', label: 'Audit Proposals', visible: true },
            {
              id: 'children',
              label: 'Children',
              visible: !!initiative.children && initiative.children.length > 0,
            },
            { id: 'tasks', label: 'Tasks', visible: true },
            { id: 'dependencies', label: 'Dependencies', visible: true },
            { id: 'activity', label: 'Activity', visible: true },
            { id: 'notes', label: 'Notes', visible: true },
            { id: 'parent-history', label: 'Parent-change history', visible: true },
          ].filter(s => s.visible)}
        />
      )}
      <ConfirmDialog
        open={pendingConfirm !== null}
        title={pendingConfirm?.title ?? ''}
        body={pendingConfirm?.body ?? null}
        confirmLabel={pendingConfirm?.confirmLabel ?? 'Confirm'}
        destructive
        onConfirm={() => {
          const c = pendingConfirm;
          setPendingConfirm(null);
          c?.action();
        }}
        onCancel={() => setPendingConfirm(null)}
      />
    </div>
  );
}

// Investigate ▾ menu items. Subtree mode lands in PR 4 of
// docs/archive/initiative-investigate.md.
const INVESTIGATE_OPTIONS: InvestigateOption[] = [
  {
    id: 'narrow',
    label: 'Just this initiative (narrow)',
    description: 'One researcher dispatch. Reads description, status check, and direct child tasks.',
  },
  {
    id: 'subtree-proposal',
    label: 'Whole subtree (bottom-up)',
    description: 'MC fans researchers across non-terminal descendants layer by layer, then synthesizes typed proposals at the root.',
  },
];

/**
 * IconButton — square 32×32 icon-only toolbar button used in the
 * secondary action strip. Icon is the only child; the full label is
 * exposed via aria-label + title so screen readers and hover tooltips
 * still convey what the button does. Keep the height in sync with the
 * SplitToolbarButton primary CTAs (text-xs px-2.5 py-1.5 → ~32px tall)
 * so the two strips align on the same row.
 */
/**
 * Single labelled row inside the OverflowMenu popover. Consistent
 * height + icon-gap so all the menu items line up vertically. The
 * destructive variant flips to a red palette so Delete reads as a
 * different class of action.
 */
function MenuItem({
  icon,
  onClick,
  destructive,
  children,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  const palette = destructive
    ? 'text-red-300 hover:bg-red-500/10'
    : 'text-mc-text-secondary hover:text-mc-text hover:bg-mc-bg';
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`w-full text-left px-2 py-1.5 rounded text-xs inline-flex items-center gap-2 ${palette}`}
    >
      {icon} {children}
    </button>
  );
}

/**
 * Overflow ⋯ button + popover with destructive actions. Mirrors
 * InvestigatePicker's outside-click + Escape dismissal so the pattern
 * reads consistently across the toolbar. Detach is conditional on
 * having a parent; Delete renders with red text always.
 */
function OverflowMenu({
  isStory,
  hasParent,
  onPromote,
  onMove,
  onConvertKind,
  onAddDependency,
  onViewHistory,
  onDetach,
  onDelete,
}: {
  isStory: boolean;
  hasParent: boolean;
  onPromote: () => void;
  onMove: () => void;
  onConvertKind: () => void;
  onAddDependency: () => void;
  onViewHistory: () => void;
  onDetach: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Inline closure so menu items don't have to remember to close
  // the popover after firing their handler.
  const wrap = (handler: () => void) => () => {
    setOpen(false);
    handler();
  };

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More actions"
        onClick={() => setOpen(o => !o)}
        className={`inline-flex items-center justify-center w-8 h-8 rounded border border-mc-border text-mc-text-secondary hover:text-mc-text hover:border-mc-accent/40 ${
          open ? 'bg-mc-accent/10' : ''
        }`}
      >
        <MoreHorizontal className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-30 min-w-[12rem] rounded-md border border-mc-border bg-mc-bg-secondary shadow-lg p-1"
        >
          {/* Standard actions, in the order they used to appear in
              the toolbar's icon strip. Promote is hidden on
              non-story kinds (the previous icon-strip rendered it
              disabled with a tooltip; the menu treatment is to
              just omit it). */}
          {isStory && (
            <MenuItem icon={<Plus className="w-3.5 h-3.5" />} onClick={wrap(onPromote)}>
              Use as task
            </MenuItem>
          )}
          <MenuItem icon={<MoveRight className="w-3.5 h-3.5" />} onClick={wrap(onMove)}>
            Move
          </MenuItem>
          <MenuItem icon={<Shuffle className="w-3.5 h-3.5" />} onClick={wrap(onConvertKind)}>
            Convert kind
          </MenuItem>
          <MenuItem icon={<Link2 className="w-3.5 h-3.5" />} onClick={wrap(onAddDependency)}>
            Add dependency
          </MenuItem>
          <MenuItem icon={<History className="w-3.5 h-3.5" />} onClick={wrap(onViewHistory)}>
            View history
          </MenuItem>

          {/* Destructive group — separated by a divider + red palette
              so the eye registers them as a different class of action. */}
          <div className="my-1 border-t border-mc-border/60" aria-hidden />
          {hasParent && (
            <MenuItem
              icon={<CornerUpLeft className="w-3.5 h-3.5" />}
              onClick={wrap(onDetach)}
            >
              Detach
            </MenuItem>
          )}
          <MenuItem
            icon={<Trash2 className="w-3.5 h-3.5" />}
            onClick={wrap(onDelete)}
            destructive
          >
            Delete
          </MenuItem>
        </div>
      )}
    </div>
  );
}

/**
 * One row in the Direction A metadata grid — fixed-width uppercase label
 * column on the left so values line up vertically across the Schedule /
 * Sizing groups.
 */
function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1">
      <span className="uppercase tracking-wide text-xs text-mc-text-secondary/70 w-24 shrink-0">
        {label}
      </span>
      <span className="text-mc-text min-w-0">{children}</span>
    </div>
  );
}

/**
 * Floating bottom-right table-of-contents FAB. Click opens a popover
 * above the button with the visible-section anchors; clicking an
 * anchor smooth-scrolls to that id. Outside-click + Escape close the
 * popover, matching InvestigatePicker's dismissal pattern.
 *
 * Only mounts when InitiativeDetailView is rendered with
 * showFloatingToc — i.e. the standalone /initiatives/[id] page. Inside
 * the planning-tree right pane the FAB would float over the wrong
 * content.
 */
function DetailTOC({
  sections,
}: {
  sections: { id: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="fixed bottom-6 right-6 z-30">
      {open && (
        <div
          role="menu"
          aria-label="Jump to section"
          className="absolute bottom-full right-0 mb-2 min-w-[14rem] rounded-md border border-mc-border bg-mc-bg-secondary shadow-lg p-1"
        >
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-mc-text-secondary/70">
            Jump to section
          </div>
          {sections.map(s => (
            <a
              key={s.id}
              href={`#${s.id}`}
              role="menuitem"
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(s.id)?.scrollIntoView({
                  block: 'start',
                  behavior: 'smooth',
                });
                setOpen(false);
              }}
              className="block px-2 py-1.5 rounded text-sm text-mc-text hover:bg-mc-bg"
            >
              {s.label}
            </a>
          ))}
        </div>
      )}
      <button
        type="button"
        aria-label="Table of contents"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Jump to section"
        onClick={() => setOpen(o => !o)}
        className="w-12 h-12 rounded-full bg-mc-accent text-white hover:bg-mc-accent/90 shadow-lg flex items-center justify-center"
      >
        <List className="w-5 h-5" />
      </button>
    </div>
  );
}

function Section({
  id,
  title,
  icon,
  children,
}: {
  /** Optional anchor id for in-page navigation (e.g. the floating TOC FAB).
   *  Adds `scroll-mt-20` so the heading isn't tucked under any sticky chrome
   *  after a smooth-scroll. */
  id?: string;
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="mb-6 p-4 rounded-lg bg-mc-bg-secondary border border-mc-border scroll-mt-20"
    >
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
  onDelete,
  onOpen,
  openingTaskId,
}: {
  label: string;
  rows: TaskRow[];
  onPromote?: (taskId: string) => void;
  onDelete?: (taskId: string) => void;
  onOpen?: (taskId: string) => void;
  openingTaskId?: string | null;
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
            {onOpen ? (
              <button
                type="button"
                onClick={() => onOpen(t.id)}
                disabled={openingTaskId === t.id}
                className="text-sm text-mc-text flex-1 text-left hover:text-mc-accent disabled:opacity-60"
                title="Open task in modal"
              >
                {t.title}
                {openingTaskId === t.id && (
                  <span className="ml-2 text-[10px] text-mc-text-secondary">opening…</span>
                )}
              </button>
            ) : (
              <span className="text-sm text-mc-text flex-1">{t.title}</span>
            )}
            {onPromote && t.status === 'draft' && (
              <button
                onClick={() => onPromote(t.id)}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-mc-accent/15 text-mc-accent border border-mc-accent/30 hover:bg-mc-accent/25"
                title="Promote draft to execution queue (status → inbox)"
              >
                <Send className="w-3 h-3" /> Promote
              </button>
            )}
            {onDelete && t.status === 'draft' && (
              <button
                onClick={() => onDelete(t.id)}
                className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded text-mc-text-secondary border border-mc-border hover:text-red-300 hover:border-red-500/40"
                title="Delete this draft"
              >
                <Trash2 className="w-3 h-3" />
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
  existingDraftCount,
  existingActiveCount,
  onClose,
  onSaved,
}: {
  initiative: Initiative;
  existingDraftCount: number;
  existingActiveCount: number;
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
        <h2 className="text-lg font-semibold mb-4">Use story as task</h2>
        <p className="text-sm text-mc-text-secondary mb-4">
          Creates one task in <code>status=draft</code>, linked to this initiative,
          using this story's title and description directly (no agent). The draft
          lives on the task board's Draft column until you explicitly promote it
          to the execution queue.
        </p>
        {existingDraftCount + existingActiveCount > 0 && (
          <div className="mb-4 p-3 rounded bg-amber-500/10 border border-amber-500/30 text-amber-200 text-sm">
            This story already has{' '}
            <strong>
              {existingDraftCount + existingActiveCount} non-done task
              {existingDraftCount + existingActiveCount === 1 ? '' : 's'}
            </strong>
            {existingDraftCount > 0 && existingActiveCount > 0
              ? ` (${existingDraftCount} draft, ${existingActiveCount} active)`
              : existingDraftCount > 0
                ? ` (draft${existingDraftCount === 1 ? '' : 's'})`
                : ` (active)`}
            . Create another only if you genuinely need a parallel task.
          </div>
        )}
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
              Create draft task
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Status pill + popover picker. Replaces the native-select InlineSelect
 * specifically for status so the trigger AND every option in the
 * popover render as the colored pill the operator will see in the
 * tree once the change saves. Keeps focus + outside-click behavior
 * sane so the popover dismisses cleanly.
 */
function StatusPickerPill({
  value,
  onSave,
}: {
  value: Status;
  onSave: (next: Status) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = async (next: Status) => {
    if (next === value) {
      setOpen(false);
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await onSave(next);
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const current = STATUS_PILL[value];

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={saving}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Edit status"
        title="Change status"
        className={`px-2 py-0.5 rounded text-xs uppercase tracking-wide hover:ring-1 hover:ring-mc-accent/40 disabled:opacity-50 ${current.className}`}
      >
        {current.label}
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label="Status options"
          className="absolute left-0 mt-1 z-30 min-w-[10rem] p-1 rounded-md border border-mc-border bg-mc-bg-secondary shadow-lg flex flex-col gap-1"
        >
          {STATUS_OPTIONS.map(opt => {
            const pill = STATUS_PILL[opt.value];
            const selected = opt.value === value;
            return (
              <li key={opt.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => pick(opt.value)}
                  disabled={saving}
                  className={`w-full text-left px-2 py-0.5 rounded text-xs uppercase tracking-wide ${pill.className} ${
                    selected ? 'ring-1 ring-mc-accent/60' : 'hover:ring-1 hover:ring-mc-accent/40'
                  } disabled:opacity-50`}
                >
                  {pill.label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {err && (
        <span className="ml-2 text-[11px] text-red-400">{err}</span>
      )}
    </div>
  );
}

/**
 * Owner picker — replaces the native <select> InlineSelect specifically
 * for the owner field. The native dropdown was rendering disconnected
 * from the trigger (browser-controlled positioning anchors the selected
 * option onto the trigger; with a long agent list the popup would land
 * far below the actual row). This custom popover mirrors the
 * StatusPickerPill pattern: anchored directly under the trigger with
 * `top-full mt-1`, scoped to the trigger's relative parent, with
 * outside-click + Escape dismissal.
 *
 * Selecting an option saves immediately — no Save / Cancel ActionRow,
 * since picker semantics are "this row IS the choice".
 */
function OwnerPicker({
  value,
  agents,
  onSave,
}: {
  value: string | null;
  agents: AgentLite[];
  onSave: (next: string | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = async (next: string | null) => {
    if (next === value) {
      setOpen(false);
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await onSave(next);
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const current = agents.find(a => a.id === value) ?? null;

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={saving}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Edit owner"
        title="Change owner"
        className="text-left hover:text-mc-accent disabled:opacity-50"
      >
        {current ? (
          <span>
            {current.avatar_emoji} {current.name}
          </span>
        ) : (
          <span className="text-mc-text-secondary/60 italic">Click to set</span>
        )}
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label="Owner options"
          className="absolute left-0 top-full mt-1 z-30 min-w-[14rem] max-h-72 overflow-auto p-1 rounded-md border border-mc-border bg-mc-bg-secondary shadow-lg"
        >
          <li>
            <button
              type="button"
              role="option"
              aria-selected={current === null}
              onClick={() => pick(null)}
              disabled={saving}
              className={`w-full text-left px-2 py-1.5 rounded text-xs text-mc-text-secondary hover:bg-mc-bg ${
                current === null ? 'ring-1 ring-mc-accent/60' : ''
              } disabled:opacity-50`}
            >
              Unassigned
            </button>
          </li>
          {agents.map(a => {
            const selected = a.id === value;
            return (
              <li key={a.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => pick(a.id)}
                  disabled={saving}
                  className={`w-full text-left px-2 py-1.5 rounded text-xs inline-flex items-center gap-2 text-mc-text hover:bg-mc-bg ${
                    selected ? 'ring-1 ring-mc-accent/60' : ''
                  } disabled:opacity-50`}
                >
                  <span>{a.avatar_emoji}</span>
                  <span>{a.name}</span>
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-mc-text-secondary">
                    {a.role}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {err && (
        <span className="ml-2 text-[11px] text-red-400">{err}</span>
      )}
    </div>
  );
}
