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
  template: BriefTemplate;
  title: string;
  prompt: string;
  requested_by: string;
  result_md: string | null;
  citations: BriefCitation[];
  error_md: string | null;
  created_at: string;
  updated_at: string;
}

interface BriefRow {
  id: string;
  workspace_id: string;
  agent_run_id: string;
  topic_id: string | null;
  template: BriefTemplate;
  title: string;
  prompt: string;
  requested_by: string;
  result_md: string | null;
  citations_json: string | null;
  error_md: string | null;
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
    template: row.template,
    title: row.title,
    prompt: row.prompt,
    requested_by: row.requested_by,
    result_md: row.result_md,
    citations: parseCitations(row.citations_json),
    error_md: row.error_md,
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
         id, workspace_id, agent_run_id, topic_id, template,
         title, prompt, requested_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      [
        id,
        input.workspace_id,
        agent_run.id,
        input.topic_id ?? null,
        input.template,
        input.title.trim(),
        input.prompt,
        input.requested_by ?? 'manual',
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
  limit?: number;
}

export function listBriefs(workspaceId: string, opts: ListBriefsOptions = {}): Brief[] {
  const where: string[] = ['workspace_id = ?'];
  const params: unknown[] = [workspaceId];
  if (opts.topic_id) {
    where.push('topic_id = ?');
    params.push(opts.topic_id);
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

export function setBriefError(id: string, errorMd: string): Brief | null {
  const current = getBrief(id);
  if (!current) return null;
  run(
    `UPDATE briefs SET error_md = ?, updated_at = datetime('now') WHERE id = ?`,
    [errorMd, id],
  );
  return getBrief(id);
}
