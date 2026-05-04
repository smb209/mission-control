'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Archive, ArchiveRestore, FileText, RefreshCw, Zap } from 'lucide-react';
import { useCurrentWorkspaceId } from '@/components/shell/workspace-context';
import { formatDistanceToNow } from 'date-fns';
import { RunBriefDrawer } from '@/components/research/RunBriefDrawer';
import { ConfirmDialog } from '@/components/ConfirmDialog';

interface Topic {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  tags: string[];
  archived_at: string | null;
  created_at: string;
}

interface BriefSummary {
  id: string;
  title: string;
  agent_run_id: string;
  template: string;
  created_at: string;
}

const RELEVANT_EVENTS = new Set(['brief_started', 'brief_completed', 'brief_failed']);

export default function TopicDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const workspaceId = useCurrentWorkspaceId();
  const [topic, setTopic] = useState<Topic | null>(null);
  const [briefs, setBriefs] = useState<BriefSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [runBriefOpen, setRunBriefOpen] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const load = useCallback(async () => {
    if (!params.id) return;
    setLoading(true); setError(null);
    try {
      const t = await fetch(`/api/topics/${params.id}`).then(r => r.ok ? r.json() : Promise.reject(new Error(`topic: ${r.status}`)));
      setTopic(t);
      const b = await fetch(`/api/briefs?workspace_id=${encodeURIComponent(t.workspace_id)}&topic_id=${encodeURIComponent(t.id)}`).then(r => r.ok ? r.json() : []);
      setBriefs(b);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load topic');
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => { load(); }, [load]);

  // Direct SSE — global events store doesn't surface brief_* events.
  useEffect(() => {
    const es = new EventSource('/api/events/stream');
    es.onmessage = (raw) => {
      try {
        if (raw.data.startsWith(':')) return;
        const evt = JSON.parse(raw.data) as { type?: string };
        if (evt.type && RELEVANT_EVENTS.has(evt.type)) load();
      } catch { /* ignore */ }
    };
    return () => es.close();
  }, [load]);

  const archive = async (archived: boolean) => {
    if (!topic) return;
    const res = await fetch(`/api/topics/${topic.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived }),
    });
    if (res.ok) load();
  };

  if (!workspaceId) {
    return <div className="p-6 text-mc-text-secondary">Select a workspace to view this topic.</div>;
  }
  if (error) {
    return <div className="p-6 text-red-300">{error}</div>;
  }
  if (!topic) {
    return <div className="p-6 text-mc-text-secondary">{loading ? 'Loading…' : 'Topic not found.'}</div>;
  }

  return (
    <div className="px-6 py-5 max-w-4xl">
      <header className="flex items-start justify-between mb-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-xl font-semibold text-mc-text">{topic.name}</h1>
            {topic.archived_at && (
              <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-sm bg-yellow-700/20 text-yellow-300 border border-yellow-500/30">
                Archived
              </span>
            )}
          </div>
          {topic.description && <p className="text-sm text-mc-text-secondary">{topic.description}</p>}
          {topic.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {topic.tags.map(t => (
                <span key={t} className="text-[10px] px-1.5 py-0.5 rounded-sm bg-mc-bg-tertiary text-mc-text-secondary border border-mc-border">{t}</span>
              ))}
            </div>
          )}
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
          {topic.archived_at ? (
            <button
              type="button"
              onClick={() => archive(false)}
              className="px-3 py-1.5 text-sm rounded-sm text-mc-text-secondary hover:bg-mc-bg-tertiary flex items-center gap-1.5 border border-mc-border"
            >
              <ArchiveRestore className="w-3.5 h-3.5" /> Unarchive
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmArchive(true)}
              className="px-3 py-1.5 text-sm rounded-sm text-mc-text-secondary hover:bg-mc-bg-tertiary flex items-center gap-1.5 border border-mc-border"
            >
              <Archive className="w-3.5 h-3.5" /> Archive
            </button>
          )}
          {!topic.archived_at && (
            <button
              type="button"
              onClick={() => setRunBriefOpen(true)}
              className="px-3 py-1.5 bg-mc-accent text-mc-bg rounded-sm text-sm font-medium hover:opacity-90 flex items-center gap-1.5"
            >
              <Zap className="w-3.5 h-3.5" /> Run a brief
            </button>
          )}
        </div>
      </header>

      <section>
        <h2 className="text-[11px] uppercase tracking-wider text-mc-text-secondary mb-2">Brief history</h2>
        {briefs.length === 0 ? (
          <p className="text-sm text-mc-text-secondary/70 italic">No briefs for this topic yet.</p>
        ) : (
          <ul className="space-y-2">
            {briefs.map(b => (
              <li key={b.id} className="border border-mc-border rounded-sm bg-mc-bg-secondary hover:bg-mc-bg-tertiary">
                <Link href={`/research/briefs/${b.id}`} className="flex items-center gap-3 px-3 py-2">
                  <FileText className="w-4 h-4 text-mc-text-secondary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-mc-text truncate">{b.title}</div>
                    <div className="text-[11px] text-mc-text-secondary mt-0.5">
                      {b.template} · {formatDistanceToNow(new Date(b.created_at), { addSuffix: true })}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <RunBriefDrawer
        open={runBriefOpen}
        onClose={() => setRunBriefOpen(false)}
        workspaceId={topic.workspace_id}
        topics={[{ id: topic.id, name: topic.name }]}
        defaultTopicId={topic.id}
        onLaunched={() => setRunBriefOpen(false)}
      />

      <ConfirmDialog
        open={confirmArchive}
        title="Archive topic?"
        body="The topic will be hidden from default lists. Briefs that reference it stay readable."
        confirmLabel="Archive"
        onConfirm={() => { setConfirmArchive(false); archive(true); }}
        onCancel={() => setConfirmArchive(false)}
      />
    </div>
  );
}
