'use client';

/**
 * /workspace/[slug]/feed — workspace-wide live notes feed.
 *
 * Streams every `take_note` SSE event for the workspace. Filter chips
 * by kind / role / importance. The "follow this" pattern (drill into
 * a single task / job) is deferred — for Phase D this is the firehose.
 *
 * See specs/scope-keyed-sessions.md §3.6 #4.
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  useAgentNotes,
  type AgentNoteKind,
} from '@/hooks/useAgentNotes';
import { NoteCard } from '@/components/notes/NoteCard';
import type { Workspace } from '@/lib/types';

const ALL_KINDS: ReadonlyArray<AgentNoteKind> = [
  'discovery',
  'blocker',
  'uncertainty',
  'decision',
  'observation',
  'question',
  'breadcrumb',
];

const KIND_GLYPH: Record<AgentNoteKind, string> = {
  discovery: '🔍',
  blocker: '⛔',
  uncertainty: '❓',
  decision: '⚖️',
  observation: '👁',
  question: '💬',
  breadcrumb: '🍞',
};

export default function WorkspaceFeedPage() {
  const params = useParams();
  const slug = params.slug as string;
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [activeKinds, setActiveKinds] = useState<Set<AgentNoteKind>>(
    new Set(ALL_KINDS),
  );
  const [minImportance, setMinImportance] = useState<0 | 1 | 2>(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/workspaces/${slug}`);
        if (!res.ok) return;
        const ws = (await res.json()) as Workspace;
        if (!cancelled) setWorkspace(ws);
      } catch (err) {
        console.error('feed: failed to load workspace', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const kindsArray = useMemo(() => Array.from(activeKinds).sort(), [activeKinds]);

  const { notes, loading, error } = useAgentNotes({
    workspace_id: workspace?.id,
    kinds: kindsArray,
    min_importance: minImportance,
    limit: 200,
  });

  function toggleKind(k: AgentNoteKind) {
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-4">
      <header className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Live feed</h1>
          {workspace && (
            <p className="text-sm opacity-70">{workspace.name} — agents leave breadcrumbs as they work.</p>
          )}
        </div>
        <span className="text-xs opacity-60">{notes.length} notes</span>
      </header>

      <div className="flex flex-wrap gap-1.5">
        {ALL_KINDS.map((k) => {
          const active = activeKinds.has(k);
          return (
            <button
              key={k}
              type="button"
              onClick={() => toggleKind(k)}
              className={
                'px-2 py-0.5 text-xs rounded-full border transition-colors ' +
                (active
                  ? 'bg-slate-900 text-white border-slate-900 dark:bg-white dark:text-slate-900 dark:border-white'
                  : 'opacity-50 hover:opacity-100')
              }
              aria-pressed={active}
            >
              {KIND_GLYPH[k]} {k}
            </button>
          );
        })}
        <span className="mx-2 opacity-30">·</span>
        {[0, 1, 2].map((lvl) => (
          <button
            key={lvl}
            type="button"
            onClick={() => setMinImportance(lvl as 0 | 1 | 2)}
            className={
              'px-2 py-0.5 text-xs rounded-full border ' +
              (minImportance === lvl
                ? 'bg-amber-500 text-white border-amber-500'
                : 'opacity-50 hover:opacity-100')
            }
          >
            ≥ {lvl === 0 ? 'all' : lvl === 1 ? 'normal' : 'high'}
          </button>
        ))}
      </div>

      {error && (
        <p className="text-sm text-rose-700 dark:text-rose-300">
          Failed to load feed: {error.message}
        </p>
      )}
      {loading && notes.length === 0 && (
        <p className="text-sm opacity-60">Loading…</p>
      )}
      {!loading && notes.length === 0 && (
        <p className="text-sm opacity-60">
          No notes match the current filters. New notes from any agent will appear here live.
        </p>
      )}

      <div className="flex flex-col gap-2">
        {notes.map((n) => (
          <NoteCard key={n.id} note={n} />
        ))}
      </div>
    </div>
  );
}
