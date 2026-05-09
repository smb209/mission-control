/**
 * research_suggestions DAO.
 *
 * Schema added in migration 076. Stores PM-generated candidate
 * topics and briefs for operator review. Lifecycle:
 *
 *   pending → accepted (with accepted_as_id)
 *           → rejected
 *           → dismissed
 *
 * `dismissed` is distinct from `rejected`: rejected = "the PM was
 * wrong, don't suggest this again"; dismissed = "I closed the
 * picker without acting." Future PM runs can use rejected as
 * negative training; dismissed is just noise.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';

export type SuggestionKind = 'topic' | 'brief' | 'recurring_brief';
export type SuggestionStatus = 'pending' | 'accepted' | 'rejected' | 'dismissed';

export interface TopicSuggestionPayload {
  name: string;
  description: string;
  tags: string[];
  default_brief_template?: string | null;
}

export interface BriefSuggestionPayload {
  title: string;
  prompt: string;
  topic_id?: string | null;
  /** When set, the accepted brief will be dispatched with this
   *  `initiative_id`. Slice 2 of the initiative research loop. */
  initiative_id?: string | null;
  template: 'general_brief';
}

/** Reserved — not generated yet (phase-2 schedules). */
export interface RecurringBriefSuggestionPayload {
  title: string;
  prompt: string;
  topic_id?: string | null;
  template: 'general_brief';
  cadence: string;
}

export type SuggestionPayload =
  | { kind: 'topic'; payload: TopicSuggestionPayload }
  | { kind: 'brief'; payload: BriefSuggestionPayload }
  | { kind: 'recurring_brief'; payload: RecurringBriefSuggestionPayload };

