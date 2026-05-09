/**
 * briefs DAO.
 *
 * Schema added in migration 075. Each brief owns a 1:1 agent_run row
 * for execution state. Phase 1 ships only the `general_brief`
 * template; the CHECK constraint at the schema level will need to
 * widen as new templates land.
 *
 * createBriefWithRun() is the canonical entry point — it inserts the
 * agent_run + brief in a single transaction so a brief never exists
 * without its envelope. Setters mirror the agent_run lifecycle for
 * the brief-side fields (result_md / citations_json / error_md);
 * status itself lives on agent_runs.
 *
 * See specs/research-area.md "Brief" + specs/research-area-build-plan.md §2.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run, transaction } from '@/lib/db';
import {
  createAgentRun,
  type AgentRun,
  type AgentRunSourceKind,
} from './agent-runs';

export type BriefTemplate = 'general_brief';

export interface BriefCitation {
  url: string;
  title?: string;
  accessed_at?: string;
  snippet?: string;
}

export interface Brief {
  id: string;
  workspace_id: string;
  agent_run_id: string;
  topic_id: string | null;
  initiative_id: string | null;
  template: BriefTemplate;
  title: string;
  prompt: string;
  requested_by: string;
  result_md: string | null;
  citations: BriefCitation[];
  error_md: string | null;
  summary: string | null;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
}

interface BriefRow {
  id: string;
  workspace_id: string;
  agent_run_id: string;
  topic_id: string | null;
  initiative_id: string | null;
  template: BriefTemplate;
  title: string;
  prompt: string;
  requested_by: string;
  source_ref: string | null;
  result_md: string | null;
  citations_json: string | null;
  error_md: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export class BriefValidationError extends Error {
  constructor(public reason: string) {
    super(`brief validation: ${reason}`);
    this.name = 'BriefValidationError';
  }
}

function parseCitations(json: string | null): BriefCitation[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is BriefCitation => !!c && typeof c.url === 'string');
  } catch {
    return [];
  }
}

function rowToBrief(row: BriefRow): Brief {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    agent_run_id: row.agent_run_id,
    topic_id: row.topic_id,
    initiative_id: row.initiative_id,
    template: row.template,
    title: row.title,
    prompt: row.prompt,
    requested_by: row.requested_by,
    result_md: row.result_md,
    citations: parseCitations(row.citations_json),
    error_md: row.error_md,
    summary: row.summary,
    source_ref: row.source_ref,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface CreateBriefInput {
  workspace_id: string;
  template: BriefTemplate;
  title: string;
  prompt: string;
  topic_id?: string | null;
  initiative_id?: string | null;
  requested_by?: string;
  source_kind?: AgentRunSourceKind;
  source_ref?: string | null;
}

export interface CreateBriefResult {
  brief: Brief;
  agent_run: AgentRun;
}

export function createBriefWithRun(input: CreateBriefInput): CreateBriefResult {
  if (!input.workspace_id.trim()) throw new BriefValidationError('workspace_id is required');
  if (!input.title.trim()) throw new BriefValidationError('title is required');
  if (!input.prompt.trim()) throw new BriefValidationError('prompt is required');

  // Validate topic belongs to the same workspace if provided. Done
  // outside the transaction so the FK error message is meaningful;
  // the transaction below would otherwise fail with a generic FK
  // violation that hides the workspace-mismatch reason.
  if (input.topic_id) {
    const topic = queryOne<{ workspace_id: string; archived_at: string | null }>(
      `SELECT workspace_id, archived_at FROM topics WHERE id = ?`,
      [input.topic_id],
    );
    if (!topic) {
      throw new BriefValidationError(`topic ${input.topic_id} does not exist`);
    }
    if (topic.workspace_id !== input.workspace_id) {
      throw new BriefValidationError(
        `topic ${input.topic_id} belongs to a different workspace`,
      );
    }
    if (topic.archived_at) {
      throw new BriefValidationError(`topic ${input.topic_id} is archived`);
    }
  }

  return transaction(() => {
    const agent_run = createAgentRun({
      workspace_id: input.workspace_id,
      kind: 'brief',
      source_kind: input.source_kind,
      source_ref: input.source_ref,
    });

    const id = uuidv4();
    run(
      `INSERT INTO briefs (
         id, workspace_id, agent_run_id, topic_id, initiative_id, template,
         title, prompt, requested_by, source_ref, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [
        id,
        input.workspace_id,
        agent_run.id,
        input.topic_id ?? null,
        input.initiative_id ?? null,
        input.template,
        input.title.trim(),
        input.prompt,
        input.requested_by ?? 'manual',
        input.source_ref ?? null,
      ],
    );
    const row = queryOne<BriefRow>(`SELECT * FROM briefs WHERE id = ?`, [id]);
    if (!row) throw new Error('createBriefWithRun: insert succeeded but row missing');
    return { brief: rowToBrief(row), agent_run };
  });
}

export function getBrief(id: string): Brief | null {
  const row = queryOne<BriefRow>(`SELECT * FROM briefs WHERE id = ?`, [id]);
  return row ? rowToBrief(row) : null;
}

export function getBriefByAgentRun(agentRunId: string): Brief | null {
  const row = queryOne<BriefRow>(`SELECT * FROM briefs WHERE agent_run_id = ?`, [agentRunId]);
  return row ? rowToBrief(row) : null;
}

export interface ListBriefsOptions {
  topic_id?: string;
  initiative_id?: string;
  limit?: number;
}

export function listBriefs(workspaceId: string, opts: ListBriefsOptions = {}): Brief[] {
  const where: string[] = ['workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (opts.topic_id) {
    where.push('topic_id = ?');
    params.push(opts.topic_id);
  }
  if (opts.initiative_id) {
    where.push('initiative_id = ?');
    params.push(opts.initiative_id);
  }
  const limit = Math.min(opts.limit ?? 100, 500);
  const rows = queryAll<BriefRow>(
    // rowid DESC tiebreaks created_at when two rows land in the same
    // SQLite-second (datetime('now') has 1s resolution; rapid inserts
    // collide). rowid increases monotonically per insert.
    `SELECT * FROM briefs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`,
    params,
  );
  return rows.map(rowToBrief);
}

export interface SetBriefResultInput {
  result_md: string;
  citations?: BriefCitation[];
}

export function setBriefResult(id: string, input: SetBriefResultInput): Brief | null {
  const current = getBrief(id);
  if (!current) return null;
  run(
    `UPDATE briefs SET
       result_md = ?,
       citations_json = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
    [input.result_md, JSON.stringify(input.citations ?? []), id],
  );
  return getBrief(id);
}

/**
 * Hard-delete a brief and its 1:1 agent_run.
 *
 * Schema is `briefs.agent_run_id REFERENCES agent_runs(id) ON DELETE
 * CASCADE` — so deleting the agent_run cascades into the brief. We
 * delete the agent_run as the entry point (the brief goes with it
 * via cascade) so we don't leave orphan run rows behind.
 *
 * No status guard — operators can delete a brief in any state,
 * including mid-flight. The orchestrator's writes after deletion
 * (setBriefResult / markComplete / setBriefError) all do
 * `getBrief(id)` first and silently no-op when the row is gone.
 *
 * Returns `true` when the brief existed (and was removed), `false`
 * when the id was unknown.
 */
