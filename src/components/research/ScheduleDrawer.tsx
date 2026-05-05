'use client';

/**
 * ScheduleDrawer — create a recurring research schedule for a topic.
 *
 * Phase-2 spec: cadence is a fixed dropdown (no cron parser, no event
 * triggers). See specs/research-phase-2-schedules-build-plan.md §3.2.
 *
 * The actual scheduling is workspace-scoped via the topic's workspace,
 * so this drawer just needs the topic's id; it doesn't need a
 * workspaceId prop.
 */

import { useEffect, useState } from 'react';
import { Calendar as CalendarIcon, Sparkles, X } from 'lucide-react';

export interface CadenceOption {
  label: string;
  seconds: number;
}

export const CADENCE_OPTIONS: CadenceOption[] = [
  { label: 'Hourly', seconds: 3600 },
  { label: 'Every 4 hours', seconds: 4 * 3600 },
  { label: 'Daily', seconds: 24 * 3600 },
  { label: 'Every 2 days', seconds: 2 * 24 * 3600 },
  { label: 'Weekly', seconds: 7 * 24 * 3600 },
  { label: 'Bi-weekly', seconds: 14 * 24 * 3600 },
  { label: 'Monthly (28d)', seconds: 28 * 24 * 3600 },
];

const DEFAULT_CADENCE_SECONDS = 7 * 24 * 3600; // Weekly per build-plan §7.

interface ScheduleDrawerProps {
  open: boolean;
  onClose: () => void;
  topicId: string;
  topicName: string;
  onCreated: () => void;
}

export function ScheduleDrawer({ open, onClose, topicId, topicName, onCreated }: ScheduleDrawerProps) {
  const [cadenceSeconds, setCadenceSeconds] = useState(DEFAULT_CADENCE_SECONDS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setCadenceSeconds(DEFAULT_CADENCE_SECONDS);
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/topics/${topicId}/schedules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brief_template: 'general_brief',
          cadence_seconds: cadenceSeconds,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Create failed (${res.status})`);
      }
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create schedule');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 bg-black/60 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Create schedule"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-mc-bg-secondary border-l border-mc-border h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-mc-border">
          <h2 className="text-sm font-semibold text-mc-text flex items-center gap-2">
            <CalendarIcon className="w-4 h-4 text-mc-accent" />
            Schedule recurring brief
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-sm hover:bg-mc-bg-tertiary text-mc-text-secondary"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          <div>
            <span className="text-[11px] uppercase tracking-wider text-mc-text-secondary">Topic</span>
            <p className="text-sm text-mc-text mt-0.5">{topicName}</p>
          </div>

          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-mc-text-secondary">Cadence</span>
            <select
              className="mt-1 w-full bg-mc-bg border border-mc-border rounded-sm px-2 py-1.5 text-sm text-mc-text"
              value={cadenceSeconds}
              onChange={(e) => setCadenceSeconds(parseInt(e.target.value, 10))}
              disabled={submitting}
            >
              {CADENCE_OPTIONS.map((o) => (
                <option key={o.seconds} value={o.seconds}>{o.label}</option>
              ))}
            </select>
          </label>

          <div className="text-[11px] text-mc-text-secondary/80 leading-snug">
            <Sparkles className="inline w-3 h-3 mr-1" />
            First run will fire one cadence from now. You can hit <strong className="text-mc-text">Run now</strong> on the
            schedule row to dispatch off-cadence at any time.
          </div>

          {error && (
            <div className="px-3 py-2 rounded-sm bg-red-900/20 border border-red-500/30 text-red-300 text-xs">
              {error}
            </div>
          )}
        </div>

        <footer className="px-4 py-3 border-t border-mc-border flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-sm text-mc-text-secondary hover:bg-mc-bg-tertiary"
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="px-3 py-1.5 bg-mc-accent text-mc-bg rounded-sm text-sm font-medium hover:opacity-90 disabled:opacity-40"
          >
            {submitting ? 'Creating…' : 'Create schedule'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Format a cadence_seconds value into the operator-facing label,
 * matching CADENCE_OPTIONS where possible. Custom values (set via
 * the API) fall back to a "every Ns" string.
 */
export function formatCadence(seconds: number): string {
  const opt = CADENCE_OPTIONS.find((o) => o.seconds === seconds);
  if (opt) return opt.label;
  if (seconds < 60) return `Every ${seconds}s`;
  if (seconds < 3600) return `Every ${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `Every ${Math.round(seconds / 3600)} hours`;
  return `Every ${Math.round(seconds / 86400)} days`;
}
