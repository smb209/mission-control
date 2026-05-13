'use client';

/**
 * /jobs — unified queue surface for every in-flight agent dispatch.
 *
 * Three sections, polled every 2s against `/api/jobs?workspace_id=…`:
 *   - Live (queued+running, pm_chat collapsed by scope_key)
 *   - Scheduled (recurring_jobs due in next 24h)
 *   - Recent (terminal in last 24h, ungrouped)
 *
 * Long-running rows (live elapsed > 5min) get an amber row tint — the
 * only visual flag in PR 2. Subtree tree view, cancel button, and the
 * sidebar live-count pip ship in PR 3-5. See docs/reference/jobs-in-progress.md.
 */

import { useEffect, useState, useMemo } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { showAlertDialog } from '@/lib/show-alert';
import { Activity, Clock, Calendar, History, AlertTriangle, Copy, Check } from 'lucide-react';
import { useCurrentWorkspaceId } from '@/components/shell/workspace-context';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import JobDetailDrawer from './JobDetailDrawer';

const POLL_MS = 2000;
const AMBER_ELAPSED_MS = 5 * 60 * 1000;
const RECENT_PAGE_SIZE = 50;

interface JobsLiveItem {
  id: string;
  kind: string;
  status: string;
  scope_key: string | null;
  scope_type: string | null;
  role: string | null;
  agent_id: string | null;
  initiative_id: string | null;
  task_id: string | null;
  parent_run_id: string | null;
  label: string | null;
  derived_label: string;
  started_at: string | null;
  group_count: number;
}

interface JobsRecentItem extends JobsLiveItem {
  completed_at: string | null;
  cost_cents: number | null;
  model_used: string | null;
  error_md: string | null;
}

interface JobsScheduledItem {
  job_id: string;
  name: string;
  next_run_at: string;
  last_run_at: string | null;
  consecutive_failures: number;
  role: string;
  last_failure_md: string | null;
}

interface JobsResponse {
  live: JobsLiveItem[];
  scheduled: JobsScheduledItem[];
  recent: JobsRecentItem[];
}

function shortId(id: string | null): string {
  if (!id) return '—';
  return id.length > 8 ? id.slice(0, 8) : id;
}

