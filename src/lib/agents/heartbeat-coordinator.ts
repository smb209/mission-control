/**
 * Heartbeat coordinator opt-in.
 *
 * When a task's coordinator_mode resolves to 'heartbeat' (per-task
 * override OR workspace default), this module auto-creates a
 * recurring_jobs row that pings the task on cadence. The coordinator
 * runs read-only — it inspects notes, escalates blockers via
 * audience='pm' importance=2, and writes its own observations.
 * Auto-removed on task terminal status.
 *
 * Phase E2 of specs/scope-keyed-sessions.md §5.
 */

import { queryAll, queryOne } from '@/lib/db';
import {
  createRecurringJob,
  getRecurringJob,
  listForTask,
  setJobStatus,
} from '@/lib/db/recurring-jobs';

export type CoordinatorMode = 'off' | 'reactive' | 'heartbeat';

interface WorkspaceCoordinatorRow {
  coordinator_mode: CoordinatorMode;
  coordinator_heartbeat_seconds: number;
}

interface TaskCoordinatorRow {
  workspace_id: string | null;
  coordinator_mode: CoordinatorMode | null;
}

/**
 * Resolve the effective coordinator_mode for a task. Per-task value
 * wins; otherwise inherit from the workspace.
 */
export function effectiveCoordinatorMode(taskId: string): {
  mode: CoordinatorMode;
  heartbeat_seconds: number;
} | null {
  const task = queryOne<TaskCoordinatorRow>(
    `SELECT workspace_id, coordinator_mode FROM tasks WHERE id = ?`,
    [taskId],
  );
  if (!task || !task.workspace_id) return null;
  const ws = queryOne<WorkspaceCoordinatorRow>(
    `SELECT coordinator_mode, coordinator_heartbeat_seconds FROM workspaces WHERE id = ?`,
    [task.workspace_id],
  );
  if (!ws) return null;
  const mode = task.coordinator_mode ?? ws.coordinator_mode;
  return { mode, heartbeat_seconds: ws.coordinator_heartbeat_seconds };
}

const HEARTBEAT_BRIEFING = `Check on this task. Read recent notes via \`read_notes\` for this task,
plus any audience='pm' notes that haven't been resolved.

Per the heartbeat coordinator role:
- If a stage is stalled or going off-track, take_note with audience='next-stage'.
- If there's a blocker that needs operator attention, take_note with audience='pm' and importance=2.
- If everything looks fine, take_note kind='observation' body='ok' so the operator sees the heartbeat ran.

Never write deliverables, never move task status, never propose roadmap changes.
You are purely observational — the agent that watches the watchers.`;

/**
 * Idempotent — if a heartbeat job already exists for this task, returns
 * it; otherwise creates one. Returns null when the task isn't in a
 * workspace whose coordinator_mode resolves to 'heartbeat'.
 */
export function ensureHeartbeatJob(taskId: string): { id: string; created: boolean } | null {
  const cm = effectiveCoordinatorMode(taskId);
  if (!cm || cm.mode !== 'heartbeat') return null;

  const existing = listForTask(taskId).find(
    (j) => j.role === 'coordinator' && j.scope_key_template.includes(':heartbeat'),
  );
  if (existing) {
    if (existing.status !== 'active') {
      setJobStatus(existing.id, 'active');
    }
    return { id: existing.id, created: false };
  }

  const task = queryOne<{ workspace_id: string }>(
    `SELECT workspace_id FROM tasks WHERE id = ?`,
    [taskId],
  );
  if (!task) return null;

  const job = createRecurringJob({
    workspace_id: task.workspace_id,
    name: `Heartbeat coordinator for task ${taskId.slice(0, 8)}`,
    role: 'coordinator',
    // {wsid} + {job_id} substitutions resolved at dispatch time.
    scope_key_template: `agent:mc-runner-dev:main:ws-{wsid}:task-${taskId}:heartbeat`,
    briefing_template: HEARTBEAT_BRIEFING,
    cadence_seconds: cm.heartbeat_seconds,
    attempt_strategy: 'reuse',
    task_id: taskId,
  });
  return { id: job.id, created: true };
}

/**
 * Mark the heartbeat job 'done' when the task reaches terminal status.
 * Idempotent — already-closed jobs are no-ops.
 */
export function closeHeartbeatJobsForTask(taskId: string): number {
  const jobs = listForTask(taskId);
  let closed = 0;
  for (const j of jobs) {
    if (j.status !== 'done') {
      setJobStatus(j.id, 'done');
      closed++;
    }
  }
  return closed;
}

/**
 * Helper for tests: count active heartbeat jobs across all workspaces.
 */
export function countActiveHeartbeats(): number {
  const rows = queryAll<{ n: number }>(
    `SELECT COUNT(*) as n FROM recurring_jobs
      WHERE role = 'coordinator' AND status = 'active'
        AND scope_key_template LIKE '%:heartbeat'`,
  );
  return rows[0]?.n ?? 0;
}

export function getHeartbeatJobForTask(taskId: string) {
  const id = listForTask(taskId).find(
    (j) => j.role === 'coordinator' && j.scope_key_template.includes(':heartbeat'),
  )?.id;
  return id ? getRecurringJob(id) : null;
}
