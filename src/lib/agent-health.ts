import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { internalDispatch } from '@/lib/internal-dispatch';
import { buildCheckpointContext } from '@/lib/checkpoint';
import { logTaskActivityThrottled } from '@/lib/activity-log';
import { scanStalledTasks } from '@/lib/stall-detection';
import { scanStalledCycles } from '@/lib/autopilot/stall-detection';
import type { Agent, AgentHealth, AgentHealthState, Task } from '@/lib/types';

// Heartbeat rows are throttled so the activity feed stays readable. 5 min
// is a good default: runHealthCheckCycle fires every 2 min (see the SSE
// stream route), so every 2nd-3rd pulse lands a row.
const HEARTBEAT_THROTTLE_SECONDS = 300;

const STALL_THRESHOLD_MINUTES = 5;
const STUCK_THRESHOLD_MINUTES = 15;
const AUTO_NUDGE_AFTER_STALLS = 3;

/**
 * Check health state for a single agent.
 */
export function checkAgentHealth(agentId: string): AgentHealthState {
  const agent = queryOne<Agent>('SELECT * FROM agents WHERE id = ?', [agentId]);
  if (!agent) return 'offline';
  if (agent.status === 'offline') return 'offline';

  // Find active task
  const activeTask = queryOne<Task>(
    `SELECT * FROM tasks WHERE assigned_agent_id = ? AND status IN ('assigned', 'in_progress', 'testing', 'verification') LIMIT 1`,
    [agentId]
  );

  if (!activeTask) return 'idle';

  // Check if OpenClaw session is still alive
  const session = queryOne<{ status: string }>(
    `SELECT status FROM openclaw_sessions WHERE agent_id = ? AND task_id = ? AND status = 'active' LIMIT 1`,
    [agentId, activeTask.id]
  );

  if (!session) {
    // Check for any active session (task might not be linked yet)
    const anySession = queryOne<{ status: string }>(
      `SELECT status FROM openclaw_sessions WHERE agent_id = ? AND status = 'active' LIMIT 1`,
      [agentId]
    );
    if (!anySession) return 'zombie';
  }

  // Check last REAL activity (exclude health check logs — they reset the clock and prevent stuck detection)
  const lastActivity = queryOne<{ created_at: string }>(
    `SELECT created_at FROM task_activities WHERE task_id = ? AND message NOT LIKE 'Agent health:%' ORDER BY created_at DESC LIMIT 1`,
    [activeTask.id]
  );

  if (lastActivity) {
    const minutesSince = (Date.now() - new Date(lastActivity.created_at).getTime()) / 60000;
    if (minutesSince > STUCK_THRESHOLD_MINUTES) return 'stuck';
    if (minutesSince > STALL_THRESHOLD_MINUTES) return 'stalled';
  } else {
    // No real activity at all — check how long the task has been in progress
    const taskAge = (Date.now() - new Date(activeTask.updated_at).getTime()) / 60000;
    if (taskAge > STUCK_THRESHOLD_MINUTES) return 'stuck';
    if (taskAge > STALL_THRESHOLD_MINUTES) return 'stalled';
  }

  return 'working';
}

/**
 * Run a full health check cycle across all agents with active tasks.
 */
