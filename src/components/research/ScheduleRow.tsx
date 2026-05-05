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

import { useState } from 'react';
import { Calendar as CalendarIcon, Pause, Play, Trash2, Zap } from 'lucide-react';
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
  consecutive_failures: number;
  run_count: number;
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

  return (
    <div className="border border-mc-border rounded-sm bg-mc-bg-secondary px-3 py-2">
      <div className="flex items-center gap-3">
        <CalendarIcon className={`w-4 h-4 shrink-0 ${paused ? 'text-yellow-400' : 'text-mc-accent'}`} />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-mc-text truncate">
            {topicName && <span className="text-mc-text-secondary">{topicName} · </span>}
            {formatCadence(schedule.cadence_seconds)} · {schedule.brief_template ?? 'general_brief'}
          </div>
          <div className="text-[11px] text-mc-text-secondary mt-0.5 flex flex-wrap gap-2">
            <span>
              Next: {formatDistanceToNow(new Date(schedule.next_run_at), { addSuffix: true })}
            </span>
            {schedule.last_run_at && (
              <span>· Last: {formatDistanceToNow(new Date(schedule.last_run_at), { addSuffix: true })}</span>
            )}
            <span>· Run count: {schedule.run_count}</span>
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
              disabled={busy}
              className="p-1.5 rounded-sm text-mc-text-secondary hover:text-mc-accent hover:bg-mc-bg-tertiary disabled:opacity-40"
              title="Run now"
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