function formatDuration(ms: number): string {
  if (ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function relativeFuture(iso: string, now: number): string {
  const dt = new Date(iso + (iso.includes('T') ? '' : 'Z')).getTime();
  const diff = dt - now;
  if (diff < 0) return 'overdue';
  if (diff < 60_000) return 'in <1m';
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`;
  return `in ${Math.round(diff / 3_600_000)}h`;
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

/**
 * Group flat live rows into a parent-then-children traversal.
 *
 * For every row whose parent_run_id matches another live row's id, the
 * child is rendered indented under its parent (depth 1). Children of
 * children would be deeper, but the subtree-audit fan-out is one level,
 * so depth caps at 1 in practice. Orphaned rows (parent already settled,
 * shouldn't happen with rollup but guarded) appear at the top level.
 */
interface LiveDisplayRow { row: JobsLiveItem; depth: number }

function groupLiveRows(live: ReadonlyArray<JobsLiveItem>): LiveDisplayRow[] {
  const byId = new Map<string, JobsLiveItem>();
  for (const r of live) byId.set(r.id, r);
  const childrenByParent = new Map<string, JobsLiveItem[]>();
  const topLevel: JobsLiveItem[] = [];
  for (const r of live) {
    if (r.parent_run_id && byId.has(r.parent_run_id)) {
      const list = childrenByParent.get(r.parent_run_id) ?? [];
      list.push(r);
      childrenByParent.set(r.parent_run_id, list);
    } else {
      topLevel.push(r);
    }
  }
  const out: LiveDisplayRow[] = [];
  const walk = (row: JobsLiveItem, depth: number) => {
    out.push({ row, depth });
    const kids = childrenByParent.get(row.id);
    if (kids) for (const k of kids) walk(k, depth + 1);
  };
  for (const r of topLevel) walk(r, 0);
  return out;
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

function CopyableScope({ scopeKey }: { scopeKey: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!scopeKey) return <span className="text-mc-text-secondary">—</span>;
  return (
    <button
      type="button"
      onClick={e => {
        e.stopPropagation();
        navigator.clipboard?.writeText(scopeKey).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="inline-flex items-center gap-1 font-mono text-[11px] text-mc-text-secondary hover:text-mc-text"
      title={scopeKey}
    >
      <span className="truncate max-w-[200px]">{scopeKey}</span>
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

export default function JobsPage() {
  const workspaceId = useCurrentWorkspaceId();
  const [data, setData] = useState<JobsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [recentPage, setRecentPage] = useState(0);
  const [pendingCancel, setPendingCancel] = useState<JobsLiveItem | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // PR 5: drill-down drawer state. Holds the agent_runs.id of the row
  // the operator clicked. Drawer fetches /api/jobs/:id on open.
  // Driven by the `?run=<id>` query param so the URL is shareable —
  // the artifacts panel inside the drawer is what makes a deep link
  // useful (operators want to point each other at "this audit's
  // notes" without re-clicking through the table).
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const detailJobId = searchParams.get('run');
  const setDetailJobId = (next: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set('run', next);
    else params.delete('run');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // Children-of-pending counter for the dialog body — only count
  // non-terminal direct children since those are what the cascade
  // hits on the server.
  const pendingChildCount = useMemo(() => {
    if (!pendingCancel || !data) return 0;
    return data.live.filter(r => r.parent_run_id === pendingCancel.id).length;
  }, [pendingCancel, data]);

  const doCancel = async () => {
    if (!pendingCancel) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(pendingCancel.id)}/cancel`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // Route through the global alert shim — same affordance as the
        // rest of the app per UI conventions in CLAUDE.md.
        showAlertDialog('Cancel failed', body.error || `HTTP ${res.status}`);
      }
      // 200 path: the 2s poll picks up the cancelled status; no manual mutation needed.
    } catch (err) {
      showAlertDialog('Cancel failed', err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
      setPendingCancel(null);
    }
  };

  // Tick `now` every second so live elapsed columns refresh without
  // waiting on the 2s poll.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Poll /api/jobs every POLL_MS for the active workspace. Skips when
  // no workspace is selected yet (initial render or onboarding).
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fetchOnce = async () => {
      try {
        const res = await fetch(`/api/jobs?workspace_id=${encodeURIComponent(workspaceId)}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          if (!cancelled) setError(body.error || `HTTP ${res.status}`);
        } else {
          const body: JobsResponse = await res.json();
          if (!cancelled) {
            setData(body);
            setError(null);
          }
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) timer = setTimeout(fetchOnce, POLL_MS);
      }
    };
    fetchOnce();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [workspaceId]);

  const recentSlice = useMemo(() => {
    if (!data) return [];
    const start = recentPage * RECENT_PAGE_SIZE;
    return data.recent.slice(start, start + RECENT_PAGE_SIZE);
  }, [data, recentPage]);

  if (!workspaceId) {
    return (
      <div className="p-8 text-center text-mc-text-secondary">
        Select a workspace from the left nav to see jobs.
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <header className="mb-6 flex items-center gap-3">
        <Activity className="w-5 h-5 text-mc-accent-cyan" />
        <h1 className="text-xl font-semibold text-mc-text">Jobs</h1>
        {data && (
          <span className="text-xs text-mc-text-secondary">
            {data.live.length} live · {data.scheduled.length} scheduled · {data.recent.length} recent
          </span>
        )}
      </header>

      {error && (
        <div className="mb-4 px-3 py-2 rounded border border-red-500/40 bg-red-500/10 text-sm text-red-300">
          Failed to load jobs: {error}
        </div>
      )}

      <Section title="Live" icon={<Clock className="w-4 h-4" />}>
        {!data ? (
          <EmptyRow>Loading…</EmptyRow>
        ) : data.live.length === 0 ? (
          <EmptyRow>No jobs in progress.</EmptyRow>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-wider text-mc-text-secondary">
              <tr className="text-left">
                <Th>Kind</Th>
                <Th>Status</Th>
                <Th>Label</Th>
                <Th>Agent</Th>
                <Th>Scope</Th>
                <Th>Started</Th>
                <Th>Elapsed</Th>
                <Th>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {groupLiveRows(data.live).map(({ row, depth }) => {
                const startedMs = row.started_at
                  ? new Date(row.started_at + (row.started_at.includes('T') ? '' : 'Z')).getTime()
                  : null;
                const elapsedMs = startedMs ? now - startedMs : 0;
                const amber = startedMs && elapsedMs > AMBER_ELAPSED_MS;
                const baseLabel =
                  row.group_count > 1
                    ? `${(row.scope_key ?? '').split(':').pop() ?? row.scope_key} · ${row.group_count} turns in last hour`
                    : row.derived_label;
                return (
                  <tr
                    key={row.id}
                    onClick={() => setDetailJobId(row.id)}
                    className={`border-t border-mc-border cursor-pointer hover:bg-mc-bg-tertiary/50 ${amber ? 'bg-amber-500/10' : ''}`}
                  >
                    <Td><KindBadge kind={row.kind} /></Td>
                    <Td>
                      <span className={`px-1.5 py-0.5 rounded text-[11px] ${statusChipClass(row.status)}`}>
                        {row.status}
                      </span>
                    </Td>
                    <Td className="text-mc-text">
                      {depth > 0 ? (
                        <span className="text-mc-text-secondary mr-2 font-mono">└─</span>
                      ) : null}
                      {baseLabel}
                    </Td>
                    <Td className="text-mc-text-secondary">
                      {row.role ?? '—'} · <span className="font-mono text-[11px]">{shortId(row.agent_id)}</span>
                    </Td>
                    <Td><CopyableScope scopeKey={row.scope_key} /></Td>
                    <Td className="text-mc-text-secondary">{relativePast(row.started_at, now)}</Td>
                    <Td className={amber ? 'text-amber-300 font-medium' : 'text-mc-text-secondary'}>
                      {startedMs ? formatDuration(elapsedMs) : '—'}
                    </Td>
                    <Td className="text-xs">
                      <button
                        type="button"
                        onClick={e => {
                          e.stopPropagation();
                          setPendingCancel(row);
                        }}
                        className="px-2 py-0.5 rounded border border-red-500/40 text-red-300 hover:bg-red-500/10"
                      >
                        Cancel
                      </button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Scheduled (next 24h)" icon={<Calendar className="w-4 h-4" />}>
        {!data ? (
          <EmptyRow>Loading…</EmptyRow>
        ) : data.scheduled.length === 0 ? (
          <EmptyRow>Nothing scheduled in the next 24h.</EmptyRow>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-wider text-mc-text-secondary">
              <tr className="text-left">
                <Th>Name</Th>
                <Th>Next run</Th>
                <Th>Last run</Th>
                <Th>Streak</Th>
                <Th>Role</Th>
              </tr>
            </thead>
            <tbody>
              {data.scheduled.map(row => (
                <tr key={row.job_id} className="border-t border-mc-border">
                  <Td className="text-mc-text">{row.name}</Td>
                  <Td className="text-mc-text-secondary" title={row.next_run_at}>
                    {relativeFuture(row.next_run_at, now)}
                  </Td>
                  <Td className="text-mc-text-secondary" title={row.last_run_at ?? ''}>
                    {row.last_run_at ? relativePast(row.last_run_at, now) : '—'}
                  </Td>
                  <Td>
                    {row.consecutive_failures > 0 ? (
                      <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 text-[11px] cursor-help"
                        title={row.last_failure_md ?? `${row.consecutive_failures} consecutive failures`}
                      >
                        <AlertTriangle className="w-3 h-3" />✗{row.consecutive_failures}
                      </span>
                    ) : (
                      <span className="text-emerald-400 text-[11px]">✓</span>
                    )}
                  </Td>
                  <Td className="text-mc-text-secondary">{row.role}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Recent (24h)" icon={<History className="w-4 h-4" />}>
        {!data ? (
          <EmptyRow>Loading…</EmptyRow>
        ) : data.recent.length === 0 ? (
          <EmptyRow>No jobs completed in the last 24h.</EmptyRow>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wider text-mc-text-secondary">
                <tr className="text-left">
                  <Th>Kind</Th>
                  <Th>Label</Th>
                  <Th>Agent</Th>
                  <Th>Scope</Th>
                  <Th>Completed</Th>
                  <Th>Status</Th>
                  <Th>Cost</Th>
                </tr>
              </thead>
              <tbody>
                {recentSlice.map(row => (
                  <tr
                    key={row.id}
                    onClick={() => setDetailJobId(row.id)}
                    className="border-t border-mc-border cursor-pointer hover:bg-mc-bg-tertiary/50"
                  >
                    <Td><KindBadge kind={row.kind} /></Td>
                    <Td className="text-mc-text">{row.derived_label}</Td>
                    <Td className="text-mc-text-secondary">
                      {row.role ?? '—'} · <span className="font-mono text-[11px]">{shortId(row.agent_id)}</span>
                    </Td>
                    <Td><CopyableScope scopeKey={row.scope_key} /></Td>
                    <Td className="text-mc-text-secondary" title={row.completed_at ?? ''}>
                      {relativePast(row.completed_at, now)}
                    </Td>
                    <Td>
                      <span className={`px-1.5 py-0.5 rounded text-[11px] ${statusChipClass(row.status)}`}>
                        {row.status}
                      </span>
                    </Td>
                    <Td className="text-mc-text-secondary text-xs">
                      {row.cost_cents != null ? `${(row.cost_cents / 100).toFixed(2)}¢` : ''}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.recent.length > RECENT_PAGE_SIZE && (
              <div className="flex items-center justify-between mt-3 text-xs text-mc-text-secondary">
                <span>
                  Showing {recentPage * RECENT_PAGE_SIZE + 1}–
                  {Math.min((recentPage + 1) * RECENT_PAGE_SIZE, data.recent.length)} of {data.recent.length}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={recentPage === 0}
                    onClick={() => setRecentPage(p => Math.max(0, p - 1))}
                    className="px-2 py-1 rounded border border-mc-border hover:bg-mc-bg-tertiary disabled:opacity-50"
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    disabled={(recentPage + 1) * RECENT_PAGE_SIZE >= data.recent.length}
                    onClick={() => setRecentPage(p => p + 1)}
                    className="px-2 py-1 rounded border border-mc-border hover:bg-mc-bg-tertiary disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </Section>

      <ConfirmDialog
        open={pendingCancel !== null}
        title="Cancel job?"
        body={
          pendingCancel ? (
            <div className="space-y-2">
              <p>
                <span className="font-mono text-[11px]">{pendingCancel.kind}</span>
                {' · '}
                <span>{pendingCancel.derived_label}</span>
              </p>
              {pendingCancel.scope_key && (
                <p className="font-mono text-[11px] text-mc-text-secondary break-all">
                  {pendingCancel.scope_key}
                </p>
              )}
              {pendingChildCount > 0 && (
                <p className="text-amber-300">
                  This will also cancel {pendingChildCount} in-flight {pendingChildCount === 1 ? 'child' : 'children'}.
                </p>
              )}
              <p className="text-mc-text-secondary">
                The agent may continue running briefly while shutdown propagates — gateway abort is best-effort.
              </p>
            </div>
          ) : null
        }
        confirmLabel={cancelling ? 'Cancelling…' : 'Cancel job'}
        cancelLabel="Keep running"
        destructive
        onConfirm={doCancel}
        onCancel={() => setPendingCancel(null)}
      />

      <JobDetailDrawer
        jobId={detailJobId}
        onClose={() => setDetailJobId(null)}
      />
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-6 rounded border border-mc-border bg-mc-bg-secondary">
      <header className="px-4 py-2 border-b border-mc-border flex items-center gap-2 text-sm font-medium text-mc-text">
        {icon}
        {title}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-sm text-mc-text-secondary text-center">{children}</p>;
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>;
}

function Td({ children, className = '', title }: { children: React.ReactNode; className?: string; title?: string }) {
  return <td className={`px-3 py-2 align-top ${className}`} title={title}>{children}</td>;
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <span className="px-1.5 py-0.5 rounded bg-mc-bg-tertiary text-mc-text-secondary text-[11px] font-mono">
      {kind}
    </span>
  );
}
