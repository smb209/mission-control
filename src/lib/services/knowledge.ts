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

export interface SearchKnowledgeInput {
  /** `null` for operator flows — skip authorization. */
  actingAgentId: string | null;
  workspaceId: string;
  /** Free-text query; tokens are matched against title/content/tags. */
  query: string;
  /** Cap on returned matches. Defaults to 5. */
  limit?: number;
}

export interface SearchKnowledgeResult {
  matches: KnowledgeEntry[];
  /** Convenience flag so the caller can print a "no relevant knowledge" line without checking length. */
  none: boolean;
}

// Common English stopwords that would otherwise produce spurious hits
// against knowledge titles/content (e.g. "for" matching "PEO beats EOR
// for small teams" when the real query was about Docker caching).
const SEARCH_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was',
  'but', 'not', 'you', 'your', 'our', 'out', 'can', 'how', 'why',
  'what', 'when', 'where', 'who', 'will', 'would', 'should', 'have',
  'has', 'had', 'them', 'they', 'their', 'some', 'any', 'all', 'about',
  'into', 'over', 'than', 'then', 'been', 'also', 'its',
]);

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

/**
 * Search workspace knowledge by free-text query. Used by the
 * `request_knowledge` MCP tool so agents can pull targeted lessons on
 * demand instead of having unfiltered lessons auto-injected into every
 * dispatch.
 *
 * Scoring is deliberately simple: each whitespace-separated query token
 * contributes to a per-row hit count (title hit = 3, tag hit = 2, content
 * hit = 1). Results are ordered by `score DESC, confidence DESC,
 * created_at DESC`. Rows with zero hits are excluded. Stopwords aren't
 * filtered — agents are expected to ask substantive questions.
 */
export function searchKnowledge(input: SearchKnowledgeInput): SearchKnowledgeResult {
  const { actingAgentId, workspaceId, query, limit = 5 } = input;

  if (actingAgentId) {
    assertAgentActive(actingAgentId);
  }

  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map(t => t.replace(/[^\p{L}\p{N}_-]+/gu, ''))
    .filter(t => t.length >= 3 && !SEARCH_STOPWORDS.has(t));

  if (tokens.length === 0) {
    return { matches: [], none: true };
  }

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, workspace_id, task_id, category, title, content, tags, confidence,
              created_by_agent_id, created_at
         FROM knowledge_entries
        WHERE workspace_id = ?`,
    )
    .all(workspaceId) as KnowledgeRow[];

  const scored = rows
    .map(row => {
      const title = row.title.toLowerCase();
      const content = row.content.toLowerCase();
      const tags = row.tags ? (JSON.parse(row.tags) as string[]).join(' ').toLowerCase() : '';
      let score = 0;
      for (const t of tokens) {
        if (title.includes(t)) score += 3;
        if (tags.includes(t)) score += 2;
        if (content.includes(t)) score += 1;
      }
      return { row, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.row.confidence !== a.row.confidence) return b.row.confidence - a.row.confidence;
      return b.row.created_at.localeCompare(a.row.created_at);
    })
    .slice(0, limit);

  const matches: KnowledgeEntry[] = scored.map(({ row }) => ({
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
  }));

  return { matches, none: matches.length === 0 };
}
