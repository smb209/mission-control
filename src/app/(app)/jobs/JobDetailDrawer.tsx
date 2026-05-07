'use client';

/**
 * /jobs drill-down side panel (PR 5 of jobs-in-progress).
 *
 * Opened when the operator clicks any live or recent row. Surfaces
 * what /api/jobs/:id returns plus a "Reset session" button that wipes
 * the openclaw session for `scope_key` via the existing per-agent
 * reset endpoint. The trigger_body and error_md are rendered as <pre>
 * blocks with a max-height + overflow scroll so the drawer doesn't
 * become unbounded for large briefings.
 */

import { useEffect, useState } from 'react';
import Drawer from '@/components/Drawer';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import Link from 'next/link';
import { Copy, Check, AlertTriangle, ExternalLink } from 'lucide-react';

interface JobDetail {
  id: string;
  workspace_id: string;
  kind: string;
  status: string;
  source_kind: string;
  source_ref: string | null;
  scope_key: string | null;
  scope_type: string | null;
  role: string | null;
  agent_id: string | null;
  initiative_id: string | null;
  task_id: string | null;
  parent_run_id: string | null;
  label: string | null;
  openclaw_session_id: string | null;
  model_used: string | null;
  cost_cents: number | null;
  cost_ceiling_cents: number | null;
  error_md: string | null;
  trigger_body: string | null;
  pm_proposal_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  initiative_title: string | null;
}

