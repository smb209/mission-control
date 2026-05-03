'use client';

/**
 * NoteCountBadge — small live-updating badge showing the count of
 * notes for a task or initiative. Drops onto cards in list views.
 *
 * Phase D #3 in specs/scope-keyed-sessions.md §3.6. Wired into the
 * task list card rendering in this PR; can be reused on
 * initiative cards / convoy cards in follow-ups.
 */

import { useAgentNotes } from '@/hooks/useAgentNotes';

interface NoteCountBadgeProps {
  task_id?: string;
  initiative_id?: string;
  /** When >0, only count notes at or above this importance. */
  min_importance?: 0 | 1 | 2;
}

export function NoteCountBadge(props: NoteCountBadgeProps) {
  const { notes } = useAgentNotes({
    task_id: props.task_id,
    initiative_id: props.initiative_id,
    min_importance: props.min_importance,
    limit: 50,
  });
  if (!notes.length) return null;
  const high = notes.filter((n) => n.importance === 2).length;
  return (
    <span
      className={
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ' +
        (high > 0
          ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300'
          : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300')
      }
      data-testid="note-count-badge"
      title={`${notes.length} note${notes.length === 1 ? '' : 's'}${high ? ` (${high} high importance)` : ''}`}
    >
      📝 {notes.length}
      {high > 0 && <span aria-label="high importance">🚩</span>}
    </span>
  );
}