export interface ResearchSuggestion {
  id: string;
  workspace_id: string;
  kind: SuggestionKind;
  payload: TopicSuggestionPayload | BriefSuggestionPayload | RecurringBriefSuggestionPayload;
  rationale: string | null;
  status: SuggestionStatus;
  source_run_id: string | null;
  accepted_as_id: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SuggestionRow {
  id: string;
  workspace_id: string;
  kind: SuggestionKind;
  payload_json: string;
  rationale: string | null;
  status: SuggestionStatus;
  source_run_id: string | null;
  accepted_as_id: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export class SuggestionValidationError extends Error {
  constructor(public reason: string) {
    super(`research_suggestion validation: ${reason}`);
    this.name = 'SuggestionValidationError';
  }
}

function rowToSuggestion(row: SuggestionRow): ResearchSuggestion {
  let payload: ResearchSuggestion['payload'];
  try {
    payload = JSON.parse(row.payload_json) as ResearchSuggestion['payload'];
  } catch {
    // Corrupt payload: surface as empty payload of the right shape so
    // callers don't crash; the operator can dismiss.
    payload = row.kind === 'topic'
      ? { name: '(corrupt payload)', description: '', tags: [] }
      : { title: '(corrupt payload)', prompt: '', template: 'general_brief' as const };
  }
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    kind: row.kind,
    payload,
    rationale: row.rationale,
    status: row.status,
    source_run_id: row.source_run_id,
    accepted_as_id: row.accepted_as_id,
    decided_at: row.decided_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface CreateSuggestionInput {
  workspace_id: string;
  kind: SuggestionKind;
  payload: TopicSuggestionPayload | BriefSuggestionPayload | RecurringBriefSuggestionPayload;
  rationale?: string | null;
  source_run_id?: string | null;
}

export function createSuggestion(input: CreateSuggestionInput): ResearchSuggestion {
  if (!input.workspace_id.trim()) {
    throw new SuggestionValidationError('workspace_id is required');
  }
  // Cheap shape validation per kind.
  if (input.kind === 'topic') {
    const p = input.payload as TopicSuggestionPayload;
    if (!p.name?.trim()) throw new SuggestionValidationError('topic.name is required');
  } else {
    const p = input.payload as BriefSuggestionPayload | RecurringBriefSuggestionPayload;
    if (!p.title?.trim()) throw new SuggestionValidationError('brief.title is required');
    if (!p.prompt?.trim()) throw new SuggestionValidationError('brief.prompt is required');
  }

  const id = uuidv4();
  run(
    `INSERT INTO research_suggestions (
       id, workspace_id, kind, payload_json, rationale,
       source_run_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      id,
      input.workspace_id,
      input.kind,
      JSON.stringify(input.payload),
      input.rationale ?? null,
      input.source_run_id ?? null,
    ],
  );
  const row = queryOne<SuggestionRow>(
    `SELECT * FROM research_suggestions WHERE id = ?`,
    [id],
  );
  if (!row) throw new Error('createSuggestion: insert succeeded but row missing');
  return rowToSuggestion(row);
}

export function getSuggestion(id: string): ResearchSuggestion | null {
  const row = queryOne<SuggestionRow>(
    `SELECT * FROM research_suggestions WHERE id = ?`,
    [id],
  );
  return row ? rowToSuggestion(row) : null;
}

export interface ListSuggestionsOptions {
  kind?: SuggestionKind;
  status?: SuggestionStatus;
  source_run_id?: string;
  /** When set, restrict to suggestions whose `payload_json` references
   *  this initiative_id (matched as a JSON-string substring). Used by
   *  the InitiativeDetailView Research section so initiative-scoped
   *  suggestions don't pollute the workspace-wide queue. */
  initiative_id?: string;
  limit?: number;
}

export function listSuggestions(
  workspaceId: string,
  opts: ListSuggestionsOptions = {},
): ResearchSuggestion[] {
  const where: string[] = ['workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (opts.kind) {
    where.push('kind = ?');
    params.push(opts.kind);
  }
  if (opts.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  if (opts.source_run_id) {
    where.push('source_run_id = ?');
    params.push(opts.source_run_id);
  }
  if (opts.initiative_id) {
    // payload_json is JSON; match the value as a string. We accept the
    // false-positive risk on a payload that mentions the id elsewhere
    // (the JSON shape is small and dedicated, and the alternative is
    // a generated column / json_extract which adds schema cost).
    where.push(`payload_json LIKE ?`);
    params.push(`%"initiative_id":"${opts.initiative_id}"%`);
  }
  const limit = Math.min(opts.limit ?? 100, 500);
  const rows = queryAll<SuggestionRow>(
    `SELECT * FROM research_suggestions WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`,
    params,
  );
  return rows.map(rowToSuggestion);
}

export function markAccepted(id: string, acceptedAsId: string): ResearchSuggestion | null {
  const current = getSuggestion(id);
  if (!current) return null;
  if (current.status !== 'pending') return current;
  run(
    `UPDATE research_suggestions
        SET status = 'accepted',
            accepted_as_id = ?,
            decided_at = datetime('now'),
            updated_at = datetime('now')
      WHERE id = ?`,
    [acceptedAsId, id],
  );
  return getSuggestion(id);
}

export function markRejected(id: string): ResearchSuggestion | null {
  const current = getSuggestion(id);
  if (!current) return null;
  if (current.status !== 'pending') return current;
  run(
    `UPDATE research_suggestions
        SET status = 'rejected',
            decided_at = datetime('now'),
            updated_at = datetime('now')
      WHERE id = ?`,
    [id],
  );
  return getSuggestion(id);
}

export function markDismissed(id: string): ResearchSuggestion | null {
  const current = getSuggestion(id);
  if (!current) return null;
  if (current.status !== 'pending') return current;
  run(
    `UPDATE research_suggestions
        SET status = 'dismissed',
            decided_at = datetime('now'),
            updated_at = datetime('now')
      WHERE id = ?`,
    [id],
  );
  return getSuggestion(id);
}

/**
 * Dismiss every pending suggestion in a workspace for a given kind.
 * Used when the operator clicks "Suggest" again — old pending
 * candidates are no longer interesting.
 */
export function dismissPendingForWorkspaceKind(
  workspaceId: string,
  kind: SuggestionKind,
): number {
  const result = run(
    `UPDATE research_suggestions
        SET status = 'dismissed',
            decided_at = datetime('now'),
            updated_at = datetime('now')
      WHERE workspace_id = ? AND kind = ? AND status = 'pending'`,
    [workspaceId, kind],
  );
  return result.changes;
}
