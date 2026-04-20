'use client';

/**
 * Right-rail panel that surfaces every task with at least one deliverable.
 * Persistent (state view), not event-stream. Separate from LiveFeed so deliverable
 * rows don't churn when unrelated events arrive.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Archive, Download, Package } from 'lucide-react';
import { useMissionControl } from '@/lib/store';

const RELEVANT_EVENT_TYPES = [
  'deliverable_added',
  'task_status_changed',
  'task_archived',
  'task_unarchived',
  'task_deleted',
  'task_completed',
];

interface Row {
  task_id: string;
  task_title: string;
  status: string;
  is_archived: number;
  file_count: number;
  mc_count: number;
  last_added_at: string;
}

interface Props {
  workspaceId?: string;
}

export function ReadyDeliverablesPanel({ workspaceId }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const { events } = useMissionControl();

  const load = useCallback(async () => {
    try {
      const qs = workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : '';
      const res = await fetch(`/api/deliverables/tasks-with-deliverables${qs}`);
      if (res.ok) {
        setRows(await res.json());
      }
    } catch (e) {
      console.error('[ReadyDeliverablesPanel] load failed', e);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  // Refetch when a relevant event arrives. We can't subscribe to the SSE stream
  // directly from here, but the store holds the last 100 events — so re-running
  // when a matching one lands at the head is good enough. Comparing the
  // string-typed column rather than the narrower EventType keeps this in sync
  // with the broader set of types that actually flow into the store.
  const latestRelevantId = useMemo(() => {
    const match = events.find(e => RELEVANT_EVENT_TYPES.includes(e.type as string));
    return match?.id;
  }, [events]);
  useEffect(() => {
    if (latestRelevantId) load();
  }, [latestRelevantId, load]);

  const visible = rows.filter(r => showArchived || r.is_archived === 0);

  const statusClass = (s: string) => {
    if (s === 'done') return 'bg-green-700/30 text-green-300';
    if (s === 'cancelled') return 'bg-red-700/30 text-red-300';
    if (s === 'in_progress' || s === 'testing' || s === 'review' || s === 'verification') {
      return 'bg-yellow-700/30 text-yellow-300';
    }
    return 'bg-mc-bg-tertiary text-mc-text-secondary';
  };

  return (
    <div className="border-b border-mc-border bg-mc-bg-secondary">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-mc-bg-tertiary"
      >
        <div className="flex items-center gap-2">
          <Package className="w-4 h-4 text-mc-accent" />
          <span className="text-sm font-medium uppercase tracking-wider">Deliverables</span>
          {visible.length > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-mc-bg-tertiary text-mc-text-secondary">
              {visible.length}
            </span>
          )}
        </div>
        {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3">
          <label className="flex items-center gap-2 text-xs text-mc-text-secondary mb-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={e => setShowArchived(e.target.checked)}
              className="accent-mc-accent"
            />
            Show archived
          </label>

          {loading ? (
            <div className="text-xs text-mc-text-secondary py-2">Loading...</div>
          ) : visible.length === 0 ? (
            <div className="text-xs text-mc-text-secondary py-2">No deliverables yet</div>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {visible.map(row => (
                <div
                  key={row.task_id}
                  className={`p-2 rounded border border-mc-border bg-mc-bg ${row.is_archived ? 'opacity-60' : ''}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span
                      className="flex-1 min-w-0 text-sm text-mc-text truncate"
                      title={row.task_title}
                    >
                      {row.task_title}
                    </span>
                    {row.mc_count > 0 && (
                      <a
                        href={`/api/tasks/${row.task_id}/deliverables/download`}
                        className="flex-shrink-0 p-1 rounded text-mc-accent hover:bg-mc-bg-tertiary"
                        title={`Download ${row.mc_count} file${row.mc_count === 1 ? '' : 's'}`}
                      >
                        <Download className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-xs">
                    <span className={`px-1.5 py-0.5 rounded capitalize ${statusClass(row.status)}`}>
                      {row.status.replace(/_/g, ' ')}
                    </span>
                    <span className="text-mc-text-secondary">
                      {row.file_count} file{row.file_count === 1 ? '' : 's'}
                    </span>
                    {row.mc_count < row.file_count && (
                      <span className="text-mc-text-secondary" title="Some deliverables are host-only">
                        ({row.mc_count} web)
                      </span>
                    )}
                    {row.is_archived === 1 && (
                      <span className="flex items-center gap-0.5 text-mc-text-secondary">
                        <Archive className="w-3 h-3" />
                        archived
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
