'use client';

/**
 * Research hub.
 *
 * Renders inside the persistent research shell (see
 * `(app)/research/layout.tsx`). The left rail (topics + briefs +
 * Suggest / Create / Run buttons) is the layout's responsibility;
 * this page just owns the main panel.
 *
 * Three lanes — In progress / Upcoming (placeholder) / Recent results.
 * SSE keeps the in-progress lane and recent results live without
 * polling.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, FileText, AlertTriangle } from 'lucide-react';
import { useCurrentWorkspaceId } from '@/components/shell/workspace-context';
import { formatDistanceToNow } from 'date-fns';
import { useResearchPreflight } from '@/components/research/useResearchPreflight';

interface TopicSummary {
  id: string;
  name: string;
  archived_at: string | null;
}

interface BriefSummary {
  id: string;
  title: string;
  topic_id: string | null;
  agent_run_id: string;
  template: string;
  created_at: string;
}

interface AgentRunSummary {
  id: string;
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  kind: 'brief';
  started_at: string | null;
  completed_at: string | null;
}

const RELEVANT_EVENTS = new Set([
  'brief_started', 'brief_progress', 'brief_completed', 'brief_failed',
]);

const STATUS_COLOR: Record<AgentRunSummary['status'], string> = {
  queued:    'bg-mc-bg-tertiary text-mc-text-secondary border-mc-border',
  running:   'bg-mc-accent/15 text-mc-accent border-mc-accent/30',
  complete:  'bg-green-700/20 text-green-300 border-green-500/30',
  failed:    'bg-red-700/20 text-red-300 border-red-500/30',
  cancelled: 'bg-yellow-700/20 text-yellow-300 border-yellow-500/30',
};

export default function ResearchHubPage() {
  const workspaceId = useCurrentWorkspaceId();
  const preflight = useResearchPreflight(workspaceId);

  const [topics, setTopics] = useState<TopicSummary[]>([]);
  const [briefs, setBriefs] = useState<BriefSummary[]>([]);
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const qs = `?workspace_id=${encodeURIComponent(workspaceId)}`;
      const [t, b, r] = await Promise.all([
        fetch(`/api/topics${qs}`).then(res => res.ok ? res.json() : Promise.reject(new Error(`topics: ${res.status}`))),
        fetch(`/api/briefs${qs}&limit=20`).then(res => res.ok ? res.json() : Promise.reject(new Error(`briefs: ${res.status}`))),
        fetch(`/api/agent-runs${qs}&kind=brief&limit=50`).then(res => res.ok ? res.json() : Promise.reject(new Error(`agent-runs: ${res.status}`))),
      ]);
      setTopics(t);
      setBriefs(b);
      setRuns(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load research data');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { load(); }, [load]);

  // Subscribe directly to SSE — the global events store doesn't
  // surface brief_* events, so we open our own stream like the rail
  // does. See RELEVANT_EVENTS doc.
  useEffect(() => {
    const es = new EventSource('/api/events/stream');
    es.onmessage = (raw) => {
      try {
        if (raw.data.startsWith(':')) return;
        const evt = JSON.parse(raw.data) as { type?: string };
        if (evt.type && RELEVANT_EVENTS.has(evt.type)) load();
      } catch { /* ignore parse errors */ }
    };
    return () => es.close();
  }, [load]);

  const runById = useMemo(() => {
    const m = new Map<string, AgentRunSummary>();
    for (const r of runs) m.set(r.id, r);
    return m;
  }, [runs]);

  const inProgress = useMemo(
    () => briefs.filter(b => {
      const r = runById.get(b.agent_run_id);
      return r && (r.status === 'queued' || r.status === 'running');
    }),
    [briefs, runById],
  );

  const recent = useMemo(
    () => briefs.filter(b => {
      const r = runById.get(b.agent_run_id);
      return r && (r.status === 'complete' || r.status === 'failed' || r.status === 'cancelled');
    }).slice(0, 10),
    [briefs, runById],
  );

  if (!workspaceId) {
    return <div className="p-6 text-mc-text-secondary">Select a workspace to view research.</div>;
  }

  return (
    <div className="p-6">
      <header className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold text-mc-text">Research</h1>
          <p className="text-sm text-mc-text-secondary mt-0.5">Topics, briefs, and dispatched research runs.</p>
        </div>
        <button
          type="button"
          onClick={load}
          className="p-2 rounded-sm text-mc-text-secondary hover:bg-mc-bg-tertiary"
          title="Refresh"
          aria-label="Refresh"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </header>

      {!preflight.loading && !preflight.ok && (
        <PreflightBanner preflight={preflight} />
      )}

      {error && (
        <div className="mb-4 px-3 py-2 rounded-sm bg-red-900/20 border border-red-500/30 text-red-300 text-sm">
          {error}
        </div>
      )}

      <Lane title="In progress" emptyText="No briefs running. Use the rail’s Run button to start one.">
        {inProgress.map(b => (
          <BriefRow key={b.id} brief={b} run={runById.get(b.agent_run_id)} topics={topics} />
        ))}
      </Lane>

      <Lane title="Upcoming" emptyText="Schedules land in phase 2 — this lane will populate then." />

      <Lane title="Recent results" emptyText="Completed briefs appear here.">
        {recent.map(b => (
          <BriefRow key={b.id} brief={b} run={runById.get(b.agent_run_id)} topics={topics} />
        ))}
      </Lane>
    </div>
  );
}

