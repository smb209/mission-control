/**
 * Shared planning-persistence helpers.
 *
 * The poll endpoint writes a spec+agents atomically when a plan envelope
 * arrives (without dispatching — that's the user's explicit lock action).
 * The lock endpoint re-runs the persistence pass (to pick up any tweak
 * edits), assigns the first agent, and fires dispatch. Both paths share the
 * agent-resolution and transaction logic, hence this module.
 */

import { getDb, queryAll, queryOne, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { findAgentForRole, verifyAgentInWorkspace } from '@/lib/agent-resolver';
import { internalDispatch } from '@/lib/internal-dispatch';
import type { PlanEnvelope } from '@/lib/planning-envelope';
import type { Task } from '@/lib/types';

export function persistPlannerPlan(taskId: string, plan: PlanEnvelope): {
  firstAgentId: string | null;
  resolvedAgentRows: Array<{ id: string; role: string; name: string }>;
} {
  const db = getDb();
  let firstAgentId: string | null = null;
  const resolvedAgentRows: Array<{ id: string; role: string; name: string }> = [];

  const transaction = db.transaction(() => {
    const allowDynamicAgents = process.env.ALLOW_DYNAMIC_AGENTS !== 'false';

    if (allowDynamicAgents && plan.agents && plan.agents.length > 0) {
      const task = db
        .prepare('SELECT workspace_id FROM tasks WHERE id = ?')
        .get(taskId) as { workspace_id: string } | undefined;
      const masterAgent = task
        ? (db
            .prepare(
              `SELECT session_key_prefix FROM agents WHERE is_master = 1 AND workspace_id = ? ORDER BY created_at ASC LIMIT 1`
            )
            .get(task.workspace_id) as { session_key_prefix?: string } | undefined)
        : undefined;

      const sessionKeyPrefix = masterAgent?.session_key_prefix || null;

      const insertAgent = db.prepare(`
        INSERT INTO agents (id, workspace_id, name, role, description, avatar_emoji, status, soul_md, session_key_prefix, created_at, updated_at)
        VALUES (?, (SELECT workspace_id FROM tasks WHERE id = ?), ?, ?, ?, ?, 'standby', ?, ?, datetime('now'), datetime('now'))
      `);

      const workspaceId = task?.workspace_id;

      for (const agent of plan.agents) {
        let resolvedId: string | null = null;

        if (workspaceId && agent.agent_id) {
          const verified = verifyAgentInWorkspace(workspaceId, agent.agent_id);
          if (verified) {
            resolvedId = verified.id;
          } else {
            console.warn(
              `[Planning Persist] Planner returned unknown agent_id ${agent.agent_id} for role "${agent.role}" — falling back to role match`
            );
          }
        }

        if (!resolvedId && workspaceId && agent.role) {
          const existing = findAgentForRole(workspaceId, agent.role);
          if (existing) {
            resolvedId = existing.id;
          }
        }

        if (!resolvedId) {
          resolvedId = crypto.randomUUID();
          insertAgent.run(
            resolvedId,
            taskId,
            agent.name,
            agent.role,
            agent.instructions || '',
            agent.avatar_emoji || '🤖',
            agent.soul_md || '',
            sessionKeyPrefix
          );
        }

        if (!firstAgentId) firstAgentId = resolvedId;
        resolvedAgentRows.push({ id: resolvedId, role: agent.role, name: agent.name });
      }
    }

    // Store spec + agents; move phase to 'confirm'. No dispatch, no status
    // change — that's only lockAndDispatch's job.
    db.prepare(`
      UPDATE tasks
      SET planning_spec = ?,
          planning_agents = ?,
          planning_phase = 'confirm',
          planning_dispatch_error = NULL,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(plan.spec), JSON.stringify(plan.agents), taskId);

    return firstAgentId;
  });

  firstAgentId = transaction();
  return { firstAgentId, resolvedAgentRows };
}

export async function lockAndDispatch(taskId: string): Promise<{
  firstAgentId: string | null;
  dispatchError: string | null;
}> {
  const db = getDb();
  let dispatchError: string | null = null;

  const task = queryOne<{
    workspace_id: string;
    planning_spec: string | null;
    planning_agents: string | null;
  }>(
    `SELECT workspace_id, planning_spec, planning_agents FROM tasks WHERE id = ?`,
    [taskId]
  );
  if (!task || !task.planning_spec) {
    return { firstAgentId: null, dispatchError: 'No locked plan available to dispatch.' };
  }

  const plan: PlanEnvelope = {
    kind: 'plan',
    spec: JSON.parse(task.planning_spec),
    agents: task.planning_agents ? JSON.parse(task.planning_agents) : [],
  };
  const { firstAgentId: resolvedFirst } = persistPlannerPlan(taskId, plan);
  let firstAgentId: string | null = resolvedFirst;

  if (firstAgentId) {
    const defaultMaster = queryOne<{ id: string }>(
      `SELECT id FROM agents WHERE is_master = 1 AND workspace_id = ? ORDER BY created_at ASC LIMIT 1`,
      [task.workspace_id]
    );
    const otherOrchestrators = queryAll<{ id: string; name: string }>(
      `SELECT id, name FROM agents WHERE is_master = 1 AND id != ? AND workspace_id = ? AND status != 'offline'`,
      [defaultMaster?.id ?? '', task.workspace_id]
    );
    if (otherOrchestrators.length > 0) {
      dispatchError = `Cannot auto-dispatch: ${otherOrchestrators.length} other orchestrator(s) available in workspace`;
      console.warn(
        `[Planning Lock] ${dispatchError}:`,
        otherOrchestrators.map((o) => o.name).join(', ')
      );
      firstAgentId = null;
    }
  }

  if (firstAgentId) {
    db.prepare(`
      UPDATE tasks
      SET planning_complete = 1,
          planning_phase = 'complete',
          assigned_agent_id = ?,
          status = 'assigned',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(firstAgentId, taskId);

    const result = await internalDispatch(taskId, { caller: 'planning-lock' });
    if (!result.success) {
      dispatchError = result.error || 'Dispatch failed (no cause surfaced)';
    }

    if (dispatchError) {
      run(
        `UPDATE tasks SET planning_dispatch_error = ?, status_reason = ?, updated_at = datetime('now') WHERE id = ?`,
        [dispatchError, 'Dispatch failed: ' + dispatchError, taskId]
      );
    }
  } else {
    run(
      `UPDATE tasks SET planning_complete = 1, planning_phase = 'complete', status = 'inbox', updated_at = datetime('now') WHERE id = ?`,
      [taskId]
    );
  }

  const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (updatedTask) {
    broadcast({ type: 'task_updated', payload: updatedTask });
  }

  return { firstAgentId, dispatchError };
}
