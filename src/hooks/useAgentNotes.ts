/**
 * useAgentNotes — subscribe to the agent_notes spine for a scoped view.
 *
 * Phase A scaffold. Consumers in Phase D (Notes Rail on task/initiative
 * detail panels, the workspace `/feed` page, card badges) plug in here.
 *
 * Pattern:
 *   const { notes, loading, error } = useAgentNotes({ task_id });
 *
 * The hook fetches initial state from `/api/agent-notes` then streams
 * incremental updates via SSE (`agent_note_created`,
 * `agent_note_consumed`, `agent_note_archived`). Filters are applied
 * client-side to incoming events so the same SSE channel can drive
 * many filtered views.
 *
 * NOTE: Phase A opens its own EventSource. If we end up with many
 * concurrent consumers we'll refactor to a shared subscriber pattern
 * (see useSSE for the global pattern). For Phase A this is the stub
 * and is intentionally simple.
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SSEEvent } from '@/lib/types';

export type AgentNoteKind =
  | 'discovery'
  | 'blocker'
  | 'uncertainty'
  | 'decision'
  | 'observation'
  | 'question'
  | 'breadcrumb';

export interface AgentNoteRecord {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  task_id: string | null;
  initiative_id: string | null;
  scope_key: string;
  role: string;
  run_group_id: string;
  kind: AgentNoteKind;
  audience: string | null;
  body: string;
  attached_files: string[];
  importance: 0 | 1 | 2;
  consumed_by_stages?: string[];
  archived_at: string | null;
  created_at: string;
}

export interface UseAgentNotesOptions {
  workspace_id?: string;
  task_id?: string;
  initiative_id?: string;
  audience?: string;
  kinds?: ReadonlyArray<AgentNoteKind>;
  min_importance?: 0 | 1 | 2;
  include_archived?: boolean;
  limit?: number;
  /** When false, skip the SSE subscription (useful in tests). Default true. */
  subscribe?: boolean;
}

export interface UseAgentNotesResult {
  notes: AgentNoteRecord[];
  loading: boolean;
  error: Error | null;
  /** Re-fetch from the server, replacing the in-memory list. */
  refresh: () => void;
}

function buildQueryString(opts: UseAgentNotesOptions): string {
  const params = new URLSearchParams();
  if (opts.workspace_id) params.set('workspace_id', opts.workspace_id);
  if (opts.task_id) params.set('task_id', opts.task_id);
  if (opts.initiative_id) params.set('initiative_id', opts.initiative_id);
  if (opts.audience) params.set('audience', opts.audience);
  if (opts.min_importance != null) params.set('min_importance', String(opts.min_importance));
  if (opts.include_archived) params.set('include_archived', 'true');
  if (opts.limit) params.set('limit', String(opts.limit));
  for (const k of opts.kinds ?? []) params.append('kind', k);
  return params.toString();
}

function noteMatchesFilter(note: AgentNoteRecord, opts: UseAgentNotesOptions): boolean {
  if (opts.workspace_id && note.workspace_id !== opts.workspace_id) return false;
  if (opts.task_id && note.task_id !== opts.task_id) return false;
  if (opts.initiative_id && note.initiative_id !== opts.initiative_id) return false;
  if (opts.audience && note.audience != null && note.audience !== opts.audience) return false;
  if (opts.kinds && opts.kinds.length > 0 && !opts.kinds.includes(note.kind)) return false;
  if (opts.min_importance != null && note.importance < opts.min_importance) return false;
  if (!opts.include_archived && note.archived_at) return false;
  return true;
}

export function useAgentNotes(opts: UseAgentNotesOptions): UseAgentNotesResult {
  const [notes, setNotes] = useState<AgentNoteRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  // Bump to force a refetch.
  const [refreshTick, setRefreshTick] = useState(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const queryKey = useMemo(() => buildQueryString(opts), [
    opts.workspace_id, opts.task_id, opts.initiative_id, opts.audience,
    opts.min_importance, opts.include_archived, opts.limit,
    JSON.stringify(opts.kinds ?? []),
  ]);

  // Initial fetch + refetches.
  useEffect(() => {
    let cancelled = false;
    if (!opts.workspace_id && !opts.task_id && !opts.initiative_id) {
      setNotes([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    fetch(`/api/agent-notes?${queryKey}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ notes: AgentNoteRecord[] }>;
      })
      .then((data) => {
        if (cancelled) return;
        setNotes(data.notes);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queryKey, refreshTick, opts.workspace_id, opts.task_id, opts.initiative_id]);

  // SSE subscription.
  useEffect(() => {
    if (opts.subscribe === false) return;
    if (!opts.workspace_id && !opts.task_id && !opts.initiative_id) return;

    const source = new EventSource('/api/events/stream');

    source.onmessage = (e) => {
      if (!e.data || e.data.startsWith(':')) return;
      let evt: SSEEvent;
      try {
        evt = JSON.parse(e.data) as SSEEvent;
      } catch {
        return;
      }

      const filter = optsRef.current;

      if (evt.type === 'agent_note_created') {
        const note = evt.payload as unknown as AgentNoteRecord;
        if (!noteMatchesFilter(note, filter)) return;
        setNotes((prev) => {
          if (prev.some((n) => n.id === note.id)) return prev;
          // Sort by importance DESC, created_at ASC (matches server default).
          const next = [...prev, note];
          next.sort((a, b) => {
            if (a.importance !== b.importance) return b.importance - a.importance;
            return a.created_at.localeCompare(b.created_at);
          });
          return next;
        });
      } else if (evt.type === 'agent_note_consumed') {
        const payload = evt.payload as unknown as {
          note_id: string;
          consumed_by_stages: string[];
        };
        setNotes((prev) =>
          prev.map((n) =>
            n.id === payload.note_id
              ? { ...n, consumed_by_stages: payload.consumed_by_stages }
              : n,
          ),
        );
      } else if (evt.type === 'agent_note_archived') {
        const payload = evt.payload as unknown as {
          note_id: string;
          archived_at: string;
        };
        setNotes((prev) => {
          if (filter.include_archived) {
            return prev.map((n) =>
              n.id === payload.note_id
                ? { ...n, archived_at: payload.archived_at }
                : n,
            );
          }
          return prev.filter((n) => n.id !== payload.note_id);
        });
      }
    };

    source.onerror = () => {
      // Silent — the global useSSE handles connection-state UX.
      // We just want our own incremental updates if/when the connection works.
    };

    return () => {
      source.close();
    };
  }, [opts.subscribe, opts.workspace_id, opts.task_id, opts.initiative_id]);

  return {
    notes,
    loading,
    error,
    refresh: () => setRefreshTick((n) => n + 1),
  };
}