export async function runHealthCheckCycle(): Promise<AgentHealth[]> {
  const activeAgents = queryAll<{ id: string }>(
    `SELECT DISTINCT assigned_agent_id as id FROM tasks WHERE status IN ('assigned', 'in_progress', 'testing', 'verification') AND assigned_agent_id IS NOT NULL`
  );

  // Also check agents that are in 'working' status but may have no tasks
  const workingAgents = queryAll<{ id: string }>(
    `SELECT id FROM agents WHERE status = 'working'`
  );

  const allAgentIds = Array.from(new Set([...activeAgents.map(a => a.id), ...workingAgents.map(a => a.id)]));
  const results: AgentHealth[] = [];
  const now = new Date().toISOString();

  for (const agentId of allAgentIds) {
    const healthState = checkAgentHealth(agentId);

    // Find current task for this agent
    const activeTask = queryOne<Task>(
      `SELECT * FROM tasks WHERE assigned_agent_id = ? AND status IN ('assigned', 'in_progress', 'testing', 'verification') LIMIT 1`,
      [agentId]
    );

    // Upsert health record
    const existing = queryOne<AgentHealth>(
      'SELECT * FROM agent_health WHERE agent_id = ?',
      [agentId]
    );

    const previousState = existing?.health_state;

    if (existing) {
      const consecutiveStalls = healthState === 'stalled' || healthState === 'stuck'
        ? (existing.consecutive_stall_checks || 0) + 1
        : 0;

      run(
        `UPDATE agent_health SET health_state = ?, task_id = ?, last_activity_at = ?, consecutive_stall_checks = ?, updated_at = ?
         WHERE agent_id = ?`,
        [healthState, activeTask?.id || null, now, consecutiveStalls, now, agentId]
      );
    } else {
      const healthId = uuidv4();
      run(
        `INSERT INTO agent_health (id, agent_id, task_id, health_state, last_activity_at, consecutive_stall_checks, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
        [healthId, agentId, activeTask?.id || null, healthState, now, now]
      );
    }

    // Broadcast if health state changed
    if (previousState && previousState !== healthState) {
      const healthRecord = queryOne<AgentHealth>('SELECT * FROM agent_health WHERE agent_id = ?', [agentId]);
      if (healthRecord) {
        broadcast({ type: 'agent_health_changed', payload: healthRecord });
      }
    }

    // Log warnings for degraded states
    if (activeTask && (healthState === 'stalled' || healthState === 'stuck' || healthState === 'zombie')) {
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
         VALUES (?, ?, ?, 'status_changed', ?, ?)`,
        [uuidv4(), activeTask.id, agentId, `Agent health: ${healthState}`, now]
      );
    }

    // Healthy heartbeats were previously not logged at all — agents' 2-minute
    // pings landed as `activity_type = null` elsewhere, so a task could look
    // idle (no typed activity rows) even while its agent was alive. The stall
    // scanner (Phase 3) trusts `task_activities` as the source of truth, so
    // we need a typed row here. Throttled to 5 min to avoid feed noise.
    if (activeTask && healthState === 'working') {
      logTaskActivityThrottled(
        {
          taskId: activeTask.id,
          type: 'heartbeat',
          agentId,
          message: `Agent alive — last real activity confirmed by health pulse`,
        },
        HEARTBEAT_THROTTLE_SECONDS
      );
    }

    // Auto-nudge after consecutive stall checks
    const updatedHealth = queryOne<AgentHealth>('SELECT * FROM agent_health WHERE agent_id = ?', [agentId]);
    if (updatedHealth) {
      results.push(updatedHealth);
      if (updatedHealth.consecutive_stall_checks >= AUTO_NUDGE_AFTER_STALLS && healthState === 'stuck') {
        // Auto-nudge is fire-and-forget
        nudgeAgent(agentId).catch(err =>
          console.error(`[Health] Auto-nudge failed for agent ${agentId}:`, err)
        );
      }
    }
  }

  // Sweep for orphaned assigned tasks — planning complete but never dispatched
  const ASSIGNED_STALE_MINUTES = 2;
  const orphanedTasks = queryAll<Task>(
    `SELECT * FROM tasks 
     WHERE status = 'assigned' 
       AND planning_complete = 1 
       AND (julianday('now') - julianday(updated_at)) * 1440 > ?`,
    [ASSIGNED_STALE_MINUTES]
  );

  for (const task of orphanedTasks) {
    console.log(`[Health] Orphaned assigned task detected: "${task.title}" (${task.id}) — stale for >${ASSIGNED_STALE_MINUTES}min, auto-dispatching`);

    const result = await internalDispatch(task.id, { caller: 'health-orphan-sweep' });
    if (result.success) {
      console.log(`[Health] Auto-dispatched orphaned task "${task.title}"`);
      run(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
         VALUES (?, ?, ?, 'status_changed', 'Auto-dispatched by health sweeper (was stuck in assigned)', ?)`,
        [uuidv4(), task.id, task.assigned_agent_id, now]
      );
    } else {
      console.error(`[Health] Failed to auto-dispatch orphaned task "${task.title}": ${result.error}`);
      run(
        `UPDATE tasks SET planning_dispatch_error = ?, updated_at = ? WHERE id = ?`,
        [`Health sweeper dispatch failed: ${(result.error || '').substring(0, 200)}`, now, task.id]
      );
    }
  }

  // Also set idle agents
  const idleAgents = queryAll<{ id: string }>(
    `SELECT id FROM agents WHERE status = 'standby' AND id NOT IN (SELECT assigned_agent_id FROM tasks WHERE status IN ('assigned', 'in_progress', 'testing', 'verification') AND assigned_agent_id IS NOT NULL)`
  );
  for (const { id: agentId } of idleAgents) {
    const existing = queryOne<{ id: string }>('SELECT id FROM agent_health WHERE agent_id = ?', [agentId]);
    if (existing) {
      run(`UPDATE agent_health SET health_state = 'idle', task_id = NULL, consecutive_stall_checks = 0, updated_at = ? WHERE agent_id = ?`, [now, agentId]);
    } else {
      run(
        `INSERT INTO agent_health (id, agent_id, health_state, updated_at) VALUES (?, ?, 'idle', ?)`,
        [uuidv4(), agentId, now]
      );
    }
  }

  // Run the stall scanner after the per-agent pass. This is the natural
  // place for it: both share the same 2-minute cadence from the SSE
  // stream, and the scanner's throttle windows (NOTIFY_THROTTLE_MINUTES,
  // STALL_DETECTION_MINUTES) make repeated calls cheap. A scanner failure
  // should never break the health cycle — so we catch and log.
  try {
    await scanStalledTasks();
  } catch (err) {
    console.error('[Health] scanStalledTasks failed:', err);
  }

  // Autopilot cycle scanner. Same rationale as scanStalledTasks: piggyback
  // on the existing cadence. research_cycles / ideation_cycles live in
  // separate tables and have their own heartbeat fields, so task scan
  // doesn't see them.
  try {
    await scanStalledCycles();
  } catch (err) {
    console.error('[Health] scanStalledCycles failed:', err);
  }

  return results;
}

/**
 * Nudge a stuck agent: re-dispatch its task with the latest checkpoint context.
 */
export async function nudgeAgent(agentId: string): Promise<{ success: boolean; error?: string }> {
  const activeTask = queryOne<Task>(
    `SELECT * FROM tasks WHERE assigned_agent_id = ? AND status IN ('assigned', 'in_progress', 'testing', 'verification') LIMIT 1`,
    [agentId]
  );

  if (!activeTask) {
    return { success: false, error: 'No active task for this agent' };
  }

  const now = new Date().toISOString();

  // Kill current session
  run(
    `UPDATE openclaw_sessions SET status = 'ended', ended_at = ?, updated_at = ? WHERE agent_id = ? AND status = 'active'`,
    [now, now, agentId]
  );

  // Build checkpoint context
  const checkpointCtx = buildCheckpointContext(activeTask.id);

  // Append checkpoint to task description if available
  if (checkpointCtx) {
    const newDesc = (activeTask.description || '') + checkpointCtx;
    run(
      `UPDATE tasks SET description = ?, status = 'assigned', planning_dispatch_error = NULL, updated_at = ? WHERE id = ?`,
      [newDesc, now, activeTask.id]
    );
  } else {
    run(
      `UPDATE tasks SET status = 'assigned', planning_dispatch_error = NULL, updated_at = ? WHERE id = ?`,
      [now, activeTask.id]
    );
  }

  // Re-dispatch via shared helper (IPv4 coerce + 120s timeout + cause unwrap).
  const result = await internalDispatch(activeTask.id, { caller: 'health-nudge' });
  if (!result.success) {
    return { success: false, error: result.error || 'Dispatch failed' };
  }

  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
     VALUES (?, ?, ?, 'status_changed', 'Agent nudged — re-dispatching with checkpoint context', ?)`,
    [uuidv4(), activeTask.id, agentId, now]
  );
  run(
    `UPDATE agent_health SET consecutive_stall_checks = 0, health_state = 'working', updated_at = ? WHERE agent_id = ?`,
    [now, agentId]
  );
  return { success: true };
}

/**
 * Get health state for all agents.
 */
export function getAllAgentHealth(): AgentHealth[] {
  return queryAll<AgentHealth>('SELECT * FROM agent_health ORDER BY updated_at DESC');
}

/**
 * Get health state for a single agent.
 */
export function getAgentHealth(agentId: string): AgentHealth | null {
  return queryOne<AgentHealth>('SELECT * FROM agent_health WHERE agent_id = ?', [agentId]) || null;
}
