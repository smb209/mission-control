/**
 * topics DAO.
 *
 * Schema added in migration 075. Long-lived research interests,
 * workspace-scoped, soft-deleted via archived_at. tags is stored as a
 * JSON array string (`tags_json`); we round-trip to string[] at the
 * DAO boundary so callers don't deal with serialization.
 *
 * See docs/reference/research-area.md "Topic" + docs/archive/research-area-build-plan.md §2.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { pauseSchedulesForTopic } from './recurring-jobs';

export interface Topic {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  tags: string[];
  default_brief_template: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TopicRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  tags_json: string;
  default_brief_template: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export class TopicValidationError extends Error {
  constructor(public reason: string) {
    super(`topic validation: ${reason}`);
    this.name = 'TopicValidationError';
  }
}

function parseTags(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function rowToTopic(row: TopicRow): Topic {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    description: row.description,
    tags: parseTags(row.tags_json),
    default_brief_template: row.default_brief_template,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface CreateTopicInput {
  workspace_id: string;
  name: string;
  description?: string;
  tags?: string[];
  default_brief_template?: string | null;
}

export function createTopic(input: CreateTopicInput): Topic {
  if (!input.workspace_id.trim()) {
    throw new TopicValidationError('workspace_id is required');
  }
  if (!input.name.trim()) {
    throw new TopicValidationError('name is required');
  }
  const id = uuidv4();
  run(
    `INSERT INTO topics (
       id, workspace_id, name, description, tags_json,
       default_brief_template, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      id,
      input.workspace_id,
      input.name.trim(),
      input.description ?? '',
      JSON.stringify(input.tags ?? []),
      input.default_brief_template ?? null,
    ],
  );
  const row = queryOne<TopicRow>(`SELECT * FROM topics WHERE id = ?`, [id]);
  if (!row) throw new Error('createTopic: insert succeeded but row missing');
  return rowToTopic(row);
}

export function getTopic(id: string): Topic | null {
  const row = queryOne<TopicRow>(`SELECT * FROM topics WHERE id = ?`, [id]);
  return row ? rowToTopic(row) : null;
}

export interface ListTopicsOptions {
  includeArchived?: boolean;
}

export function listTopics(workspaceId: string, opts: ListTopicsOptions = {}): Topic[] {
  const where = opts.includeArchived
    ? 'workspace_id = ?'
    : 'workspace_id = ? AND archived_at IS NULL';
  const rows = queryAll<TopicRow>(
    // rowid DESC tiebreaks created_at — see briefs.ts listBriefs.
    `SELECT * FROM topics WHERE ${where} ORDER BY created_at DESC, rowid DESC`,
    [workspaceId],
  );
  return rows.map(rowToTopic);
}

export interface UpdateTopicInput {
  name?: string;
  description?: string;
  tags?: string[];
  default_brief_template?: string | null;
}

export function updateTopic(id: string, input: UpdateTopicInput): Topic | null {
  const current = getTopic(id);
  if (!current) return null;

  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.name !== undefined) {
    if (!input.name.trim()) {
      throw new TopicValidationError('name cannot be blank');
    }
    sets.push('name = ?');
    params.push(input.name.trim());
  }
  if (input.description !== undefined) {
    sets.push('description = ?');
    params.push(input.description);
  }
  if (input.tags !== undefined) {
    sets.push('tags_json = ?');
    params.push(JSON.stringify(input.tags));
  }
  if (input.default_brief_template !== undefined) {
    sets.push('default_brief_template = ?');
    params.push(input.default_brief_template);
  }
  if (sets.length === 0) return current;

  sets.push(`updated_at = datetime('now')`);
  params.push(id);
  run(`UPDATE topics SET ${sets.join(', ')} WHERE id = ?`, params);
  return getTopic(id);
}

export function archiveTopic(id: string): Topic | null {
  const current = getTopic(id);
  if (!current) return null;
  if (current.archived_at) return current;
  run(
    `UPDATE topics SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    [id],
  );
  // Phase 2: archiving a topic auto-pauses any active research
  // schedules attached to it so the scheduler stops dispatching
  // against a hidden topic. Resume is intentionally manual on
  // unarchive — the operator decides whether the schedule still
  // makes sense.
  pauseSchedulesForTopic(id);
  return getTopic(id);
}

export function unarchiveTopic(id: string): Topic | null {
  const current = getTopic(id);
  if (!current) return null;
  run(
    `UPDATE topics SET archived_at = NULL, updated_at = datetime('now') WHERE id = ?`,
    [id],
  );
  return getTopic(id);
}
