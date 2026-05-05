'use client';

/**
 * ScheduleRow + Schedules section for /research/topics/[id]. Also
 * exports the lighter-weight UpcomingScheduleRow used by the hub's
 * "Upcoming" lane.
 *
 * State actions hit /api/schedules/[id] PATCH/DELETE/run-now. The
 * caller is expected to refetch on success — both surfaces already
 * have an SSE subscription, but optimistic refetch keeps the lag off
 * the user-perceived path.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Calendar as CalendarIcon, Loader2, Pause, Play, Trash2, Zap } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { formatCadence } from './ScheduleDrawer';


export interface ScheduleSummary {
  id: string;
  topic_id: string | null;
  brief_template: string | null;
  cadence_seconds: number;
  status: 'active' | 'paused' | 'done';
  next_run_at: string;
  last_run_at: string | null;
  /**
   * The scope_key the schedule's last successful sweep recorded. For
   * research schedules this is `research-brief-<briefId>` per
   * dispatchResearchScheduleOnce; the row parses out the brief id to
   * render the "View latest" link.
   */
  last_run_scope_key?: string | null;
  consecutive_failures: number;
  run_count: number;
}

/**
 * Pull the brief id out of a `research-brief-<id>` scope key. Returns
 * null for any other shape (defends against scope keys from the
 * scope-keyed-sessions path or future schedule kinds).
 */
function lastBriefIdFrom(scopeKey: string | null | undefined): string | null {
  if (!scopeKey) return null;
  const m = /^research-brief-([0-9a-f-]+)$/i.exec(scopeKey);
  return m ? m[1] : null;
}

interface ScheduleRowProps {
  schedule: ScheduleSummary;
  topicName?: string;
  onChanged: () => void;
}

export function ScheduleRow({ schedule, topicName, onChanged }: ScheduleRowProps) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A schedule whose next_run_at has already elapsed is queued for the
  // next sweep tick (~60s loop). We track the current time to drive
  // the "queued" indicator + the run-now cooldown without polling.
  // useEffect re-renders every second so the timestamp transitions
  // from "next_run_at in 5s" to "queued" to "fired" naturally as the
  // sweep advances next_run_at past now() again.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // A schedule whose next_run_at is already in the past is "queued":
  // the next sweep tick (~60s) will fire it. This is the steady state
  // right after Run-now (which sets next_run_at = now()), so we use
  // it both for the visual indicator and the cooldown that prevents
  // queuing the same job multiple times.
  const nextMs = Date.parse(schedule.next_run_at);
  const queuedForNextSweep =
    schedule.status === 'active' && nextMs <= now;

  const patch = async (body: unknown) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/schedules/${schedule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `Update failed (${res.status})`);
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/schedules/${schedule.id}/run-now`, { method: 'POST' });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `Run-now failed (${res.status})`);
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Run-now failed');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/schedules/${schedule.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error ?? `Delete failed (${res.status})`);
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  const paused = schedule.status === 'paused';
  const lastBriefId = lastBriefIdFrom(schedule.last_run_scope_key);

  // Pick the lead icon to make the row's state legible at a glance:
  // queued = pulsing spinner, paused = yellow calendar, idle = accent
  // calendar.
  const LeadIcon = queuedForNextSweep ? Loader2 : CalendarIcon;
  const leadIconClass = queuedForNextSweep
    ? 'text-mc-accent animate-spin'
    : paused
      ? 'text-yellow-400'
      : 'text-mc-accent';

  return (
    <div className="border border-mc-border rounded-sm bg-mc-bg-secondary px-3 py-2">
      <div className="flex items-center gap-3">
        <LeadIcon className={`w-4 h-4 shrink-0 ${leadIconClass}`} />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-mc-text truncate">
            {topicName && <span className="text-mc-text-secondary">{topicName} · </span>}
            {formatCadence(schedule.cadence_seconds)} · {schedule.brief_template ?? 'general_brief'}
          </div>
          <div className="text-[11px] text-mc-text-secondary mt-0.5 flex flex-wrap gap-2">
            {queuedForNextSweep ? (
              <span className="text-mc-accent">Queued — running on next sweep</span>
            ) : (
              <span>
                Next: {formatDistanceToNow(new Date(schedule.next_run_at), { addSuffix: true })}
              </span>
            )}
            {schedule.last_run_at && (
              <span>· Last: {formatDistanceToNow(new Date(schedule.last_run_at), { addSuffix: true })}</span>
            )}
            <span>· Run count: {schedule.run_count}</span>
            {lastBriefId && (
              <Link
                href={`/research/briefs/${lastBriefId}`}
                className="text-mc-accent hover:underline inline-flex items-center gap-0.5"
                onClick={(e) => e.stopPropagation()}
                title="View the most recent brief this schedule produced"
              >
                · View latest
                <ArrowUpRight className="w-3 h-3" />
              </Link>
            )}
            {paused && (
              <span className="text-yellow-400">
                · Paused{schedule.consecutive_failures > 0 ? ` (${schedule.consecutive_failures} failures)` : ''}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!paused && (
            <button
              type="button"
              onClick={runNow}
              disabled={busy || queuedForNextSweep}
              className="p-1.5 rounded-sm text-mc-text-secondary hover:text-mc-accent hover:bg-mc-bg-tertiary disabled:opacity-40 disabled:cursor-not-allowed"
              title={queuedForNextSweep ? 'Already queued for the next sweep' : 'Run now'}
              aria-label="Run now"
            >
              <Zap className="w-3.5 h-3.5" />
            </button>
          )}
          {paused ? (
            <button
              type="button"
              onClick={() => patch({ status: 'active' })}
              disabled={busy}
              className="p-1.5 rounded-sm text-mc-text-secondary hover:text-mc-accent hover:bg-mc-bg-tertiary disabled:opacity-40"
              title="Resume"
              aria-label="Resume"
            >
              <Play className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => patch({ status: 'paused' })}
              disabled={busy}
              className="p-1.5 rounded-sm text-mc-text-secondary hover:text-yellow-400 hover:bg-mc-bg-tertiary disabled:opacity-40"
              title="Pause"
              aria-label="Pause"
            >
              <Pause className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
            className="p-1.5 rounded-sm text-mc-text-secondary hover:text-red-400 hover:bg-mc-bg-tertiary disabled:opacity-40"
            title="Delete schedule"
            aria-label="Delete schedule"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {error && (
        <div className="mt-2 px-2 py-1 rounded-sm bg-red-900/20 border border-red-500/30 text-red-300 text-[11px]">
          {error}
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        title="Delete schedule?"
        body="The schedule stops firing. Past briefs it produced are preserved."
        confirmLabel="Delete"
        destructive
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