function formatElapsed(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return '—';
  const start = new Date(startedAt + (startedAt.includes('T') ? '' : 'Z')).getTime();
  const end = completedAt
    ? new Date(completedAt + (completedAt.includes('T') ? '' : 'Z')).getTime()
    : Date.now();
  const ms = Math.max(0, end - start);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="inline-flex items-center gap-1 text-mc-text-secondary hover:text-mc-text"
      title="Copy"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

function statusChipClass(status: string): string {
  switch (status) {
    case 'complete': return 'bg-emerald-500/20 text-emerald-300';
    case 'failed': return 'bg-red-500/20 text-red-300';
    case 'cancelled': return 'bg-zinc-500/20 text-zinc-300';
    case 'running': return 'bg-cyan-500/20 text-cyan-300';
    case 'queued': return 'bg-amber-500/20 text-amber-300';
    default: return 'bg-zinc-500/20 text-zinc-300';
  }
}

interface JobDetailDrawerProps {
  jobId: string | null;
  onClose: () => void;
  /** Called after a successful reset so the parent can re-poll. */
  onReset?: () => void;
}

export default function JobDetailDrawer({ jobId, onClose, onReset }: JobDetailDrawerProps) {
  const [job, setJob] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetPending, setResetPending] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/jobs/${encodeURIComponent(jobId)}`)
      .then(async r => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${r.status}`);
        }
        return r.json() as Promise<JobDetail>;
      })
      .then(body => {
        if (!cancelled) setJob(body);
      })
      .catch(e => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  const doReset = async () => {
    if (!job || !job.agent_id || !job.scope_key) return;
    setResetting(true);
    // Derive the session_suffix from scope_key. scope_key is shaped
    // <session_key_prefix>:<suffix> — strip the prefix off so the
    // reset endpoint targets just this session, not all of the
    // agent's sessions. Best-effort: if the key doesn't have a colon
    // we pass the whole thing.
    const idx = job.scope_key.lastIndexOf(':');
    const suffix = idx >= 0 ? job.scope_key.slice(idx + 1) : job.scope_key;
    try {
      const res = await fetch(
        `/api/agents/${encodeURIComponent(job.agent_id)}/reset?session_suffix=${encodeURIComponent(suffix)}`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        window.alert(`Reset failed: ${body.error || `HTTP ${res.status}`}`);
      } else {
        onReset?.();
      }
    } catch (err) {
      window.alert(`Reset failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setResetting(false);
      setResetPending(false);
    }
  };

  return (
    <>
      <Drawer
        open={jobId !== null}
        title={(job ? deriveLabel(job) : 'Job detail')}
        onClose={onClose}
      >
        {loading && (
          <p className="text-sm text-mc-text-secondary">Loading…</p>
        )}
        {error && (
          <p className="text-sm text-red-300">Failed to load: {error}</p>
        )}
        {job && (
          <div className="space-y-5 text-sm">
            <section className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="px-1.5 py-0.5 rounded bg-mc-bg-tertiary text-mc-text-secondary text-[11px] font-mono">
                  {job.kind}
                </span>
                <span className={`px-1.5 py-0.5 rounded text-[11px] ${statusChipClass(job.status)}`}>
                  {job.status}
                </span>
                {job.source_kind !== 'manual' && (
                  <span className="px-1.5 py-0.5 rounded bg-mc-bg-tertiary text-mc-text-secondary text-[11px] font-mono">
                    {job.source_kind}
                  </span>
                )}
              </div>
              <h3 className="text-base font-medium text-mc-text">
                {job.label ?? deriveLabel(job)}
              </h3>
              {job.scope_key && (
                <p className="text-[11px] font-mono text-mc-text-secondary break-all">
                  {job.scope_key} <CopyButton text={job.scope_key} />
                </p>
              )}
            </section>

            <section className="grid grid-cols-2 gap-x-4 gap-y-1 text-mc-text-secondary text-[12px]">
              <div>
                <span className="block text-[10px] uppercase tracking-wider opacity-70">Started</span>
                <span className="text-mc-text">{job.started_at ?? '—'}</span>
              </div>
              <div>
                <span className="block text-[10px] uppercase tracking-wider opacity-70">Completed</span>
                <span className="text-mc-text">{job.completed_at ?? '—'}</span>
              </div>
              <div>
                <span className="block text-[10px] uppercase tracking-wider opacity-70">Elapsed</span>
                <span className="text-mc-text">{formatElapsed(job.started_at, job.completed_at)}</span>
              </div>
              <div>
                <span className="block text-[10px] uppercase tracking-wider opacity-70">Cost</span>
                <span className="text-mc-text">
                  {job.cost_cents != null ? `${(job.cost_cents / 100).toFixed(2)}¢` : '—'}
                </span>
              </div>
              <div>
                <span className="block text-[10px] uppercase tracking-wider opacity-70">Role</span>
                <span className="text-mc-text">{job.role ?? '—'}</span>
              </div>
              <div>
                <span className="block text-[10px] uppercase tracking-wider opacity-70">Agent</span>
                <span className="text-mc-text font-mono text-[11px] break-all">
                  {job.agent_id ? (
                    <Link href={`/agents/${encodeURIComponent(job.agent_id)}`} className="hover:underline inline-flex items-center gap-1">
                      {job.agent_id}
                      <ExternalLink className="w-3 h-3" />
                    </Link>
                  ) : '—'}
                </span>
              </div>
              {job.model_used && (
                <div className="col-span-2">
                  <span className="block text-[10px] uppercase tracking-wider opacity-70">Model</span>
                  <span className="text-mc-text font-mono text-[11px]">{job.model_used}</span>
                </div>
              )}
            </section>

            {(job.initiative_id || job.task_id) && (
              <section className="space-y-1">
                <h4 className="text-[10px] uppercase tracking-wider text-mc-text-secondary opacity-70">
                  Targets
                </h4>
                {job.initiative_id && (
                  <p className="text-[12px]">
                    <Link
                      href={`/initiatives/${encodeURIComponent(job.initiative_id)}`}
                      className="text-mc-accent hover:underline inline-flex items-center gap-1"
                    >
                      Initiative: {job.initiative_title ?? job.initiative_id}
                      <ExternalLink className="w-3 h-3" />
                    </Link>
                  </p>
                )}
                {job.task_id && (
                  <p className="text-[12px] font-mono">
                    Task: {job.task_id}
                  </p>
                )}
              </section>
            )}

            {job.error_md && (
              <section className="space-y-1">
                <h4 className="text-[10px] uppercase tracking-wider text-red-300 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" /> Error
                </h4>
                <pre className="text-[12px] text-red-200 bg-red-500/10 border border-red-500/30 rounded p-2 overflow-auto max-h-[40vh] whitespace-pre-wrap break-words">
                  {job.error_md}
                </pre>
              </section>
            )}

            <section className="space-y-1">
              <h4 className="text-[10px] uppercase tracking-wider text-mc-text-secondary opacity-70">
                Trigger body
              </h4>
              {job.trigger_body ? (
                <pre className="text-[11px] text-mc-text-secondary bg-mc-bg border border-mc-border rounded p-2 overflow-auto max-h-[50vh] whitespace-pre-wrap break-words">
                  {job.trigger_body}
                </pre>
              ) : (
                <p className="text-[12px] text-mc-text-secondary italic">
                  Trigger body not captured for this run.
                </p>
              )}
            </section>

            {job.agent_id && job.scope_key && (
              <section className="space-y-2 pt-2 border-t border-mc-border">
                <h4 className="text-[10px] uppercase tracking-wider text-mc-text-secondary opacity-70">
                  Session
                </h4>
                <p className="text-[12px] text-mc-text-secondary">
                  Reset wipes the openclaw history for this scope. Useful when
                  the conversation is stuck on a stale model state.
                </p>
                <button
                  type="button"
                  onClick={() => setResetPending(true)}
                  className="px-2 py-1 rounded border border-red-500/40 text-red-300 hover:bg-red-500/10 text-xs"
                >
                  Reset session
                </button>
              </section>
            )}
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={resetPending}
        title="Reset session?"
        body={
          job?.scope_key ? (
            <div className="space-y-2">
              <p>
                This will wipe the openclaw conversation history for this scope.
                The next dispatch starts cold.
              </p>
              <p className="font-mono text-[11px] text-mc-text-secondary break-all">
                {job.scope_key}
              </p>
            </div>
          ) : null
        }
        confirmLabel={resetting ? 'Resetting…' : 'Reset session'}
        cancelLabel="Keep history"
        destructive
        onConfirm={doReset}
        onCancel={() => setResetPending(false)}
      />
    </>
  );
}

function deriveLabel(job: JobDetail): string {
  if (job.label && job.label.trim()) return job.label;
  switch (job.kind) {
    case 'pm_chat': return 'PM chat';
    case 'plan': return job.initiative_title ? `Plan: ${job.initiative_title}` : 'Plan';
    case 'decompose': return job.initiative_title ? `Decompose: ${job.initiative_title}` : 'Decompose';
    case 'initiative_audit': return job.initiative_title ? `Audit: ${job.initiative_title}` : 'Audit';
    case 'recurring': return 'Recurring tick';
    case 'task_coord': return 'Task coordinator';
    case 'task_role': return 'Task role';
    case 'brief': return 'Brief';
    default: return job.kind;
  }
}
