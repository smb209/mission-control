'use client';

/**
 * NotesRail — a scoped, live-updating list of agent_notes for a
 * task or initiative. Wires `useAgentNotes` to the SSE channel.
 *
 * Used by the task detail panel (filtered by task_id) and the
 * initiative detail panel (filtered by initiative_id with
 * include_child_tasks rollup).
 *
 * Phase D of specs/scope-keyed-sessions.md §3.6.
 */

import { useMemo } from 'react';
import {
  useAgentNotes,
  type AgentNoteKind,
  type AgentNoteRecord,
  type UseAgentNotesOptions,
} from '@/hooks/useAgentNotes';
import { NoteCard } from './NoteCard';

interface NotesRailProps {
  /** When set, scope is "this task". */
  task_id?: string;
  /** When set with include_child_tasks=true, rollup view across child tasks. */
  initiative_id?: string;
  /** Workspace fallback for the rollup query. */
  workspace_id?: string;
  /** Initiative panels pass true to fetch notes from descendant tasks. */
  include_child_tasks?: boolean;
  /** Filter chip overrides (live-updating). */
  kinds?: ReadonlyArray<AgentNoteKind>;
  min_importance?: 0 | 1 | 2;
  /** Hard cap on rendered rows. */
  limit?: number;
  /** Optional title override (default 'Notes'). */
  title?: string;
}

function groupByRunGroup(notes: AgentNoteRecord[]): Map<string, AgentNoteRecord[]> {
  const out = new Map<string, AgentNoteRecord[]>();
  for (const n of notes) {
    const arr = out.get(n.run_group_id) ?? [];
    arr.push(n);
    out.set(n.run_group_id, arr);
  }
  return out;
}

export function NotesRail(props: NotesRailProps) {
  const opts: UseAgentNotesOptions = useMemo(
    () => ({
      task_id: props.task_id,
      initiative_id: props.initiative_id,
      workspace_id: props.workspace_id,
      kinds: props.kinds,
      min_importance: props.min_importance,
      limit: props.limit ?? 100,
    }),
    [
      props.task_id,
      props.initiative_id,
      props.workspace_id,
      props.kinds,
      props.min_importance,
      props.limit,
    ],
  );

  const { notes, loading, error, refresh } = useAgentNotes(opts);

  const groups = useMemo(() => groupByRunGroup(notes), [notes]);

  return (
    <section
      className="flex flex-col gap-2"
      data-testid="notes-rail"
      data-scope-task={props.task_id ?? ''}
      data-scope-initiative={props.initiative_id ?? ''}
    >
      <header className="flex items-center justify-between gap-2 text-xs uppercase tracking-wide opacity-70">
        <span>{props.title ?? 'Notes'} · {notes.length}</span>
        <button
          type="button"
          onClick={refresh}
          className="px-1.5 py-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5"
          aria-label="Refresh notes"
        >
          ↻
        </button>
      </header>

      {error && (
        <p className="text-xs text-rose-700 dark:text-rose-300">
          Failed to load notes: {error.message}
        </p>
      )}
      {loading && notes.length === 0 && (
        <p className="text-xs opacity-60">Loading…</p>
      )}
      {!loading && notes.length === 0 && (
        <p className="text-xs opacity-60">
          No notes yet. Agents leave notes as they work — they'll appear here live.
        </p>
      )}

      {Array.from(groups.entries()).map(([runGroupId, groupNotes]) => (
        <div key={runGroupId} className="flex flex-col gap-1.5" data-run-group={runGroupId}>
          {groupNotes.length > 1 && (
            <p className="text-[11px] opacity-60 font-mono">
              run {runGroupId.slice(0, 8)} · {groupNotes.length} notes
            </p>
          )}
          {groupNotes.map((n) => (
            <NoteCard key={n.id} note={n} />
          ))}
        </div>
      ))}
    </section>
  );
}
