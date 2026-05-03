/**
 * Database access for the agent_notes spine.
 *
 * Notes are the observability + briefing-input + audit-trail spine of
 * the scope-keyed-sessions architecture. See
 * specs/scope-keyed-sessions.md §3 for the full design.
 *
 * Functions in this module are pure DB shape; the MCP-tool layer wraps
 * them with auth + tracing + SSE broadcast. Callers outside MCP (e.g.
 * the briefing builder, or the Notes Rail React hook) use the same
 * functions directly.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';

// ─── Types ──────────────────────────────────────────────────────────

export type NoteKind =
  | 'discovery'
  | 'blocker'
  | 'uncertainty'
  | 'decision'
  | 'observation'
  | 'question'
  | 'breadcrumb';

export const NOTE_KINDS: ReadonlyArray<NoteKind> = [
  'discovery',
  'blocker',
  'uncertainty',
  'decision',
  'observation',
  'question',
  'breadcrumb',
];

export type NoteImportance = 0 | 1 | 2;

export interface AgentNote {
  id: string;
  workspace_id: string;
  agent_id: string | null;
  task_id: string | null;
  initiative_id: string | null;
  scope_key: string;
  role: string;
  run_group_id: string;
  kind: NoteKind;
  audience: string | null;
  body: string;
  /** Stored as JSON string in the DB. Parsed lazily by callers. */
  attached_files: string | null;
  importance: NoteImportance;
  /** Stored as JSON string array. */
  consumed_by_stages: string | null;
  archived_at: string | null;
  archived_reason: string | null;
  created_at: string;
}

/** Maximum body length per note (matches the role-soul guidance). */
export const NOTE_BODY_MAX = 3000;

// ─── Create ─────────────────────────────────────────────────────────

export interface CreateNoteInput {
  workspace_id: string;
  agent_id: string | null;
  task_id?: string | null;
  initiative_id?: string | null;
  scope_key: string;
  role: string;
  run_group_id: string;
  kind: NoteKind;
  audience?: string | null;
  body: string;
  attached_files?: ReadonlyArray<string> | null;
  importance?: NoteImportance;
}

export class AgentNoteValidationError extends Error {
  constructor(public reason: string) {
    super(`agent_note validation: ${reason}`);
    this.name = 'AgentNoteValidationError';
  }
}

export function createNote(input: CreateNoteInput): AgentNote {
  if (!input.body || !input.body.trim()) {
    throw new AgentNoteValidationError('body is required');
  }
  if (input.body.length > NOTE_BODY_MAX) {
    throw new AgentNoteValidationError(`body exceeds ${NOTE_BODY_MAX} chars`);
  }
  if (!NOTE_KINDS.includes(input.kind)) {
    throw new AgentNoteValidationError(`invalid kind: ${input.kind}`);
  }
  if (!input.scope_key) {
    throw new AgentNoteValidationError('scope_key is required');
  }
  if (!input.role) {
    throw new AgentNoteValidationError('role is required');
  }
  if (!input.run_group_id) {
    throw new AgentNoteValidationError('run_group_id is required');
  }

  const id = uuidv4();
  const importance = input.importance ?? 0;
  const attachedJson =
    input.attached_files && input.attached_files.length > 0
      ? JSON.stringify(input.attached_files)
      : null;

  run(
    `INSERT INTO agent_notes (
       id, workspace_id, agent_id, task_id, initiative_id,
       scope_key, role, run_group_id, kind, audience, body,
       attached_files, importance, consumed_by_stages,
       archived_at, archived_reason, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, datetime('now'))`,
    [
      id,
      input.workspace_id,
      input.agent_id,
      input.task_id ?? null,
      input.initiative_id ?? null,
      input.scope_key,
      input.role,
      input.run_group_id,
      input.kind,
      input.audience ?? null,
      input.body,
      attachedJson,
      importance,
    ],
  );

  const row = queryOne<AgentNote>(`SELECT * FROM agent_notes WHERE id = ?`, [id]);
  if (!row) throw new Error('createNote: insert succeeded but row missing');
  return row;
}

// ─── Read ───────────────────────────────────────────────────────────

export interface ListNotesFilter {
  workspace_id?: string;
  task_id?: string;
  initiative_id?: string;
  audience?: string;
  /** When set, restrict to these note kinds. */
  kinds?: ReadonlyArray<NoteKind>;
  /** When set, exclude notes whose `consumed_by_stages` already includes this stage. */
  not_consumed_by_stage?: string;
  /** When set, include archived notes; default excludes them. */
  include_archived?: boolean;
  /** When set, restrict to notes at or above this importance level. */
  min_importance?: NoteImportance;
  /** When set, restrict to notes from this scope_key. */
  scope_key?: string;
  /** When set, restrict to notes from this run group. */
  run_group_id?: string;
  /** Default 50. Capped at 200. */
  limit?: number;
  /** Default `created_at ASC`. Pass 'desc' for reverse-chronological. */
  order?: 'asc' | 'desc';
}