function PreflightBanner({
  preflight,
}: {
  preflight: { hasResearcher: boolean; hasRunner: boolean; gatewayConnected: boolean };
}) {
  const messages: { title: string; body: React.ReactNode }[] = [];

  if (!preflight.hasResearcher) {
    messages.push({
      title: 'No researcher in this workspace',
      body: (
        <>
          A researcher must be in this workspace's roster before briefs can be dispatched. Add one via{' '}
          <Link href="/agents" className="underline hover:text-mc-accent">
            Agents → Add agents
          </Link>{' '}
          (the Researcher role, or the &ldquo;Research &amp; write&rdquo; team).
        </>
      ),
    });
  }
  if (!preflight.hasRunner) {
    messages.push({
      title: 'No runner agent registered',
      body: (
        <>
          A workspace runner (<code>mc-runner-dev</code>) hosts the actual chat sessions for role-scoped dispatches. Provision it via the openclaw gateway, then return here.
        </>
      ),
    });
  }
  if (!preflight.gatewayConnected && preflight.hasResearcher && preflight.hasRunner) {
    messages.push({
      title: 'Openclaw gateway is reconnecting',
      body: (
        <>
          The MC↔gateway WebSocket is currently disconnected (typically after an HMR or dev-server restart). Briefs dispatched right now will retry automatically for a few seconds; if this banner stays up, check that the gateway process is running.
        </>
      ),
    });
  }

  return (
    <div className="mb-4 px-4 py-3 rounded-sm bg-amber-900/20 border border-amber-500/40 text-amber-100 text-sm flex gap-3">
      <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
      <div className="flex-1 space-y-2">
        {messages.map((m, i) => (
          <div key={i}>
            <div className="font-medium">{m.title}</div>
            <div className="text-amber-100/80">{m.body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Lane({
  title,
  emptyText,
  children,
}: {
  title: string;
  emptyText: string;
  children?: React.ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : !!children;
  return (
    <section className="mb-6">
      <h2 className="text-[11px] uppercase tracking-wider text-mc-text-secondary mb-2">{title}</h2>
      {hasChildren ? (
        <ul className="space-y-2">{children}</ul>
      ) : (
        <p className="text-sm text-mc-text-secondary/70 italic">{emptyText}</p>
      )}
    </section>
  );
}

function BriefRow({
  brief,
  run,
  topics,
}: {
  brief: BriefSummary;
  run: AgentRunSummary | undefined;
  topics: TopicSummary[];
}) {
  const status = run?.status ?? 'queued';
  const topic = brief.topic_id ? topics.find(t => t.id === brief.topic_id) : null;
  const stamp = run?.completed_at ?? run?.started_at ?? brief.created_at;
  return (
    <li className="border border-mc-border rounded-sm bg-mc-bg-secondary hover:bg-mc-bg-tertiary transition-colors">
      <Link href={`/research/briefs/${brief.id}`} className="flex items-center gap-3 px-3 py-2">
        <FileText className="w-4 h-4 text-mc-text-secondary shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-mc-text truncate">{brief.title}</div>
          <div className="text-[11px] text-mc-text-secondary mt-0.5 flex items-center gap-2">
            <span>{brief.template}</span>
            {topic && <span>· {topic.name}</span>}
            <span>· {formatDistanceToNow(new Date(stamp), { addSuffix: true })}</span>
          </div>
        </div>
        <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-sm border ${STATUS_COLOR[status]}`}>
          {status}
        </span>
      </Link>
    </li>
  );
}
