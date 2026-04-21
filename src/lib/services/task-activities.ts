/**
 * Task activities service.
 *
 * Shared by the HTTP route and (PR 3) the MCP `log_activity` tool. Handles
 * agent-task authorization, DB insert + JOIN read-back, and SSE broadcast.
 * HTTP-wrapper concerns (request parsing, debug-event logging of inbound
 * transport) stay in the route.
 *
 * Throws `AuthzError` on authorization failure.
 */

import { getDb } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { assertAgentCanActOnTask } from '@/lib/authz/agent-task';
import type { TaskActivity } from '@/lib/types';

export type ActivityKind =
  | 'spawned'
  | 'updated'
  | 'completed'
  | 'file_created'
  | 'status_changed';

export interface LogActivityInput {
  taskId: string;
  /** `null` for operator-initiated activity (UI). */
  actingAgentId: string | null;
  activityType: ActivityKind;
  message: string;
  /** Opaque JSON-stringified payload for per-event metadata. */
  metadata?: string;
}

export function logActivity(input: LogActivityInput): TaskActivity {
  const { taskId, actingAgentId, activityType, message, metadata } = input;

  if (actingAgentId) {
    assertAgentCanActOnTask(actingAgentId, taskId, 'activity');
  }

  const db = getDb();
  const id = crypto.randomUUID();

  db.prepare(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, taskId, actingAgentId || null, activityType, message, metadata ?? null);

  const row = db
    .prepare(
      `SELECT a.*, ag.id as agent_id, ag.name as agent_name, ag.avatar_emoji as agent_avatar_emoji
         FROM task_activities a
         LEFT JOIN agents ag ON a.agent_id = ag.id
         WHERE a.id = ?`,
    )
    .get(id) as {
    id: string;
    task_id: string;
    agent_id: string | null;
    agent_name: string | null;
    agent_avatar_emoji: string | null;
    activity_type: ActivityKind;
    message: string;
    metadata: string | null;
    created_at: string;
  };

  const result: TaskActivity = {
    id: row.id,
    task_id: row.task_id,
    agent_id: row.agent_id ?? undefined,
    activity_type: row.activity_type,
    message: row.message,
    metadata: row.metadata ?? undefined,
    created_at: row.created_at,
    agent: row.agent_id
      ? {
          id: row.agent_id,
          name: row.agent_name ?? '',
          avatar_emoji: row.agent_avatar_emoji ?? '',
          role: '',
          status: 'working' as const,
          is_master: false,
          workspace_id: 'default',
          source: 'local' as const,
          description: '',
          created_at: '',
          updated_at: '',
        }
      : undefined,
  };

  broadcast({ type: 'activity_logged', payload: result });

  return result;
}