export function listNotes(filter: ListNotesFilter): AgentNote[] {
  const where: string[] = [];
  const args: unknown[] = [];

  if (filter.workspace_id) {
    where.push('workspace_id = ?');
    args.push(filter.workspace_id);
  }
  if (filter.task_id) {
    where.push('task_id = ?');
    args.push(filter.task_id);
  }
  if (filter.initiative_id) {
    where.push('initiative_id = ?');
    args.push(filter.initiative_id);
  }
  if (filter.audience) {
    // Audience filter accepts NULL (anyone) OR an exact match. Callers
    // who want strict-only-this-audience should filter the result.
    where.push("(audience IS NULL OR audience = ?)");
    args.push(filter.audience);
  }
  if (filter.scope_key) {
    where.push('scope_key = ?');
    args.push(filter.scope_key);
  }
  if (filter.run_group_id) {
    where.push('run_group_id = ?');
    args.push(filter.run_group_id);
  }
  if (filter.kinds && filter.kinds.length > 0) {
    const placeholders = filter.kinds.map(() => '?').join(',');
    where.push(`kind IN (${placeholders})`);
    args.push(...filter.kinds);
  }
  if (filter.not_consumed_by_stage) {
    // SQLite has no native JSON containment in older builds; we do a
    // string match on the JSON text. The stage slug is wrapped in
    // quotes inside the JSON array, so the substring is unambiguous
    // unless a stage slug is itself a substring of another. Stage
    // slugs are role names, so collisions are unlikely; if they
    // appear, callers can post-filter.
    where.push(`(consumed_by_stages IS NULL OR consumed_by_stages NOT LIKE ?)`);
    args.push(`%"${filter.not_consumed_by_stage}"%`);
  }
  if (!filter.include_archived) {
    where.push('archived_at IS NULL');
  }
  if (filter.min_importance != null) {
    where.push('importance >= ?');
    args.push(filter.min_importance);
  }

  const order = filter.order === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.min(filter.limit ?? 50, 200);

  const sql =
    `SELECT * FROM agent_notes` +
    (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY importance DESC, created_at ${order}` +
    ` LIMIT ${limit}`;

  return queryAll<AgentNote>(sql, args);
}

export function getNote(noteId: string): AgentNote | null {
  return queryOne<AgentNote>(`SELECT * FROM agent_notes WHERE id = ?`, [noteId]) ?? null;
}

// ─── Mutate ─────────────────────────────────────────────────────────

/**
 * Append `stageSlug` to the `consumed_by_stages` JSON array. Idempotent —
 * already-present stages are not duplicated. No-op if the note doesn't
 * exist.
 */
export function markNoteConsumed(noteId: string, stageSlug: string): AgentNote | null {
  const existing = getNote(noteId);
  if (!existing) return null;

  const current: string[] = existing.consumed_by_stages
    ? safeParseStringArray(existing.consumed_by_stages)
    : [];
  if (current.includes(stageSlug)) return existing;
  current.push(stageSlug);

  run(
    `UPDATE agent_notes SET consumed_by_stages = ? WHERE id = ?`,
    [JSON.stringify(current), noteId],
  );
  return getNote(noteId);
}

/**
 * Soft-archive a note. The row stays for audit; future briefings and
 * un-filtered listings hide it. Idempotent.
 */
export function archiveNote(noteId: string, reason: string | null): AgentNote | null {
  const existing = getNote(noteId);
  if (!existing) return null;
  if (existing.archived_at) return existing;

  run(
    `UPDATE agent_notes
        SET archived_at = datetime('now'),
            archived_reason = ?
      WHERE id = ?`,
    [reason ?? null, noteId],
  );
  return getNote(noteId);
}

// ─── Helpers ────────────────────────────────────────────────────────

function safeParseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string')) return parsed;
  } catch {
    /* fall through */
  }
  return [];
}

/**
 * Convenience: parse the JSON `attached_files` field into a string[].
 * Returns [] for null/invalid.
 */
export function parseAttachedFiles(note: Pick<AgentNote, 'attached_files'>): string[] {
  if (!note.attached_files) return [];
  return safeParseStringArray(note.attached_files);
}

/**
 * Convenience: parse the JSON `consumed_by_stages` field into a string[].
 * Returns [] for null/invalid.
 */
export function parseConsumedStages(note: Pick<AgentNote, 'consumed_by_stages'>): string[] {
  if (!note.consumed_by_stages) return [];
  return safeParseStringArray(note.consumed_by_stages);
}
