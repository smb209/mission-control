/**
 * Knowledge-entry service.
 *
 * Shared by the HTTP route (`/api/workspaces/:id/knowledge`) and the MCP
 * `save_knowledge` tool. Handles authorization, DB insert + read-back, and
 * tag-array normalization. HTTP-wrapper concerns (request parsing, response
 * shaping) stay in the route.
 *
 * Throws `AuthzError` on authorization failure.
 */

import { getDb } from '@/lib/db';
import { assertAgentActive, assertAgentCanActOnTask } from '@/lib/authz/agent-task';
import type { KnowledgeEntry } from '@/lib/types';

export type KnowledgeCategory = 'failure' | 'fix' | 'pattern' | 'checklist';

export interface SaveKnowledgeInput {
  /** `null` for operator flows — skip authorization. */
  actingAgentId: string | null;
  workspaceId: string;
  /** When set, the calling agent must be on this task. */
  taskId?: string;
  category: KnowledgeCategory;
  title: string;
  content: string;
  tags?: string[];
  /** 0..1 — caller already validated range. */
  confidence?: number;
}

interface KnowledgeRow {
  id: string;
  workspace_id: string;
  task_id: string | null;
  category: string;
  title: string;
  content: string;
  tags: string | null;
  confidence: number;
  created_by_agent_id: string | null;
  created_at: string;
}

export function saveKnowledge(input: SaveKnowledgeInput): KnowledgeEntry {
  const { actingAgentId, workspaceId, taskId, category, title, content, tags, confidence } =
    input;

  if (actingAgentId) {
    if (taskId) {
      // Task-scoped lesson: same gate as log_activity — must be on the task.
      assertAgentCanActOnTask(actingAgentId, taskId, 'activity');
    } else {
      // Workspace-level lesson (no task): just prove the agent is real
      // and active. Workspace isolation isn't enforced here because the
      // bearer-token transport is the trust boundary today; this mirrors
      // the stance of `send_mail` without task_id.
      assertAgentActive(actingAgentId);
    }
  }

  const db = getDb();
  const id = crypto.randomUUID();

  db.prepare(
    `INSERT INTO knowledge_entries
       (id, workspace_id, task_id, category, title, content, tags, confidence, created_by_agent_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    id,
    workspaceId,
    taskId ?? null,
    category,
    title,
    content,
    tags && tags.length ? JSON.stringify(tags) : null,
    confidence ?? 0.5,
    actingAgentId,
  );

  const row = db
    .prepare(`SELECT * FROM knowledge_entries WHERE id = ?`)
    .get(id) as KnowledgeRow;

  return {
    id: row.id,
    workspace_id: row.workspace_id,
    task_id: row.task_id ?? undefined,
    category: row.category,
    title: row.title,
    content: row.content,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
    confidence: row.confidence,
    created_by_agent_id: row.created_by_agent_id ?? undefined,
    created_at: row.created_at,
  };
}
