'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Plus, ChevronRight, ChevronDown, Pencil, Trash2, MoveRight, Shuffle, Link2, History, Send } from 'lucide-react';

// Local types (kept separate from src/lib/types.ts so Phase 1 doesn't touch
// the central type module — Phase 2 can promote these once the broader API
// surface stabilises).
type Kind = 'theme' | 'milestone' | 'epic' | 'story';
type Status = 'planned' | 'in_progress' | 'at_risk' | 'blocked' | 'done' | 'cancelled';

interface Initiative {
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

export default function InitiativesPage() {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [flat, setFlat] = useState<Initiative[]>([]);
  const [taskCounts, setTaskCounts] = useState<Record<string, TaskCounts>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Initiative | null>(null);
  const [creating, setCreating] = useState<{ parent_id: string | null } | null>(null);
  const [moving, setMoving] = useState<Initiative | null>(null);
  const [converting, setConverting] = useState<Initiative | null>(null);
  const [promoting, setPromoting] = useState<Initiative | null>(null);

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
      setTree(buildTree(rows));

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

  return (
    <div className="min-h-screen bg-mc-bg p-6">
      <header className="max-w-5xl mx-auto mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-mc-text">Initiatives</h1>
          <p className="text-sm text-mc-text-secondary">Planning tree (Phase 1 — list view).</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/" className="px-3 py-2 rounded-lg border border-mc-border text-mc-text-secondary hover:text-mc-text text-sm">
            Workspaces
          </Link>
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
                taskCounts={taskCounts}
                onEdit={setEditing}
                onAddChild={parent => setCreating({ parent_id: parent.id })}
                onMove={setMoving}
                onConvert={setConverting}
                onPromote={setPromoting}
                onDelete={async (init) => {
                  if (!confirm(`Delete "${init.title}"?`)) return;
                  const res = await fetch(`/api/initiatives/${init.id}`, { method: 'DELETE' });
                  if (!res.ok) {
                    const body = await res.json().catch(() => ({}));
                    alert(body.error || 'Delete failed');
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
          allInitiatives={flat}
          onClose={() => setCreating(null)}
          onSaved={() => {
            setCreating(null);
            refresh();
          }}
        />
      )}
      {editing && (
        <EditModal
          initiative={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {moving && (
        <MoveModal
          initiative={moving}
          allInitiatives={flat}
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
    </div>
  );
}

function buildTree(rows: Initiative[]): TreeNode[] {
  const byParent = new Map<string | null, Initiative[]>();
  for (const r of rows) {
    const k = r.parent_initiative_id ?? null;
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
  taskCounts,
  onEdit,
  onAddChild,
  onMove,
  onConvert,
  onPromote,
  onDelete,
}: {
  node: TreeNode;
  depth: number;
  allInitiatives: Initiative[];
  taskCounts: Record<string, TaskCounts>;
  onEdit: (init: Initiative) => void;
  onAddChild: (parent: Initiative) => void;
  onMove: (init: Initiative) => void;
  onConvert: (init: Initiative) => void;
  onPromote: (init: Initiative) => void;
  onDelete: (init: Initiative) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const counts = taskCounts[node.id];
  const isStory = node.kind === 'story';

  return (
    <>
      <li
        className="flex items-center gap-2 p-2 rounded-lg bg-mc-bg-secondary border border-mc-border hover:border-mc-accent/40"
        style={{ marginLeft: depth * 24 }}
      >
        {depth > 0 && <ChevronRight className="w-4 h-4 text-mc-text-secondary" />}
        <span className={`px-2 py-0.5 rounded text-xs uppercase tracking-wide ${KIND_BADGE[node.kind]}`}>
          {node.kind}
        </span>
        <Link
          href={`/initiatives/${node.id}`}
          className="font-medium text-mc-text hover:text-mc-accent"
          title="Open initiative detail"
        >
          {node.title}
        </Link>
        <span className="text-xs text-mc-text-secondary">{node.status}</span>
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
        <div className="ml-auto flex items-center gap-1">
          <button
            title={expanded ? 'Hide details' : 'Show details (history + dependencies)'}
            onClick={() => setExpanded(v => !v)}
            className="p-1.5 rounded hover:bg-mc-bg text-mc-text-secondary hover:text-mc-text"
          >
            {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
          <button
            title="Add child"
            onClick={() => onAddChild(node)}
            className="p-1.5 rounded hover:bg-mc-bg text-mc-text-secondary hover:text-mc-text"
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            title={
              isStory
                ? 'Promote story to draft task'
                : 'Only story-kind initiatives can be promoted to tasks. Convert this initiative to a story first.'
            }
            onClick={() => isStory && onPromote(node)}
            disabled={!isStory}
            className={`p-1.5 rounded ${
              isStory
                ? 'hover:bg-mc-bg text-mc-accent hover:text-mc-accent'
                : 'text-mc-text-secondary/40 cursor-not-allowed'
            }`}
          >
            <Send className="w-4 h-4" />
          </button>
          <button
            title="Edit"
            onClick={() => onEdit(node)}
            className="p-1.5 rounded hover:bg-mc-bg text-mc-text-secondary hover:text-mc-text"
          >
            <Pencil className="w-4 h-4" />
          </button>
          <button
            title="Move"
            onClick={() => onMove(node)}
            className="p-1.5 rounded hover:bg-mc-bg text-mc-text-secondary hover:text-mc-text"
          >
            <MoveRight className="w-4 h-4" />
          </button>
          <button
            title="Convert kind"
            onClick={() => onConvert(node)}
            className="p-1.5 rounded hover:bg-mc-bg text-mc-text-secondary hover:text-mc-text"
          >
            <Shuffle className="w-4 h-4" />
          </button>
          <button
            title="Delete"
            onClick={() => onDelete(node)}
            className="p-1.5 rounded hover:bg-mc-bg text-mc-text-secondary hover:text-red-400"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </li>
      {expanded && (
        <li
          className="rounded-lg bg-mc-bg border border-mc-border/60 px-3 py-2 -mt-1 text-sm"
          style={{ marginLeft: depth * 24 + 12 }}
        >
          <DetailsPanel initiative={node} allInitiatives={allInitiatives} />
        </li>
      )}
      {node.children.map(c => (
        <InitiativeRow
          key={c.id}
          node={c}
          depth={depth + 1}
          allInitiatives={allInitiatives}
          taskCounts={taskCounts}
          onEdit={onEdit}
          onAddChild={onAddChild}
          onMove={onMove}
          onConvert={onConvert}
          onPromote={onPromote}
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
}: {
  initiative: Initiative;
  allInitiatives: Initiative[];
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
              {allInitiatives
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

function CreateModal({
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

function EditModal({
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
  const [status, setStatus] = useState<Status>(initiative.status);
  const [targetStart, setTargetStart] = useState(initiative.target_start ?? '');
  const [targetEnd, setTargetEnd] = useState(initiative.target_end ?? '');
  // The list query doesn't return these fields, so default to empty strings;
  // the patch only sends fields the operator actually edited.
  const [complexity, setComplexity] = useState<Complexity | ''>('');
  const [effort, setEffort] = useState('');
  const [statusCheck, setStatusCheck] = useState('');
  const [ownerAgentId, setOwnerAgentId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Pull the full record so we have the optional fields not in the list view.
  useEffect(() => {
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
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initiative.id]);

  const submit = async () => {
    setSubmitting(true);
    setErr(null);
    try {
      const patch: Record<string, unknown> = {
        title,
        description: description || null,
        status,
        target_start: targetStart || null,
        target_end: targetEnd || null,
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

  return (
    <ModalShell title="Edit initiative" onClose={onClose}>
      <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
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
            className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border h-24"
            value={description}
            onChange={e => setDescription(e.target.value)}
          />
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
        <label className="block">
          <span className="text-sm text-mc-text-secondary">Owner agent id (optional)</span>
          <input
            className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border"
            value={ownerAgentId}
            onChange={e => setOwnerAgentId(e.target.value)}
            disabled={!loaded}
            placeholder="e.g. agent-uuid"
          />
        </label>
        <label className="block">
          <span className="text-sm text-mc-text-secondary">Status check (markdown)</span>
          <textarea
            className="mt-1 w-full px-3 py-2 rounded bg-mc-bg border border-mc-border h-20 font-mono text-xs"
            value={statusCheck}
            onChange={e => setStatusCheck(e.target.value)}
            disabled={!loaded}
            placeholder="Linked PR / waiting on / customer demo / etc."
          />
        </label>
        {err && <div className="text-red-400 text-sm">{err}</div>}
        <div className="flex justify-end gap-2 pt-2 sticky bottom-0 bg-mc-bg-secondary">
          <button onClick={onClose} className="px-3 py-2 rounded border border-mc-border text-mc-text-secondary text-sm">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting || !title}
            className="px-3 py-2 rounded bg-mc-accent text-white disabled:opacity-50 text-sm"
          >
            Save
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function MoveModal({
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

function ConvertModal({
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
