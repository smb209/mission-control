/**
 * Agent→task authorization.
 *
 * Today's agent-facing HTTP routes (/api/tasks/:id/*, /api/agents/:id/mail)
 * only gate on the global MC_API_TOKEN bearer. Any agent with the token can
 * act on any task — register deliverables, log activities, transition
 * status, send mail as another agent. The blast radius is limited in
 * practice because agents get the token from the dispatch message for
 * their own task, but nothing enforces that at the route level.
 *
 * This module closes the gap: every state-changing route now calls
 * `assertAgentCanActOnTask(agentId, taskId, action)` and 403s if the agent
 * isn't assigned to the task, doesn't hold a role in task_roles, and
 * isn't the task's coordinator.
 *
 * The MCP server (PR 3) depends on this helper — MCP tools take agent_id
 * as an explicit arg and every call passes through here.
 *
 * Throws `AuthzError` with a machine-readable `code` so callers can map to
 * HTTP status (403) or MCP error responses uniformly.
 */

import { queryOne } from '@/lib/db';

export type AuthzAction =
  | 'read'
  | 'activity'
  | 'deliverable'
  | 'status'
  | 'fail'
  | 'checkpoint'
  | 'delegate';

export type AuthzErrorCode =
  | 'agent_not_found'
  | 'agent_disabled'
  | 'task_not_found'
  | 'workspace_mismatch'
  | 'agent_not_on_task'
  | 'agent_not_coordinator';

export class AuthzError extends Error {
  constructor(
    public readonly code: AuthzErrorCode,
    message: string,
    public readonly context: { agentId?: string; taskId?: string; action?: AuthzAction } = {},
  ) {
    super(message);
    this.name = 'AuthzError';
  }
}

interface AgentRow {
  id: string;
  workspace_id: string | null;
  is_active: number | null;
  role: string | null;
}

interface TaskRow {
  id: string;
  workspace_id: string | null;
  assigned_agent_id: string | null;
  created_by_agent_id: string | null;
}

function loadAgent(agentId: string): AgentRow {
  const row = queryOne<AgentRow>(
    `SELECT id, workspace_id, is_active, role FROM agents WHERE id = ?`,
    [agentId],
  );
  if (!row) {
    throw new AuthzError('agent_not_found', `agent not found: ${agentId}`, { agentId });
  }
  // COALESCE — existing rows predate the column; treat NULL as active=1 (the
  // column default for new rows), matching the behavior in
  // src/lib/agent-resolver.ts and elsewhere.
  if (row.is_active === 0) {
    throw new AuthzError('agent_disabled', `agent is disabled: ${agentId}`, { agentId });
  }
  return row;
}

function loadTask(taskId: string): TaskRow {
  const row = queryOne<TaskRow>(
    `SELECT id, workspace_id, assigned_agent_id, created_by_agent_id
       FROM tasks WHERE id = ?`,
    [taskId],
  );
  if (!row) {
    throw new AuthzError('task_not_found', `task not found: ${taskId}`, { taskId });
  }
  return row;
}

function hasTaskRole(taskId: string, agentId: string, role?: string): boolean {
  const sql = role
    ? `SELECT 1 AS ok FROM task_roles WHERE task_id = ? AND agent_id = ? AND lower(role) = lower(?)`
    : `SELECT 1 AS ok FROM task_roles WHERE task_id = ? AND agent_id = ?`;
  const params: unknown[] = role ? [taskId, agentId, role] : [taskId, agentId];
  return Boolean(queryOne<{ ok: number }>(sql, params));
}

/**
 * Assert that the agent is real and active. Use this for flows that aren't
 * tied to a specific task (e.g. `POST /api/agents/:id/mail` without a
 * task_id — just validates the sender).
 */
export function assertAgentActive(agentId: string): void {
  loadAgent(agentId); // throws on missing/disabled
}

/**
 * Assert that the given agent can perform the given action on the given
 * task. Throws `AuthzError` on any failure; returns void on success.
 *
 * Rules:
 *   - Agent exists and is not disabled
 *   - Task exists
 *   - Agent and task share workspace_id
 *   - For 'delegate': agent must be the task's coordinator (either
 *     task_roles[role='coordinator'], or the task's assigned_agent_id with
 *     an agent.role of 'coordinator')
 *   - For all other actions: agent is the task's assigned_agent_id, OR has
 *     any row in task_roles for this task, OR is the task's
 *     created_by_agent_id (coordinators who dispatched the task)
 */
export function assertAgentCanActOnTask(
  agentId: string,
  taskId: string,
  action: AuthzAction,
): void {
  const agent = loadAgent(agentId);
  const task = loadTask(taskId);

  // Workspace isolation — defaults to 'default' per schema, so non-null.
  if ((agent.workspace_id ?? 'default') !== (task.workspace_id ?? 'default')) {
    throw new AuthzError(
      'workspace_mismatch',
      `agent ${agentId} (workspace=${agent.workspace_id}) cannot act on task ${taskId} (workspace=${task.workspace_id})`,
      { agentId, taskId, action },
    );
  }

  const isAssigned = task.assigned_agent_id === agentId;
  const isCreator = task.created_by_agent_id === agentId;
  const hasAnyRole = hasTaskRole(taskId, agentId);
  const hasCoordinatorRole = hasTaskRole(taskId, agentId, 'coordinator');
  const isCoordinator =
    hasCoordinatorRole ||
    isCreator ||
    (isAssigned && (agent.role || '').toLowerCase() === 'coordinator');

  if (action === 'delegate') {
    if (!isCoordinator) {
      throw new AuthzError(
        'agent_not_coordinator',
        `agent ${agentId} is not the coordinator for task ${taskId}`,
        { agentId, taskId, action },
      );
    }
    return;
  }

  if (!isAssigned && !hasAnyRole && !isCoordinator) {
    throw new AuthzError(
      'agent_not_on_task',
      `agent ${agentId} is not on task ${taskId}`,
      { agentId, taskId, action },
    );
  }
}
