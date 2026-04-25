'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Sparkles, ArrowUpRight } from 'lucide-react';
import { IdeaCard } from './IdeaCard';
import type { Idea } from '@/lib/types';

interface IdeasListProps {
  productId: string;
}

interface InitiativeMini {
  id: string;
  title: string;
}

export function IdeasList({ productId }: IdeasListProps) {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [initiatives, setInitiatives] = useState<Record<string, InitiativeMini>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (categoryFilter) params.set('category', categoryFilter);
      const res = await fetch(`/api/products/${productId}/ideas?${params}`);
      if (res.ok) setIdeas(await res.json());
    } catch (error) {
      console.error('Failed to load ideas:', error);
    } finally {
      setLoading(false);
    }
  }, [productId, statusFilter, categoryFilter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Cache initiative titles referenced by these ideas so the "→ Initiative"
  // link reads as a real title rather than a UUID. We only need workspace-
  // scoped data; pulling the unfiltered list keeps the call cheap and
  // matches how /initiatives renders.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/initiatives');
        if (!res.ok || cancelled) return;
        const rows: InitiativeMini[] = await res.json();
        const map: Record<string, InitiativeMini> = {};
        for (const r of rows) map[r.id] = r;
        setInitiatives(map);
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const promote = async (idea: Idea) => {
    setActionError(null);
    setBusyId(idea.id);
    try {
      const res = await fetch(`/api/ideas/${idea.id}/promote-to-initiative`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'story', copy_description: true }),
      });
      if (!res.ok && res.status !== 409) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Promote failed (${res.status})`);
      }
      // 409 means already promoted — we still want to refresh so the UI shows
      // the existing initiative link.
      await refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Promote failed');
    } finally {
      setBusyId(null);
    }
  };

  const statuses = ['', 'pending', 'approved', 'rejected', 'maybe', 'building', 'built', 'shipped'];
  const categories = ['', 'feature', 'improvement', 'ux', 'performance', 'integration', 'infrastructure', 'content', 'growth', 'monetization', 'operations', 'security'];

  return (
    <div className="space-y-4">
      <div className="flex gap-3 flex-wrap">
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="bg-mc-bg-tertiary border border-mc-border rounded-lg px-3 py-2 text-sm text-mc-text"
        >
          {statuses.map(s => (
            <option key={s} value={s}>{s || 'All statuses'}</option>
          ))}
        </select>
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          className="bg-mc-bg-tertiary border border-mc-border rounded-lg px-3 py-2 text-sm text-mc-text"
        >
          {categories.map(c => (
            <option key={c} value={c}>{c || 'All categories'}</option>
          ))}
        </select>
        <span className="text-sm text-mc-text-secondary self-center">{ideas.length} ideas</span>
      </div>

      {actionError && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
          {actionError}
        </div>
      )}

      {loading ? (
        <div className="text-mc-text-secondary animate-pulse py-8 text-center">Loading ideas...</div>
      ) : ideas.length === 0 ? (
        <div className="text-center py-12 text-mc-text-secondary">No ideas found</div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {ideas.map(idea => {
            const owningInitiative = idea.initiative_id ? initiatives[idea.initiative_id] : null;
            return (
              <div key={idea.id} className="space-y-2">
                <IdeaCard idea={idea} showActions={false} compact />
                {/* Roadmap path indicator: distinct from the autopilot
                    `task_id` path so operators can see which routes the
                    idea has taken. */}
                <div className="flex flex-wrap gap-2 px-1">
                  {idea.task_id && (
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20">
                      <ArrowUpRight className="w-3 h-3" />
                      Autopilot task
                    </span>
                  )}
                  {owningInitiative ? (
                    <Link
                      href={`/initiatives/${owningInitiative.id}`}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 hover:bg-emerald-500/20"
                    >
                      <Sparkles className="w-3 h-3" />
                      → Initiative: {owningInitiative.title}
                    </Link>
                  ) : (
                    <button
                      onClick={() => promote(idea)}
                      disabled={busyId === idea.id}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 hover:bg-emerald-500/20 disabled:opacity-50"
                      title="Create a planning-layer initiative from this idea (does not affect autopilot)"
                    >
                      <Sparkles className="w-3 h-3" />
                      {busyId === idea.id ? 'Promoting…' : 'Promote to initiative'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