export function deleteBrief(id: string): boolean {
  const brief = getBrief(id);
  if (!brief) return false;
  // Cascade: deleting the agent_run row removes the brief too.
  run(`DELETE FROM agent_runs WHERE id = ?`, [brief.agent_run_id]);
  return true;
}

export function setBriefError(id: string, errorMd: string): Brief | null {
  const current = getBrief(id);
  if (!current) return null;
  run(
    `UPDATE briefs SET error_md = ?, updated_at = datetime('now') WHERE id = ?`,
    [errorMd, id],
  );
  return getBrief(id);
}

/**
 * Persist the one-line `summary` for a brief. Computed at completion
 * time (slice 3 — see specs/initiative-research-loop-build-plan.md D1)
 * from the first sentence of `result_md`, capped at 160 chars.
 */
export function setBriefSummary(id: string, summary: string): Brief | null {
  const current = getBrief(id);
  if (!current) return null;
  run(
    `UPDATE briefs SET summary = ?, updated_at = datetime('now') WHERE id = ?`,
    [summary, id],
  );
  return getBrief(id);
}

/**
 * Walk `briefs.source_ref` (`brief:<id>`) backwards to the chain root
 * — the original brief that hasn't itself been re-run. Used by the
 * auto-note rerun-replace path so we soft-delete the prior auto-note
 * regardless of how many reruns deep we are.
 *
 * Cycle-safe via a 32-step ceiling — that's more reruns than will ever
 * realistically happen on a single brief; if we hit the ceiling we
 * just return the latest seen id rather than loop forever.
 */
export function findBriefChainRoot(id: string): string {
  const SEEN_LIMIT = 32;
  const seen = new Set<string>();
  let cursor = id;
  for (let i = 0; i < SEEN_LIMIT; i++) {
    if (seen.has(cursor)) return cursor;
    seen.add(cursor);
    const row = queryOne<{ source_ref: string | null }>(
      `SELECT source_ref FROM briefs WHERE id = ?`,
      [cursor],
    );
    if (!row || !row.source_ref) return cursor;
    const m = /^brief:(.+)$/.exec(row.source_ref);
    if (!m) return cursor;
    cursor = m[1];
  }
  return cursor;
}
