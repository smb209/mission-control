'use client';

/**
 * Per-initiative in-flight strip.
 *
 * Polls `/api/jobs?workspace_id=…&initiative_id=…` every 2s and renders
 * a compact horizontal list of agent_runs touching this initiative —
 * audit, plan, decompose, etc. Closes the "what did I just queue?" gap
 * after a refresh, and the "where will the result land?" gap on dispatch.
 *
 * Shows:
 *  - All live (queued + running) runs for this initiative.
 *  - Up to 3 most-recent terminal runs from the last 24h.
 *
 * Each row links into `/jobs?run=<id>` for the existing drill-down panel.
 *
 * See specs/audit-actions-and-tracking.md PR 2.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  CircleDashed,
} from 'lucide-react';

const POLL_MS = 2000;
const AMBER_ELAPSED_MS = 5 * 60 * 1000;
const RECENT_LIMIT = 3;

interface JobsItem {
  id: string;
  kind: string;
  status: string;
  derived_label: string;
  started_at: string | null;
  completed_at?: string | null;
  parent_run_id: string | null;
  group_count: number;
}

interface JobsResponse {
  live: JobsItem[];
  recent: JobsItem[];
}

interface Props {
  workspaceId: string;
  initiativeId: string;
  /** When false, the strip stops polling (useful for tests / hidden tabs). */
  poll?: boolean;
}

function formatElapsed(ms: number): string {
  if (ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function relativePast(iso: string | null, now: number): string {
  if (!iso) return '—';
  const dt = new Date(iso + (iso.includes('T') ? '' : 'Z')).getTime();
  const diff = now - dt;
  if (diff < 0) return 'just now';
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function statusIcon(status: string): React.ReactNode {
  switch (status) {
    case 'queued':
      return <CircleDashed className="w-3.5 h-3.5 text-mc-text-secondary" />;
    case 'running':
      return <Activity className="w-3.5 h-3.5 text-blue-500 animate-pulse" />;
    case 'complete':
      return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />;
    case 'failed':
      return <XCircle className="w-3.5 h-3.5 text-rose-600" />;
    case 'cancelled':
      return <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />;
    default:
      return <CircleDashed className="w-3.5 h-3.5" />;
  }
}

function kindBadge(kind: string): string {
  // Compact kind label for the chip prefix.
  switch (kind) {
    case 'initiative_audit':
      return 'audit';
    case 'pm_chat':
      return 'PM';
    case 'task_coord':
      return 'coord';
    case 'task_role':
      return 'role';
    default:
      return kind;
  }
}

export function InitiativeRunsStrip({ workspaceId, initiativeId, poll = true }: Props) {
  const [data, setData] = useState<JobsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!workspaceId || !initiativeId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const url = `/api/jobs?workspace_id=${encodeURIComponent(workspaceId)}&initiative_id=${encodeURIComponent(initiativeId)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as JobsResponse;
        if (cancelled) return;
        setData(json);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled && poll) {
          timer = setTimeout(tick, POLL_MS);
        }
      }
    };

    tick();
    const elapsedTimer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearInterval(elapsedTimer);
    };
  }, [workspaceId, initiativeId, poll]);

  if (error) {
    return (
      <p className="text-xs text-rose-600">
        Couldn’t load activity: {error}
      </p>
    );
  }

  if (!data) {
    return <p className="text-xs text-mc-text-secondary">Loading activity…</p>;
  }

  const live = data.live;
  const recent = data.recent.slice(0, RECENT_LIMIT);

  if (live.length === 0 && recent.length === 0) {
    return (
      <p className="text-xs text-mc-text-secondary">
        No agent activity for this initiative in the last 24h.
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid="initiative-runs-strip">
      {live.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {live.map((row) => {
            const startedMs = row.started_at
              ? new Date(row.started_at + (row.started_at.includes('T') ? '' : 'Z')).getTime()
              : 0;
            const elapsed = startedMs ? now - startedMs : 0;
            const amber = elapsed > AMBER_ELAPSED_MS;
            return (
              <li key={row.id}>
                <Link
                  href={`/jobs?run=${encodeURIComponent(row.id)}`}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs hover:bg-mc-surface-hover transition-colors ${
                    amber
                      ? 'border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-200'
                      : 'border-blue-200 bg-blue-50 text-blue-900 dark:bg-blue-950/30 dark:border-blue-800 dark:text-blue-200'
                  }`}
                  title={`${row.kind} · ${row.status} · started ${row.started_at ?? 'pending'}`}
                >
                  {statusIcon(row.status)}
                  <span className="font-medium">{kindBadge(row.kind)}</span>
                  <span className="opacity-90 truncate max-w-[18ch]">{row.derived_label}</span>
                  {startedMs > 0 && (
                    <span className="inline-flex items-center gap-0.5 opacity-75">
                      <Clock className="w-3 h-3" />
                      {formatElapsed(elapsed)}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {recent.length > 0 && (
        <ul className="flex flex-wrap gap-2 text-xs text-mc-text-secondary">
          {recent.map((row) => (
            <li key={row.id}>
              <Link
                href={`/jobs?run=${encodeURIComponent(row.id)}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-mc-border bg-mc-surface px-2.5 py-1 hover:bg-mc-surface-hover transition-colors"
                title={`${row.kind} · ${row.status} · ${row.completed_at ?? '—'}`}
              >
                {statusIcon(row.status)}
                <span className="font-medium">{kindBadge(row.kind)}</span>
                <span className="opacity-90 truncate max-w-[18ch]">{row.derived_label}</span>
                <span className="opacity-75">{relativePast(row.completed_at ?? null, now)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
