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
 *
 * Audit-actions PR 4: archive / restore / delete actions on every card,
 * "Show archived" toggle that re-fetches with include_archived=true so
 * the trash view is just the same rail with archived rows un-hidden.
 * Hard-delete is gated by a ConfirmDialog (no native window.confirm
 * per project convention).
 */

import { useMemo, useState } from 'react';
import { Archive } from 'lucide-react';
import {
  useAgentNotes,
  type AgentNoteKind,
  type AgentNoteRecord,
  type UseAgentNotesOptions,
} from '@/hooks/useAgentNotes';
import { NoteCard } from './NoteCard';
import { ConfirmDialog } from '@/components/ConfirmDialog';

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
  const [showArchived, setShowArchived] = useState(false);
  // Note pending hard-delete confirmation. Two-step intent: archive
  // first (reversible), then delete from the trash view.
  const [pendingDelete, setPendingDelete] = useState<AgentNoteRecord | null>(null);

  const opts: UseAgentNotesOptions = useMemo(
    () => ({
      task_id: props.task_id,
      initiative_id: props.initiative_id,
      workspace_id: props.workspace_id,
      kinds: props.kinds,
      min_importance: props.min_importance,
      limit: props.limit ?? 100,
      include_archived: showArchived,
    }),
    [
      props.task_id,
      props.initiative_id,
      props.workspace_id,
      props.kinds,
      props.min_importance,
      props.limit,
      showArchived,
    ],
  );

  const { notes, loading, error, refresh } = useAgentNotes(opts);

  // Split active vs archived so we can render archived ones at the
  // bottom of the list under their own header — keeps the active set
  // clean for normal review.
  const activeNotes = useMemo(() => notes.filter((n) => !n.archived_at), [notes]);
  const archivedNotes = useMemo(() => notes.filter((n) => n.archived_at), [notes]);

  const archivedCount = archivedNotes.length;

  const archive = async (note: AgentNoteRecord) => {
    try {
      const res = await fetch(`/api/agent-notes/${encodeURIComponent(note.id)}/archive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // SSE will update the list via agent_note_archived; refetch as
      // belt-and-braces in case the stream is dropped.
      refresh();
    } catch (err) {
      console.error('[NotesRail] archive failed', err);
    }
  };

  const restore = async (note: AgentNoteRecord) => {
    try {
      const res = await fetch(`/api/agent-notes/${encodeURIComponent(note.id)}/restore`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      refresh();
    } catch (err) {
      console.error('[NotesRail] restore failed', err);
    }
  };

  const hardDelete = async (note: AgentNoteRecord) => {
    try {
      const res = await fetch(`/api/agent-notes/${encodeURIComponent(note.id)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      refresh();
    } catch (err) {
      console.error('[NotesRail] delete failed', err);
    }
  };

  const groups = useMemo(() => groupByRunGroup(activeNotes), [activeNotes]);
  const archivedGroups = useMemo(() => groupByRunGroup(archivedNotes), [archivedNotes]);

  return (
    <section
      className="flex flex-col gap-2"
      data-testid="notes-rail"
      data-scope-task={props.task_id ?? ''}
      data-scope-initiative={props.initiative_id ?? ''}
    >
      <header className="flex items-center justify-between gap-2 text-xs uppercase tracking-wide opacity-70">
        <span>{props.title ?? 'Notes'} · {activeNotes.length}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded normal-case tracking-normal ${
              showArchived
                ? 'bg-black/10 dark:bg-white/10'
                : 'hover:bg-black/5 dark:hover:bg-white/5'
            }`}
            aria-pressed={showArchived}
            aria-label={showArchived ? 'Hide archived notes' : 'Show archived notes'}
            title={showArchived ? 'Hide archived (trash)' : 'Show archived (trash)'}
          >
            <Archive className="w-3 h-3" />
            {showArchived ? 'Hide archived' : 'Trash'}
            {!showArchived && archivedCount > 0 && (
              <span className="opacity-70">({archivedCount})</span>
            )}
          </button>
          <button
            type="button"
            onClick={refresh}
            className="px-1.5 py-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5"
            aria-label="Refresh notes"
          >
            ↻
          </button>
        </div>
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
          No notes yet. Agents leave notes as they work — they&apos;ll appear here live.
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
            <NoteCard
              key={n.id}
              note={n}
              onArchive={archive}
            />
          ))}
        </div>
      ))}

      {showArchived && archivedNotes.length > 0 && (
        <div className="mt-3 pt-3 border-t border-mc-border/60 flex flex-col gap-1.5">
          <p className="text-[11px] uppercase tracking-wide opacity-60 flex items-center gap-1">
            <Archive className="w-3 h-3" /> Archived · {archivedNotes.length}
          </p>
          {Array.from(archivedGroups.entries()).map(([runGroupId, groupNotes]) => (
            <div key={runGroupId} className="flex flex-col gap-1.5" data-run-group={runGroupId}>
              {groupNotes.map((n) => (
                <NoteCard
                  key={n.id}
                  note={n}
                  onRestore={restore}
                  onDelete={(note) => setPendingDelete(note)}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this note permanently?"
        body={
          <div className="space-y-2 text-sm text-mc-text">
            <p>
              This is the empty-the-trash step. The note will be removed from
              the database — there is no undo.
            </p>
            {pendingDelete && (
              <blockquote className="border-l-2 border-mc-border pl-2 italic opacity-80 text-xs">
                {pendingDelete.body.slice(0, 240)}
                {pendingDelete.body.length > 240 ? '…' : ''}
              </blockquote>
            )}
          </div>
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (pendingDelete) {
            void hardDelete(pendingDelete);
          }
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </section>
  );
}
