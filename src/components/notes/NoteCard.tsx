'use client';

/**
 * Single agent_notes record rendered as a card. Used by NotesRail and
 * the workspace /feed page. See specs/scope-keyed-sessions.md §3.6.
 */

import type { AgentNoteRecord, AgentNoteKind } from '@/hooks/useAgentNotes';

const KIND_COLOR: Record<AgentNoteKind, string> = {
  discovery: 'bg-emerald-50 border-emerald-200 text-emerald-900',
  blocker: 'bg-rose-50 border-rose-300 text-rose-900',
  uncertainty: 'bg-amber-50 border-amber-200 text-amber-900',
  decision: 'bg-indigo-50 border-indigo-200 text-indigo-900',
  observation: 'bg-slate-50 border-slate-200 text-slate-700',
  question: 'bg-sky-50 border-sky-200 text-sky-900',
  breadcrumb: 'bg-stone-50 border-stone-200 text-stone-700',
};

const KIND_DARK: Record<AgentNoteKind, string> = {
  discovery: 'dark:bg-emerald-950/30 dark:border-emerald-800 dark:text-emerald-200',
  blocker: 'dark:bg-rose-950/30 dark:border-rose-800 dark:text-rose-200',
  uncertainty: 'dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-200',
  decision: 'dark:bg-indigo-950/30 dark:border-indigo-800 dark:text-indigo-200',
  observation: 'dark:bg-slate-950/30 dark:border-slate-700 dark:text-slate-300',
  question: 'dark:bg-sky-950/30 dark:border-sky-800 dark:text-sky-200',
  breadcrumb: 'dark:bg-stone-950/30 dark:border-stone-700 dark:text-stone-300',
};

const KIND_LABEL: Record<AgentNoteKind, string> = {
  discovery: '🔍 discovery',
  blocker: '⛔ blocker',
  uncertainty: '❓ uncertainty',
  decision: '⚖️ decision',
  observation: '👁 observation',
  question: '💬 question',
  breadcrumb: '🍞 breadcrumb',
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

interface NoteCardProps {
  note: AgentNoteRecord;
}

export function NoteCard({ note }: NoteCardProps) {
  const kindClasses = `${KIND_COLOR[note.kind]} ${KIND_DARK[note.kind]}`;
  const importancePin =
    note.importance === 2
      ? '🚩 '
      : note.importance === 1
        ? '🔔 '
        : '';

  return (
    <article
      className={`rounded-lg border ${kindClasses} px-3 py-2 text-sm space-y-1`}
      data-note-id={note.id}
      data-note-kind={note.kind}
    >
      <header className="flex items-center justify-between gap-2 text-xs opacity-80">
        <span className="font-medium">
          {importancePin}
          {KIND_LABEL[note.kind]} · {note.role}
        </span>
        <time dateTime={note.created_at} title={note.created_at}>
          {formatTime(note.created_at)}
        </time>
      </header>
      <p className="whitespace-pre-wrap leading-relaxed">{note.body}</p>
      {note.attached_files.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-1">
          {note.attached_files.map((f) => (
            <li
              key={f}
              className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/5"
            >
              {f}
            </li>
          ))}
        </ul>
      )}
      {note.audience && (
        <p className="text-[11px] opacity-70">→ for {note.audience}</p>
      )}
    </article>
  );
}
