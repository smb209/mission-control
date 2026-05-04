'use client';

/**
 * Research hub.
 *
 * Three lanes — In progress / Recent results / (Upcoming is a phase-1
 * placeholder until schedules ship in phase 2) — plus a topic library
 * on the left rail. SSE keeps the in-progress lane and recent results
 * live without polling.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Plus, RefreshCw, Search, FileText, Zap, Archive, AlertTriangle, Sparkles } from 'lucide-react';
import { useCurrentWorkspaceId } from '@/components/shell/workspace-context';
import { useMissionControl } from '@/lib/store';
import { formatDistanceToNow } from 'date-fns';
import { CreateTopicDrawer } from '@/components/research/CreateTopicDrawer';
import { RunBriefDrawer } from '@/components/research/RunBriefDrawer';
import { SuggestPickerDrawer } from '@/components/research/SuggestPickerDrawer';
import { useResearchPreflight } from '@/components/research/useResearchPreflight';

interface TopicSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  archived_at: string | null;
}

interface BriefSummary {
  id: string;
  title: string;
  topic_id: string | null;
  agent_run_id: string;
  template: string;
  result_md: string | null;
  error_md: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentRunSummary {
  id: string;
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  kind: 'brief';
  started_at: string | null;
  completed_at: string | null;
  error_md: string | null;
}

const RELEVANT_EVENTS = ['brief_started', 'brief_progress', 'brief_completed', 'brief_failed'];

const STATUS_COLOR: Record<AgentRunSummary['status'], string> = {
  queued:    'bg-mc-bg-tertiary text-mc-text-secondary border-mc-border',
  running:   'bg-mc-accent/15 text-mc-accent border-mc-accent/30',
  complete:  'bg-green-700/20 text-green-300 border-green-500/30',
  failed:    'bg-red-700/20 text-red-300 border-red-500/30',
  cancelled: 'bg-yellow-700/20 text-yellow-300 border-yellow-500/30',
};

export default function ResearchHubPage() {
  const workspaceId = useCurrentWorkspaceId();
  const { events } = useMissionControl();

  const [topics, setTopics] = useState<TopicSummary[]>([]);
  const [briefs, setBriefs] = useState<BriefSummary[]>([]);
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createTopicOpen, setCreateTopicOpen] = useState(false);
  const [runBriefOpen, setRunBriefOpen] = useState(false);
  const [activeTopicId, setActiveTopicId] = useState<string | null>(null);
  const [suggestKind, setSuggestKind] = useState<'topic' | 'brief' | null>(null);

  const preflight = useResearchPreflight(workspaceId);

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

  // Refetch when relevant SSE events fire.
  const latestRelevantId = useMemo(() => {
    return events.find(e => RELEVANT_EVENTS.includes(e.type as string))?.id;
  }, [events]);
  useEffect(() => { if (latestRelevantId) load(); }, [latestRelevantId, load]);

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
    <div className="flex h-full">
      {/* Left rail: topic library */}
      <aside className="w-64 border-r border-mc-border bg-mc-bg-secondary flex flex-col shrink-0">
        <div className="px-3 py-2 border-b border-mc-border flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-mc-text-secondary">Topics</span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setSuggestKind('topic')}
              className="p-1 rounded-sm text-mc-text-secondary hover:text-mc-accent hover:bg-mc-bg-tertiary"
              aria-label="Suggest topics"
              title="Suggest topics — ask the PM to propose long-lived areas to track based on workspace state"
            >
              <Sparkles className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setCreateTopicOpen(true)}
              className="p-1 rounded-sm text-mc-accent hover:bg-mc-bg-tertiary"
              aria-label="Create topic"
              title="Create topic from scratch"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>
        <ul className="flex-1 overflow-y-auto py-1">
          <li>
            <button
              type="button"
              onClick={() => setActiveTopicId(null)}
              className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 ${
                activeTopicId === null ? 'bg-mc-accent/15 text-mc-accent' : 'text-mc-text-secondary hover:text-mc-text hover:bg-mc-bg-tertiary'
              }`}
            >
              <Search className="w-3.5 h-3.5 shrink-0" />
              All
            </button>
          </li>
          {topics.map(t => (
            <li key={t.id}>
              <Link
                href={`/research/topics/${t.id}`}
                className="block px-3 py-1.5 text-sm text-mc-text-secondary hover:text-mc-text hover:bg-mc-bg-tertiary truncate"
                title={t.description}
              >
                {t.archived_at && <Archive className="inline w-3 h-3 mr-1" />}
                {t.name}
              </Link>
            </li>
          ))}
          {topics.length === 0 && !loading && (
            <li className="px-3 py-2 text-xs text-mc-text-secondary/60">No topics yet.</li>
          )}
        </ul>
      </aside>

      {/* Main: lanes */}
      <main className="flex-1 overflow-y-auto p-6">
        <header className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-xl font-semibold text-mc-text">Research</h1>
            <p className="text-sm text-mc-text-secondary mt-0.5">Topics, briefs, and dispatched research runs.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={load}
              className="p-2 rounded-sm text-mc-text-secondary hover:bg-mc-bg-tertiary"
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={() => setSuggestKind('brief')}
              title="Suggest briefs — ask the PM to propose specific research questions based on workspace state"
              className="px-3 py-1.5 text-sm rounded-sm border border-mc-border text-mc-text hover:bg-mc-bg-tertiary flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Suggest briefs
            </button>
            <button
              type="button"
              onClick={() => setRunBriefOpen(true)}
              disabled={!preflight.ok && !preflight.loading}
              title={preflight.ok ? undefined : 'A researcher must be in this workspace before you can dispatch a brief'}
              className="px-3 py-1.5 bg-mc-accent text-mc-bg rounded-sm text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              <Zap className="w-3.5 h-3.5" />
              Run a brief
            </button>
          </div>
        </header>

        {/* Preflight warning. Renders only when something is missing —
            staying GREEN keeps the chrome out of the operator's way. */}
        {!preflight.loading && !preflight.ok && (
          <PreflightBanner preflight={preflight} />
        )}

        {error && (
          <div className="mb-4 px-3 py-2 rounded-sm bg-red-900/20 border border-red-500/30 text-red-300 text-sm">
            {error}
          </div>
        )}

        <Lane title="In progress" emptyText="No briefs running. Hit “Run a brief” to start one.">
          {inProgress.map(b => (
            <BriefRow key={b.id} brief={b} run={runById.get(b.agent_run_id)} topics={topics} />
          ))}
        </Lane>

        <Lane title="Upcoming" emptyText="Schedules land in phase 2 — this lane will populate then.">
          {/* Empty in phase 1 — schedules ship in phase 2. */}
        </Lane>

        <Lane title="Recent results" emptyText="Completed briefs appear here.">
          {recent.map(b => (
            <BriefRow key={b.id} brief={b} run={runById.get(b.agent_run_id)} topics={topics} />
          ))}
        </Lane>
      </main>

      <CreateTopicDrawer
        open={createTopicOpen}
        onClose={() => setCreateTopicOpen(false)}
        workspaceId={workspaceId}
        onCreated={() => { setCreateTopicOpen(false); load(); }}
      />
      {suggestKind && (
        <SuggestPickerDrawer
          open={!!suggestKind}
          onClose={() => setSuggestKind(null)}
          workspaceId={workspaceId}
          kind={suggestKind}
          onAccepted={() => { setSuggestKind(null); load(); }}
        />
      )}
      <RunBriefDrawer
        open={runBriefOpen}
        onClose={() => setRunBriefOpen(false)}
        workspaceId={workspaceId}
        topics={topics.filter(t => !t.archived_at)}
        defaultTopicId={null}
        onLaunched={() => { setRunBriefOpen(false); load(); }}
      />
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
