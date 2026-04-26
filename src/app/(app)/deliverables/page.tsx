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
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
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

  const toggleSort = (key: SortKey) => {
    setSort(prev =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'updated' ? 'desc' : 'asc' },
    );
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
          <div className="rounded-lg border border-mc-border bg-mc-bg-secondary overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-mc-bg/50 border-b border-mc-border">
                  <tr className="text-left text-xs uppercase tracking-wide text-mc-text-secondary">
                    <Th onSort={() => toggleSort('title')} sortDir={sort.key === 'title' ? sort.dir : null}>
                      Task
                    </Th>
                    <Th onSort={() => toggleSort('status')} sortDir={sort.key === 'status' ? sort.dir : null}>
                      Status
                    </Th>
                    <Th onSort={() => toggleSort('files')} sortDir={sort.key === 'files' ? sort.dir : null}>
                      Files
                    </Th>
                    <Th onSort={() => toggleSort('updated')} sortDir={sort.key === 'updated' ? sort.dir : null}>
                      Updated
                    </Th>
                    <Th>Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(r => (
                    <DeliverableRow key={r.task_id} row={r} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function Th({
  children,
  onSort,
  sortDir,
  width,
}: {
  children?: React.ReactNode;
  onSort?: () => void;
  sortDir?: SortDir | null;
  width?: string;
}) {
  return (
    <th className={`px-3 py-2 ${width ?? ''}`}>
      {onSort ? (
        <button
          onClick={onSort}
          className="inline-flex items-center gap-1 hover:text-mc-text"
        >
          <span>{children}</span>
          {sortDir === 'asc' ? (
            <ChevronUp className="w-3 h-3" />
          ) : sortDir === 'desc' ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronsUpDown className="w-3 h-3 opacity-40" />
          )}
        </button>
      ) : (
        <span>{children}</span>
      )}
    </th>
  );
}

function DeliverableRow({ row }: { row: Row }) {
  const statusCls = STATUS_PALETTE[row.status] ?? 'bg-mc-bg-tertiary text-mc-text-secondary border-mc-border';
  const ago = (() => {
    try {
      return formatDistanceToNow(new Date(row.last_added_at), { addSuffix: true });
    } catch {
      return row.last_added_at;
    }
  })();
  return (
    <tr
      className={`border-t border-mc-border/60 hover:bg-mc-bg/40 ${
        row.is_archived ? 'opacity-60' : ''
      }`}
    >
      <td className="px-3 py-2">
        <Link
          href={`/?task=${row.task_id}`}
          className="font-medium text-mc-text hover:text-mc-accent inline-flex items-center gap-1"
          title={row.task_title}
        >
          <span className="truncate max-w-[420px]">{row.task_title}</span>
          <ExternalLink className="w-3 h-3 opacity-60 shrink-0" />
        </Link>
        {row.is_archived === 1 && (
          <span className="ml-2 inline-flex items-center gap-0.5 text-[10px] text-mc-text-secondary uppercase tracking-wide">
            <Archive className="w-3 h-3" /> archived
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        <span className={`inline-block px-1.5 py-0.5 rounded-sm text-[11px] capitalize border ${statusCls}`}>
          {row.status.replace(/_/g, ' ')}
        </span>
      </td>
      <td className="px-3 py-2 tabular-nums">
        {row.file_count}
        {row.mc_count < row.file_count && (
          <span className="text-mc-text-secondary text-xs ml-1" title="Some files are host-only">
            ({row.mc_count} web)
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-mc-text-secondary text-xs whitespace-nowrap">
        {ago}
      </td>
      <td className="px-3 py-2">
        {row.mc_count > 0 ? (
          <a
            href={`/api/tasks/${row.task_id}/deliverables/download`}
            className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-mc-accent/40 text-mc-accent hover:bg-mc-accent/10"
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
          <span className="text-xs text-mc-text-secondary">—</span>
        )}
      </td>
    </tr>
  );
}
