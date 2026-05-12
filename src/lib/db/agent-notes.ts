/**
 * Database access for the agent_notes spine.
 *
 * Notes are the observability + briefing-input + audit-trail spine of
 * the scope-keyed-sessions architecture. See
 * docs/reference/scope-keyed-sessions.md §3 for the full design.
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
  | 'breadcrumb'
  | 'audit_manifest'
  | 'audit_proposal'
  | 'audit_synthesis'
  | 'audit_verdict';

export const NOTE_KINDS: ReadonlyArray<NoteKind> = [
  'discovery',
  'blocker',
  'uncertainty',
  'decision',
  'observation',
  'question',
  'breadcrumb',
  'audit_manifest',
  'audit_proposal',
  'audit_synthesis',
  'audit_verdict',
];

/**
 * Note kinds emitted by the subtree-audit pipeline (see
 * docs/archive/subtree-audit-proposals-spec.md) plus the narrow-audit verdict
 * row introduced by docs/archive/audit-action-recommended.md. These are
 * excluded by default from cross-audit reads (briefing builder, Notes
 * Rail, default `listNotes` calls) so audit artifacts don't bleed into
 * unrelated agent context. The proposal queue UI and the audit
 * orchestrator itself read them explicitly via the `kinds` filter.
 */
export const AUDIT_NOTE_KINDS: ReadonlyArray<NoteKind> = [
  'audit_manifest',
  'audit_proposal',
  'audit_synthesis',
  'audit_verdict',
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
  /** Stored as JSON string array. Holds pm_proposals.id values created
   *  from this note via the Ask-PM-from-notes flow. Multiple ids are
   *  possible because the operator can re-ask on the same note. */
  pm_proposal_ids: string | null;
  /** Upstream entity that produced this note. E.g. {kind:'brief', ref:<id>}
   *  for auto-notes written when an initiative-scoped brief completes.
   *  See docs/archive/initiative-research-loop-build-plan.md §D2. */
  source_kind: string | null;
  source_ref: string | null;
}

/** Maximum body length per note. Sized to fit a full multi-section
 *  audit observation (6 sections w/ file paths + commit shas) without
 *  forcing the agent into a truncate-and-retry loop, which empirically
 *  causes it to drop other required fields across attempts. The prompt
 *  still asks for tight notes; this is a ceiling, not a target. */
export const NOTE_BODY_MAX = 8000;

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
  /** Optional upstream entity producing this note. Both fields must be
   *  set together or both null. Used by `findNoteBySource` for dedupe
   *  paths (e.g. brief-rerun replaces prior auto-note). */
  source_kind?: string | null;
  source_ref?: string | null;
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
       archived_at, archived_reason, created_at,
       source_kind, source_ref
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, datetime('now'), ?, ?)`,
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
      input.source_kind ?? null,
      input.source_ref ?? null,
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
  /**
   * When set, exclude these note kinds. Applied AFTER `kinds` (i.e. the
   * intersection: kept iff `kind ∈ kinds` and `kind ∉ exclude_kinds`).
   * Used by cross-audit readers (briefing assembly, Notes Rail) to
   * filter out audit-pipeline artifacts (`audit_manifest`,
   * `audit_proposal`, `audit_synthesis`) without enumerating the
   * allow-list each time. See `AUDIT_NOTE_KINDS` and
   * docs/archive/subtree-audit-proposals-spec.md §4.1.
   */
  exclude_kinds?: ReadonlyArray<NoteKind>;
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
  if (filter.exclude_kinds && filter.exclude_kinds.length > 0) {
    const placeholders = filter.exclude_kinds.map(() => '?').join(',');
    where.push(`kind NOT IN (${placeholders})`);
    args.push(...filter.exclude_kinds);
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

/**
 * Look up notes by their upstream source. Returns non-archived rows
 * by default (set `include_archived` to fetch the full history). Used
 * by the brief-rerun auto-note path: when a rerun completes, find the
 * non-archived auto-note for the chain root and soft-delete it before
 * inserting the new one.
 */
export function findNotesBySource(
  source_kind: string,
  source_ref: string,
  opts: { include_archived?: boolean } = {},
): AgentNote[] {
  const where: string[] = ['source_kind = ?', 'source_ref = ?'];
  const args: unknown[] = [source_kind, source_ref];
  if (!opts.include_archived) {
    where.push('archived_at IS NULL');
  }
  return queryAll<AgentNote>(
    `SELECT * FROM agent_notes WHERE ${where.join(' AND ')} ORDER BY created_at ASC`,
    args,
  );
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

/**
 * Un-archive a previously archived note. Clears `archived_at` and
 * `archived_reason`. No-op if the note isn't archived. Returns null if
 * the note doesn't exist.
 */
export function restoreNote(noteId: string): AgentNote | null {
  const existing = getNote(noteId);
  if (!existing) return null;
  if (!existing.archived_at) return existing;

  run(
    `UPDATE agent_notes
        SET archived_at = NULL,
            archived_reason = NULL
      WHERE id = ?`,
    [noteId],
  );
  return getNote(noteId);
}

export class AgentNoteNotArchivedError extends Error {
  constructor(public id: string) {
    super(`agent_note ${id} must be archived before hard-delete`);
    this.name = 'AgentNoteNotArchivedError';
  }
}

/**
 * Permanently delete a note. The note MUST be archived first — this is the
 * "empty the trash" verb, not a one-shot delete. Throws
 * `AgentNoteNotArchivedError` if the note isn't archived. Returns true
 * if a row was deleted, false if the note didn't exist at all.
 *
 * The two-step intent (archive, then delete-from-trash) protects against
 * accidental loss on agent-generated content. Project convention is to
 * gate this behind ConfirmDialog at the UI layer too.
 */
export function hardDeleteNote(noteId: string): boolean {
  const existing = getNote(noteId);
  if (!existing) return false;
  if (!existing.archived_at) {
    throw new AgentNoteNotArchivedError(noteId);
  }
  run(`DELETE FROM agent_notes WHERE id = ?`, [noteId]);
  return true;
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

/**
 * Convenience: parse the JSON `pm_proposal_ids` field into a string[].
 * Returns [] for null/invalid.
 */
export function parsePmProposalIds(
  note: Pick<AgentNote, 'pm_proposal_ids'>,
): string[] {
  if (!note.pm_proposal_ids) return [];
  return safeParseStringArray(note.pm_proposal_ids);
}

/**
 * Append a `pm_proposals.id` to the note's `pm_proposal_ids` JSON
 * array. Idempotent — already-present ids aren't duplicated. Returns
 * the updated note, or null if the note doesn't exist.
 *
 * Used by the Ask-PM-from-notes route after a successful PM dispatch
 * so the UI can render a persistent "View proposal" link.
 */
export function appendNoteProposalId(
  noteId: string,
  proposalId: string,
): AgentNote | null {
  const existing = getNote(noteId);
  if (!existing) return null;
  const current = parsePmProposalIds(existing);
  if (current.includes(proposalId)) return existing;
  current.push(proposalId);
  run(
    `UPDATE agent_notes SET pm_proposal_ids = ? WHERE id = ?`,
    [JSON.stringify(current), noteId],
  );
  return getNote(noteId);
}
