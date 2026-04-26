'use client';

/**
 * /debug/mcp — sc-mission-control MCP adapter dashboard.
 *
 * Shows:
 *   • Status header: endpoint enabled flag, number of tools registered,
 *     lifetime / last-hour / last-day counts, last-hour error count.
 *   • Per-tool table: calls, errors, avg + max duration, last-called.
 *   • Per-agent table: calls, errors, last-called.
 *   • Live feed of mcp.tool_call rows, SSE-driven and expandable for
 *     metadata / error details.
 *
 * Aggregates come from GET /api/debug/mcp/status (runs server-side SQL);
 * the live feed tails /api/events/stream filtered to
 * type='debug_event_logged' with event_type='mcp.tool_call'. Initial
 * feed load uses /api/debug/events?event_type=mcp.tool_call&limit=100.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ChevronDown, ChevronRight, RefreshCw, Activity, AlertCircle, CheckCircle2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { DebugEvent } from '@/lib/debug-log';

interface Status {
  enabled: boolean;
  tools: { count: number; names: string[] };
  counts: { total: number; last_hour: number; last_day: number; errors_last_hour: number };
  per_tool: Array<{
    tool_name: string | null;
    calls: number;
    errors: number;
    avg_ms: number | null;
    p95_ms: number | null;
    last_at: string | null;
  }>;
  per_agent: Array<{
    agent_id: string | null;
    agent_name: string | null;
    calls: number;
    errors: number;
    last_at: string | null;
  }>;
}

export default function McpDebugPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [events, setEvents] = useState<DebugEvent[]>([]);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [statusLoading, setStatusLoading] = useState(true);
  const [collectionEnabled, setCollectionEnabled] = useState<boolean | null>(null);

  const refetch = useCallback(async () => {
    const [s, e, settings] = await Promise.all([
      fetch('/api/debug/mcp/status').then((r) => r.json()),
      fetch('/api/debug/events?event_type=mcp.tool_call&limit=100').then((r) => r.json()),
      fetch('/api/debug/settings').then((r) => r.json()),
    ]);
    setStatus(s);
    setEvents(e.events || []);
    setCollectionEnabled(Boolean(settings.collection_enabled));
    setStatusLoading(false);
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Live tail — subscribe to SSE, append mcp.tool_call rows only.
  const statusRef = useRef<Status | null>(null);
  statusRef.current = status;
  useEffect(() => {
    const es = new EventSource('/api/events/stream');
    es.onmessage = (event) => {
      if (event.data.startsWith(':')) return;
      try {
        const parsed = JSON.parse(event.data) as { type: string; payload: unknown };
        if (parsed.type === 'debug_event_logged') {
          const row = parsed.payload as DebugEvent;
          if (row.event_type !== 'mcp.tool_call') return;
          setEvents((prev) => [row, ...prev].slice(0, 100));
          // Bump top-level counters optimistically so the header reflects
          // live activity without waiting for the next refetch. The real
          // per-tool / per-agent aggregates come on manual refresh.
          if (statusRef.current) {
            const next = { ...statusRef.current };
            next.counts = {
              ...next.counts,
              total: next.counts.total + 1,
              last_hour: next.counts.last_hour + 1,
              last_day: next.counts.last_day + 1,
              errors_last_hour: next.counts.errors_last_hour + (row.error ? 1 : 0),
            };
            setStatus(next);
          }
        } else if (parsed.type === 'debug_events_cleared') {
          setEvents([]);
          setStatus((prev) =>
            prev
              ? {
                  ...prev,
                  counts: { total: 0, last_hour: 0, last_day: 0, errors_last_hour: 0 },
                  per_tool: [],
                  per_agent: [],
                }
              : prev,
          );
        }
      } catch {
        /* malformed SSE frame — ignore */
      }
    };
    return () => es.close();
  }, []);

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-mc-bg text-mc-text">
      <header className="border-b border-mc-border bg-mc-bg-secondary/40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-4">
          <Link href="/debug" className="text-mc-text-secondary hover:text-mc-text shrink-0">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold flex items-center gap-2">
              <Activity className="w-5 h-5 text-mc-accent" />
              sc-mission-control MCP
            </h1>
            <p className="text-xs text-mc-text-secondary mt-0.5">
              Tool-call activity, per-agent breakdown, live feed.
            </p>
          </div>
          <button
            onClick={refetch}
            className="min-h-9 px-3 text-xs rounded-lg border border-mc-border bg-mc-bg-secondary hover:bg-mc-bg-tertiary flex items-center gap-1.5"
            title="Refresh aggregates"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {/* Status cards */}
        <section className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <StatusCard
            label="Endpoint"
            value={
              statusLoading ? '…' : status?.enabled ? 'Enabled' : 'Disabled'
            }
            sub={status?.enabled ? '/api/mcp' : 'MC_MCP_ENABLED=0'}
            tone={statusLoading ? 'neutral' : status?.enabled ? 'ok' : 'warn'}
          />
          <StatusCard
            label="Tools registered"
            value={statusLoading ? '…' : String(status?.tools.count ?? 0)}
            sub={status?.tools.names.slice(0, 3).join(', ') + (status && status.tools.names.length > 3 ? '…' : '')}
            tone="neutral"
          />
          <StatusCard
            label="Calls (last 1h)"
            value={statusLoading ? '…' : String(status?.counts.last_hour ?? 0)}
            sub={`${status?.counts.last_day ?? 0} in last 24h`}
            tone="neutral"
          />
          <StatusCard
            label="Errors (last 1h)"
            value={statusLoading ? '…' : String(status?.counts.errors_last_hour ?? 0)}
            sub={
              status && status.counts.last_hour > 0
                ? `${((status.counts.errors_last_hour / status.counts.last_hour) * 100).toFixed(1)}% error rate`
                : '—'
            }
            tone={
              status && status.counts.errors_last_hour > 0 ? 'error' : 'ok'
            }
          />
          <StatusCard
            label="Lifetime calls"
            value={statusLoading ? '…' : String(status?.counts.total ?? 0)}
            sub="Since debug collection started"
            tone="neutral"
          />
        </section>

        {/* Collection hint */}
        {collectionEnabled === false && (
          <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-yellow-400 shrink-0 mt-0.5" />
            <div className="text-sm">
              <div className="font-medium text-yellow-200">Debug collection is OFF.</div>
              <div className="text-mc-text-secondary mt-1">
                MCP tool calls are not being recorded.{' '}
                <Link href="/debug" className="text-mc-accent hover:underline">
                  Turn collection on in the debug console
                </Link>
                {' '}to populate these tables and the live feed.
              </div>
            </div>
          </div>
        )}

        {/* Per-tool + per-agent side by side on wide screens */}
        <section className="grid lg:grid-cols-2 gap-6">
          <div>
            <h2 className="text-sm font-medium text-mc-text-secondary mb-2">Per-tool activity (last 24h)</h2>
            <div className="rounded-lg border border-mc-border bg-mc-bg-secondary overflow-hidden">
              {!status || status.per_tool.length === 0 ? (
                <div className="px-4 py-8 text-sm text-mc-text-secondary text-center">
                  No MCP tool calls in the last 24 hours.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-xs text-mc-text-secondary uppercase tracking-wide border-b border-mc-border">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Tool</th>
                      <th className="text-right px-3 py-2 font-medium">Calls</th>
                      <th className="text-right px-3 py-2 font-medium">Errors</th>
                      <th className="text-right px-3 py-2 font-medium">Avg ms</th>
                      <th className="text-right px-3 py-2 font-medium">Max ms</th>
                      <th className="text-right px-3 py-2 font-medium">Last</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.per_tool.map((r) => (
                      <tr key={r.tool_name ?? '(none)'} className="border-b border-mc-border/40 last:border-b-0">
                        <td className="px-3 py-2 font-mono text-xs">{r.tool_name ?? '(unknown)'}</td>
                        <td className="px-3 py-2 text-right">{r.calls}</td>
                        <td className={`px-3 py-2 text-right ${r.errors > 0 ? 'text-red-400' : ''}`}>{r.errors}</td>
                        <td className="px-3 py-2 text-right text-mc-text-secondary">{r.avg_ms ?? '—'}</td>
                        <td className="px-3 py-2 text-right text-mc-text-secondary">{r.p95_ms ?? '—'}</td>
                        <td className="px-3 py-2 text-right text-xs text-mc-text-secondary">
                          {r.last_at ? formatDistanceToNow(new Date(r.last_at), { addSuffix: true }) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div>
            <h2 className="text-sm font-medium text-mc-text-secondary mb-2">Per-agent activity (last 24h)</h2>
            <div className="rounded-lg border border-mc-border bg-mc-bg-secondary overflow-hidden">
              {!status || status.per_agent.length === 0 ? (
                <div className="px-4 py-8 text-sm text-mc-text-secondary text-center">
                  No agents have called MCP tools in the last 24 hours.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-xs text-mc-text-secondary uppercase tracking-wide border-b border-mc-border">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Agent</th>
                      <th className="text-right px-3 py-2 font-medium">Calls</th>
                      <th className="text-right px-3 py-2 font-medium">Errors</th>
                      <th className="text-right px-3 py-2 font-medium">Last</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.per_agent.map((r) => (
                      <tr key={r.agent_id ?? '(null)'} className="border-b border-mc-border/40 last:border-b-0">
                        <td className="px-3 py-2">
                          <div className="font-medium">{r.agent_name ?? '(unknown agent)'}</div>
                          {r.agent_id && (
                            <div className="text-xs text-mc-text-secondary font-mono truncate max-w-[20ch]">
                              {r.agent_id}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">{r.calls}</td>
                        <td className={`px-3 py-2 text-right ${r.errors > 0 ? 'text-red-400' : ''}`}>{r.errors}</td>
                        <td className="px-3 py-2 text-right text-xs text-mc-text-secondary">
                          {r.last_at ? formatDistanceToNow(new Date(r.last_at), { addSuffix: true }) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </section>

        {/* Live feed */}
        <section>
          <div className="flex items-baseline gap-2 mb-2">
            <h2 className="text-sm font-medium text-mc-text-secondary">Live tool-call feed</h2>
            <span className="text-xs text-mc-text-secondary">
              (most recent {events.length}, tails in real time)
            </span>
          </div>
          {events.length === 0 ? (
            <div className="rounded-lg border border-mc-border bg-mc-bg-secondary px-4 py-8 text-sm text-mc-text-secondary text-center">
              No MCP tool calls recorded yet.
            </div>
          ) : (
            <div className="space-y-1.5">
              {events.map((e) => (
                <McpCallRow
                  key={e.id}
                  event={e}
                  expanded={expandedIds.has(e.id)}
                  onToggle={() => toggleExpand(e.id)}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

// ─── sub-components ─────────────────────────────────────────────────

function StatusCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: 'ok' | 'warn' | 'error' | 'neutral';
}) {
  const toneCls = {
    ok: 'border-green-500/30 bg-green-500/5',
    warn: 'border-yellow-500/30 bg-yellow-500/5',
    error: 'border-red-500/30 bg-red-500/5',
    neutral: 'border-mc-border bg-mc-bg-secondary',
  }[tone];
  return (
    <div className={`rounded-lg border ${toneCls} p-3`}>
      <div className="text-[11px] uppercase tracking-wide text-mc-text-secondary">{label}</div>
      <div className="text-xl font-semibold mt-1">{value}</div>
      {sub && <div className="text-xs text-mc-text-secondary mt-1 truncate">{sub}</div>}
    </div>
  );
}

function McpCallRow({
  event,
  expanded,
  onToggle,
}: {
  event: DebugEvent;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasError = Boolean(event.error);
  const meta = useMemo(() => {
    if (!event.metadata) return null;
    try {
      return JSON.parse(event.metadata) as {
        tool_name?: string;
        ok?: boolean;
        args?: Record<string, unknown>;
      };
    } catch {
      return null;
    }
  }, [event.metadata]);
  const toolName = meta?.tool_name ?? '(unknown tool)';

  return (
    <div
      className={`rounded-md border ${
        hasError ? 'border-red-500/40 bg-red-500/5' : 'border-mc-border bg-mc-bg-secondary'
      }`}
    >
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-mc-bg-tertiary/40 rounded-md"
      >
        {expanded ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
        {hasError ? (
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
        ) : (
          <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
        )}
        <span className="font-mono text-sm font-medium">{toolName}</span>
        <span className="text-xs text-mc-text-secondary truncate font-mono">
          agent={event.agent_id ? event.agent_id.slice(0, 8) : '—'}
          {event.task_id ? ` · task=${event.task_id.slice(0, 8)}` : ''}
        </span>
        <span className="ml-auto text-xs text-mc-text-secondary shrink-0">
          {event.duration_ms !== null ? `${event.duration_ms}ms` : '—'}
          {' · '}
          {formatDistanceToNow(new Date(event.created_at), { addSuffix: true })}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-mc-border/60 px-3 py-3 text-xs space-y-2 font-mono">
          <DetailRow label="agent_id" value={event.agent_id ?? '(null)'} mono />
          <DetailRow label="task_id" value={event.task_id ?? '(null)'} mono />
          <DetailRow label="duration_ms" value={String(event.duration_ms ?? '—')} />
          <DetailRow label="created_at" value={event.created_at} mono />
          {event.error && (
            <div>
              <div className="text-mc-text-secondary mb-1">error</div>
              <pre className="bg-red-500/5 border border-red-500/20 rounded p-2 whitespace-pre-wrap break-words text-red-300 text-[11px]">
                {event.error}
              </pre>
            </div>
          )}
          {meta && (
            <div>
              <div className="text-mc-text-secondary mb-1">metadata</div>
              <pre className="bg-mc-bg-tertiary/40 border border-mc-border rounded p-2 whitespace-pre-wrap break-words text-[11px]">
                {JSON.stringify(meta, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-3">
      <div className="text-mc-text-secondary w-24 shrink-0">{label}</div>
      <div className={`flex-1 break-all ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}
