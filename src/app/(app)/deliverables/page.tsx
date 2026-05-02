'use client';

/**
 * Workspace deliverables — full-page view that replaces the cramped
 * right-rail ReadyDeliverablesPanel. One row per task, with file count,
 * last-updated time, status pill, and a Download All link. Style
 * matches the /agents page so the workspace's tabular surfaces stay
 * visually consistent.
 *
 * Re-fetches when SSE events touch deliverable state (deliverable
 * added, task status changed, archived/unarchived/deleted/completed).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Archive,
  ArchiveRestore,
  Download,
  ExternalLink,
  Package,
  RefreshCw,
} from 'lucide-react';
import { useCurrentWorkspaceId } from '@/components/shell/workspace-context';
import { useMissionControl } from '@/lib/store';
import { formatDistanceToNow } from 'date-fns';

interface Row {
  task_id: string;
  task_title: string;
  status: string;
  is_archived: number;
  file_count: number;
  mc_count: number;
  last_added_at: string;
}

const RELEVANT_EVENT_TYPES = [
  'deliverable_added',
  'task_status_changed',
  'task_archived',
  'task_unarchived',
  'task_deleted',
  'task_completed',
];

type SortKey = 'title' | 'status' | 'files' | 'updated';
type SortDir = 'asc' | 'desc';

const STATUS_PALETTE: Record<string, string> = {
  done: 'bg-green-700/30 text-green-300 border-green-500/30',
  cancelled: 'bg-red-700/30 text-red-300 border-red-500/30',
  in_progress: 'bg-yellow-700/30 text-yellow-300 border-yellow-500/30',
  testing: 'bg-yellow-700/30 text-yellow-300 border-yellow-500/30',
  review: 'bg-yellow-700/30 text-yellow-300 border-yellow-500/30',
  verification: 'bg-yellow-700/30 text-yellow-300 border-yellow-500/30',
};

export default function DeliverablesPage() {
  const workspaceId = useCurrentWorkspaceId();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: 'updated',
    dir: 'desc',
  });
  const { events } = useMissionControl();

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : '';
      const res = await fetch(`/api/deliverables/tasks-with-deliverables${qs}`);
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      setRows(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load deliverables');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  // Re-fetch when a relevant SSE event arrives (same trigger set as the
  // old right-rail panel).
  const latestRelevantId = useMemo(() => {
    const match = events.find(e => RELEVANT_EVENT_TYPES.includes(e.type as string));
    return match?.id;
  }, [events]);
  useEffect(() => {
    if (latestRelevantId) load();
  }, [latestRelevantId, load]);

  const visible = useMemo(() => {
    const filtered = rows.filter(r => showArchived || r.is_archived === 0);
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sort.key) {
        case 'title':
          return dir * a.task_title.localeCompare(b.task_title);
        case 'status':
          return dir * a.status.localeCompare(b.status);
        case 'files':
          return dir * (a.file_count - b.file_count);
        case 'updated':
        default:
          return dir * (a.last_added_at.localeCompare(b.last_added_at));
      }
    });
  }, [rows, showArchived, sort]);

  const totalFiles = visible.reduce((acc, r) => acc + r.file_count, 0);
  const totalDownloadable = visible.reduce((acc, r) => acc + r.mc_count, 0);

  // Sort dropdown — combined key+direction so the operator picks one
  // option ("Newest first") rather than juggling a key dropdown plus a
  // direction toggle. Replaces the per-column header sort buttons that
  // came with the old table layout.
  const SORT_OPTIONS: Array<{ value: string; key: SortKey; dir: SortDir; label: string }> = [
    { value: 'updated:desc', key: 'updated', dir: 'desc', label: 'Newest first' },
    { value: 'updated:asc', key: 'updated', dir: 'asc', label: 'Oldest first' },
    { value: 'title:asc', key: 'title', dir: 'asc', label: 'Title A→Z' },
    { value: 'title:desc', key: 'title', dir: 'desc', label: 'Title Z→A' },
    { value: 'files:desc', key: 'files', dir: 'desc', label: 'Most files' },
    { value: 'files:asc', key: 'files', dir: 'asc', label: 'Fewest files' },
    { value: 'status:asc', key: 'status', dir: 'asc', label: 'Status A→Z' },
  ];
  const sortValue = `${sort.key}:${sort.dir}`;
  const setSortFromValue = (v: string) => {
    const opt = SORT_OPTIONS.find(o => o.value === v);
    if (opt) setSort({ key: opt.key, dir: opt.dir });
  };

  return (
    <div className="min-h-screen bg-mc-bg text-mc-text">
      <header className="border-b border-mc-border bg-mc-bg-secondary">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Package className="w-6 h-6 text-mc-accent shrink-0" />
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-mc-text">Deliverables</h1>
              <p className="text-xs text-mc-text-secondary">
                {visible.length} task{visible.length === 1 ? '' : 's'} ·{' '}
                {totalFiles} file{totalFiles === 1 ? '' : 's'}
                {totalDownloadable !== totalFiles && (
                  <span> ({totalDownloadable} downloadable)</span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <select
              value={sortValue}
              onChange={e => setSortFromValue(e.target.value)}
              className="text-xs px-2 py-1.5 rounded border border-mc-border bg-mc-bg text-mc-text hover:border-mc-accent/40 focus:outline-none focus:border-mc-accent/60"
              title="Sort cards"
            >
              {SORT_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-xs text-mc-text-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={e => setShowArchived(e.target.checked)}
                className="accent-mc-accent"
              />
              Show archived
            </label>
            <button
              onClick={load}
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-mc-border text-mc-text-secondary hover:text-mc-text hover:border-mc-accent/40"
              title="Refresh"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
            {error}
          </div>
        )}
        {loading ? (
          <div className="p-10 rounded-lg border border-dashed border-mc-border bg-mc-bg-secondary text-center text-mc-text-secondary">
            Loading deliverables…
          </div>
        ) : visible.length === 0 ? (
          <div className="p-10 rounded-lg border border-dashed border-mc-border bg-mc-bg-secondary text-center text-mc-text-secondary">
            No deliverables yet
            {!showArchived && rows.some(r => r.is_archived === 1) && (
              <>
                {' · '}
                <button
                  onClick={() => setShowArchived(true)}
                  className="underline hover:text-mc-text"
                >
                  show archived
                </button>
              </>
            )}
            .
          </div>
        ) : (
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {visible.map(r => (
              <DeliverableCard key={r.task_id} row={r} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function DeliverableCard({ row }: { row: Row }) {
  const statusCls = STATUS_PALETTE[row.status] ?? 'bg-mc-bg-tertiary text-mc-text-secondary border-mc-border';
  const ago = (() => {
    try {
      return formatDistanceToNow(new Date(row.last_added_at), { addSuffix: true });
    } catch {
      return row.last_added_at;
    }
  })();
  return (
    <article
      className={`flex flex-col gap-3 p-4 rounded-lg border border-mc-border bg-mc-bg-secondary hover:border-mc-accent/40 ${
        row.is_archived ? 'opacity-60' : ''
      }`}
    >
      <header className="flex items-start gap-2 min-w-0">
        <span
          className={`inline-block px-1.5 py-0.5 rounded-sm text-[10px] capitalize border shrink-0 ${statusCls}`}
        >
          {row.status.replace(/_/g, ' ')}
        </span>
        {row.is_archived === 1 && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-mc-text-secondary uppercase tracking-wide shrink-0">
            <Archive className="w-3 h-3" /> archived
          </span>
        )}
      </header>

      <Link
        href={`/?task=${row.task_id}`}
        className="font-medium text-sm text-mc-text hover:text-mc-accent inline-flex items-start gap-1 min-w-0"
        title={row.task_title}
      >
        <span className="line-clamp-2 break-words">{row.task_title}</span>
        <ExternalLink className="w-3 h-3 opacity-60 shrink-0 mt-1" />
      </Link>

      <dl className="flex items-center gap-4 text-xs text-mc-text-secondary mt-auto">
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-mc-text-secondary/70">Files</dt>
          <dd className="text-mc-text tabular-nums">
            {row.file_count}
            {row.mc_count < row.file_count && (
              <span className="text-mc-text-secondary text-[11px] ml-1" title="Some files are host-only">
                ({row.mc_count} web)
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-[10px] uppercase tracking-wide text-mc-text-secondary/70">Updated</dt>
          <dd className="text-mc-text whitespace-nowrap">{ago}</dd>
        </div>
      </dl>

      <footer className="flex items-center justify-end">
        {row.mc_count > 0 ? (
          <a
            href={`/api/tasks/${row.task_id}/deliverables/download`}
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded border border-mc-accent/40 text-mc-accent hover:bg-mc-accent/10"
            title={`Download ${row.mc_count} file${row.mc_count === 1 ? '' : 's'}`}
          >
            <Download className="w-3.5 h-3.5" />
            Download
          </a>
        ) : row.is_archived === 1 ? (
          <span className="inline-flex items-center gap-1 text-xs text-mc-text-secondary">
            <ArchiveRestore className="w-3.5 h-3.5" />
            Archived
          </span>
        ) : (
          <span className="text-xs text-mc-text-secondary">No downloadable files</span>
        )}
      </footer>
    </article>
  );
}
