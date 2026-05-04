'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, ExternalLink, RefreshCw, RotateCw, Trash2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useMissionControl } from '@/lib/store';
import { formatDistanceToNow } from 'date-fns';
import { ConfirmDialog } from '@/components/ConfirmDialog';

interface Brief {
  id: string;
  workspace_id: string;
  agent_run_id: string;
  topic_id: string | null;
  template: string;
  title: string;
  prompt: string;
  result_md: string | null;
  citations: Array<{ url: string; title?: string; snippet?: string }>;
  error_md: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentRun {
  id: string;
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  started_at: string | null;
  completed_at: string | null;
  cost_cents: number | null;
  model_used: string | null;
}

interface Topic { id: string; name: string }

const RELEVANT_EVENTS = ['brief_started', 'brief_progress', 'brief_completed', 'brief_failed'];

const STATUS_COLOR: Record<AgentRun['status'], string> = {
  queued:    'bg-mc-bg-tertiary text-mc-text-secondary border-mc-border',
  running:   'bg-mc-accent/15 text-mc-accent border-mc-accent/30',
  complete:  'bg-green-700/20 text-green-300 border-green-500/30',
  failed:    'bg-red-700/20 text-red-300 border-red-500/30',
  cancelled: 'bg-yellow-700/20 text-yellow-300 border-yellow-500/30',
};

export default function BriefDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { events } = useMissionControl();
  const [brief, setBrief] = useState<Brief | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [topic, setTopic] = useState<Topic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!params.id) return;
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/briefs/${params.id}`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const { brief: b, agent_run } = await res.json();
      setBrief(b);
      setRun(agent_run);
      if (b.topic_id) {
        const t = await fetch(`/api/topics/${b.topic_id}`).then(r => r.ok ? r.json() : null);
        setTopic(t ? { id: t.id, name: t.name } : null);
      } else {
        setTopic(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load brief');
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => { load(); }, [load]);

  const latestRelevantId = useMemo(
    () => events.find(e => RELEVANT_EVENTS.includes(e.type as string))?.id,
    [events],
  );
  useEffect(() => { if (latestRelevantId) load(); }, [latestRelevantId, load]);

  const rerun = useCallback(async () => {
    if (!brief || rerunning) return;
    setRerunning(true);
    setRerunError(null);
    try {
      const res = await fetch(`/api/briefs/${brief.id}/rerun`, { method: 'POST' });
      if (!res.ok && res.status !== 202) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Re-run failed (${res.status})`);
      }
      const { brief: cloned } = await res.json();
      router.push(`/research/briefs/${cloned.id}`);
    } catch (e) {
      setRerunError(e instanceof Error ? e.message : 'Re-run failed');
    } finally {
      setRerunning(false);
    }
  }, [brief, rerunning, router]);

  const doDelete = useCallback(async () => {
    if (!brief || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/briefs/${brief.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Delete failed (${res.status})`);
      }
      router.push(brief.topic_id ? `/research/topics/${brief.topic_id}` : '/research');
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Delete failed');
      setDeleting(false);
      setConfirmDelete(false);
    }
  }, [brief, deleting, router]);

  if (error) return <div className="p-6 text-red-300">{error}</div>;
  if (!brief || !run) return <div className="p-6 text-mc-text-secondary">{loading ? 'Loading…' : 'Brief not found.'}</div>;

  const isTerminal = run.status === 'complete' || run.status === 'failed' || run.status === 'cancelled';
  const stamp = run.completed_at ?? run.started_at ?? brief.created_at;

  return (
    <div className="px-6 py-5 max-w-4xl">
      <Link
        href="/research"
        className="inline-flex items-center gap-1 text-xs text-mc-text-secondary hover:text-mc-accent mb-4"
      >
        <ArrowLeft className="w-3 h-3" /> All research
      </Link>

      <header className="flex items-start justify-between mb-4">
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold text-mc-text mb-1">{brief.title}</h1>
          <div className="flex items-center gap-2 text-[11px] text-mc-text-secondary flex-wrap">
            <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-sm border ${STATUS_COLOR[run.status]}`}>
              {run.status}
            </span>
            <span>{brief.template}</span>
            {topic && (
              <>
                <span>·</span>
                <Link href={`/research/topics/${topic.id}`} className="hover:text-mc-accent">{topic.name}</Link>
              </>
            )}
            <span>· {formatDistanceToNow(new Date(stamp), { addSuffix: true })}</span>
            {run.model_used && <span>· {run.model_used}</span>}
            {run.cost_cents !== null && <span>· ${(run.cost_cents / 100).toFixed(2)}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={load}
            className="p-2 rounded-sm text-mc-text-secondary hover:bg-mc-bg-tertiary"
            aria-label="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={rerun}
            disabled={!isTerminal || rerunning}
            title={
              !isTerminal
                ? 'Brief is still running — wait for it to finish before re-running'
                : 'Clones this brief (same prompt + topic) and dispatches the clone'
            }
            className="px-3 py-1.5 text-sm rounded-sm border border-mc-border text-mc-text hover:bg-mc-bg-tertiary disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            <RotateCw className={`w-3.5 h-3.5 ${rerunning ? 'animate-spin' : ''}`} />
            {rerunning ? 'Re-running…' : 'Re-run'}
          </button>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            disabled={deleting}
            title="Delete this brief"
            aria-label="Delete brief"
            className="p-2 rounded-sm border border-mc-border text-red-300/80 hover:bg-red-900/20 hover:text-red-300 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {brief.error_md && (
        <div className="mb-4 px-3 py-2 rounded-sm bg-red-900/20 border border-red-500/30 text-red-300 text-sm">
          <div className="font-medium mb-1">Brief failed</div>
          <pre className="whitespace-pre-wrap text-xs font-mono">{brief.error_md}</pre>
        </div>
      )}

      {rerunError && (
        <div className="mb-4 px-3 py-2 rounded-sm bg-red-900/20 border border-red-500/30 text-red-300 text-sm">
          {rerunError}
        </div>
      )}

      {deleteError && (
        <div className="mb-4 px-3 py-2 rounded-sm bg-red-900/20 border border-red-500/30 text-red-300 text-sm">
          {deleteError}
        </div>
      )}

      <section className="mb-4">
        <h2 className="text-[11px] uppercase tracking-wider text-mc-text-secondary mb-2">Prompt</h2>
        <pre className="px-3 py-2 bg-mc-bg-secondary border border-mc-border rounded-sm text-xs text-mc-text whitespace-pre-wrap font-sans">{brief.prompt}</pre>
      </section>

      <section className="mb-4">
        <h2 className="text-[11px] uppercase tracking-wider text-mc-text-secondary mb-2">Result</h2>
        {brief.result_md ? (
          <article className="prose prose-invert prose-sm max-w-none px-4 py-3 bg-mc-bg-secondary border border-mc-border rounded-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{brief.result_md}</ReactMarkdown>
          </article>
        ) : (
          <p className="text-sm text-mc-text-secondary/70 italic">
            {isTerminal ? 'No result body.' : 'Brief is still running…'}
          </p>
        )}
      </section>

      {brief.citations.length > 0 && (
        <section className="mb-4">
          <h2 className="text-[11px] uppercase tracking-wider text-mc-text-secondary mb-2">
            Sources ({brief.citations.length})
          </h2>
          <ul className="space-y-2 px-4 py-3 bg-mc-bg-secondary border border-mc-border rounded-sm">
            {brief.citations.map(c => (
              <li key={c.url} className="text-xs">
                <div className="flex items-baseline gap-1.5">
                  <ExternalLink className="w-3 h-3 text-mc-text-secondary shrink-0 translate-y-[1px]" />
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-mc-accent hover:underline break-all"
                  >
                    {c.title || c.url}
                  </a>
                </div>
                {c.snippet && (
                  <div className="ml-[18px] mt-0.5 text-mc-text-secondary leading-snug">
                    {c.snippet}
                  </div>
                )}
                {c.title && c.title !== c.url && (
                  <div className="ml-[18px] mt-0.5 text-[10px] text-mc-text-secondary/60 break-all">
                    {c.url}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this brief?"
        body={`The brief "${brief.title}" and its agent run will be permanently removed. This cannot be undone.`}
        confirmLabel={deleting ? 'Deleting…' : 'Delete'}
        destructive
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
