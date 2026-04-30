import { queryAll, queryOne, run, transaction } from '@/lib/db';
import { notifyLearner } from '@/lib/learner';
import { parsePlanningSpec } from '@/lib/planning-spec';
import type { Task } from '@/lib/types';

const ACTIVE_STATUSES = ['assigned', 'in_progress', 'convoy_active', 'testing', 'review', 'verification'];
const TERMINAL_STATUSES = ['done', 'cancelled'];

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export interface StageEvidenceResult {
  ok: boolean;
  /** Single-line reason suitable for surfacing to agents + operators. */
  reason?: string;
  /** Ids from planning_spec.deliverables that have no registered fulfillment.
   *  Empty when the task had no structured spec or all deliverables are done. */
  missingDeliverableIds?: string[];
}

/**
 * Check if a task has enough evidence to transition forward into a quality
 * stage. Baseline bar (always enforced): at least one deliverable + one
 * progress activity. Upgraded bar (enforced when the task has a structured
 * planning spec): every spec deliverable must be registered via a
 * task_deliverables row carrying the matching spec_deliverable_id, otherwise
 * the gate rejects and lists the missing ones.
 */
export function checkStageEvidence(taskId: string): StageEvidenceResult {
  // role='output' filter: operator-attached inputs on task creation don't
  // count as evidence that the agent did any work.
  const deliverableCount = Number(
    queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM task_deliverables WHERE task_id = ? AND role = 'output'`,
      [taskId]
    )?.count || 0
  );
  const activityCount = Number(
    queryOne<{ count: number }>(
      `SELECT COUNT(*) as count FROM task_activities WHERE task_id = ? AND activity_type IN ('completed','file_created','updated')`,
      [taskId]
    )?.count || 0
  );

  if (deliverableCount === 0) {
    return { ok: false, reason: 'Evidence gate: no deliverables registered for this task' };
  }
  if (activityCount === 0) {
    return { ok: false, reason: 'Evidence gate: no progress activity logged for this task' };
  }

  // Spec reconciliation: when planning produced a structured spec, every
  // deliverables[] entry must have a matching registration. Tasks without a
  // spec (or with a legacy string[] spec) skip this check — the baseline bar
  // above still applies.
  const task = queryOne<{ planning_spec?: string; convoy_id?: string | null }>(
    'SELECT planning_spec, convoy_id FROM tasks WHERE id = ?',
    [taskId]
  );

  // Convoy subtasks don't each carry the parent's spec — they carry their
  // own descriptions. Reconciliation happens at the parent level when the
  // convoy transitions. So for subtasks we fall back to the baseline bar.
  if (task?.convoy_id) {
    return { ok: true };
  }

  const spec = parsePlanningSpec(task?.planning_spec);
  if (!spec || !spec.isStructured || spec.deliverables.length === 0) {
    return { ok: true };
  }

  const fulfilled = new Set(
    queryAll<{ spec_deliverable_id: string }>(
      `SELECT spec_deliverable_id FROM task_deliverables
       WHERE task_id = ? AND role = 'output' AND spec_deliverable_id IS NOT NULL AND spec_deliverable_id != ''`,
      [taskId]
    ).map(r => r.spec_deliverable_id)
  );

  const missing = spec.deliverables.filter(d => !fulfilled.has(d.id)).map(d => d.id);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Evidence gate: ${missing.length} spec deliverable(s) not fulfilled — missing: ${missing.join(', ')}. Register each with {"spec_deliverable_id": "<id>"} when POSTing to /deliverables.`,
      missingDeliverableIds: missing,
    };
  }

  return { ok: true };
}

/**
 * Legacy boolean wrapper. Prefer checkStageEvidence() in new code so callers
 * can surface the rejection reason. Kept because several call sites upstream
 * still expect a plain bool.
 */
export function hasStageEvidence(taskId: string): boolean {
  return checkStageEvidence(taskId).ok;
}

export function canUseBoardOverride(request: Request): boolean {
  if (process.env.BOARD_OVERRIDE_ENABLED !== 'true') return false;
  return request.headers.get('x-mc-board-override') === 'true';
}

export function auditBoardOverride(taskId: string, fromStatus: string, toStatus: string, reason?: string): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO events (id, type, task_id, message, metadata, created_at)
     VALUES (lower(hex(randomblob(16))), 'system', ?, ?, ?, ?)`,
    [taskId, `Board override: ${fromStatus} → ${toStatus}`, JSON.stringify({ boardOverride: true, reason: reason || null }), now]
  );
}

export function getFailureCountInStage(taskId: string, stage: string): number {
  const row = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM task_activities
     WHERE task_id = ? AND activity_type = 'status_changed' AND message LIKE ?`,
    [taskId, `%Stage failed: ${stage}%`]
  );
  return Number(row?.count || 0);
}

export function ensureFixerExists(workspaceId: string): { id: string; name: string; created: boolean } {
  const existing = queryOne<{ id: string; name: string }>(
    `SELECT id, name FROM agents WHERE workspace_id = ? AND role IN ('fixer','senior') AND status != 'offline' ORDER BY role = 'fixer' DESC, updated_at DESC LIMIT 1`,
    [workspaceId]
  );
  if (existing) return { ...existing, created: false };

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const name = 'Auto Fixer';
  run(
    `INSERT INTO agents (id, name, role, description, avatar_emoji, status, is_master, workspace_id, source, created_at, updated_at)
     VALUES (?, ?, 'fixer', 'Auto-created fixer for repeated stage failures', '🛠️', 'standby', 0, ?, 'local', ?, ?)`,
    [id, name, workspaceId, now, now]
  );
  return { id, name, created: true };
}

export async function escalateFailureIfNeeded(taskId: string, stage: string): Promise<void> {
  const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) return;

  if (getFailureCountInStage(taskId, stage) < 2) return;

  const fixer = ensureFixerExists(task.workspace_id);
  const now = new Date().toISOString();
  transaction(() => {
    run('UPDATE tasks SET assigned_agent_id = ?, status_reason = ?, updated_at = ? WHERE id = ?', [
      fixer.id,
      `Escalated after repeated failures in ${stage}`,
      now,
      taskId,
    ]);

    run(
      `INSERT OR REPLACE INTO task_roles (id, task_id, role, agent_id, created_at)
       VALUES (COALESCE((SELECT id FROM task_roles WHERE task_id = ? AND role = 'fixer'), lower(hex(randomblob(16)))), ?, 'fixer', ?, ?)`,
      [taskId, taskId, fixer.id, now]
    );

    run(
      `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, created_at)
       VALUES (lower(hex(randomblob(16))), ?, ?, 'status_changed', ?, ?)`,
      [taskId, fixer.id, `Escalated to ${fixer.name} after repeated failures in ${stage}`, now]
    );
  });

  if (fixer.created) {
    await notifyLearner(taskId, {
      previousStatus: stage,
      newStatus: stage,
      passed: true,
      context: `Auto-created fixer agent (${fixer.name}) due to repeated stage failures.`,
    });
  }
}

export async function recordLearnerOnTransition(taskId: string, previousStatus: string, newStatus: string, passed = true, failReason?: string): Promise<void> {
  await notifyLearner(taskId, { previousStatus, newStatus, passed, failReason });
}

export function taskCanBeDone(
  taskId: string,
  opts: { ignoreStaleFailureReason?: boolean } = {},
): boolean {
  const task = queryOne<{ status: string; status_reason?: string }>('SELECT status, status_reason FROM tasks WHERE id = ?', [taskId]);
  if (!task) return false;
  const reason = (task.status_reason || '').trim();
  // The caller (transitionTaskStatus) detected a stale "Failed: …" reason
  // that is about to be cleared by the same UPDATE — don't block the
  // transition on the very reason we're erasing in the next statement.
  // Only the canonical handleStageFailure prefix is forgiven; other
  // failure-shaped reasons still block.
  const isStaleAutoFailure = opts.ignoreStaleFailureReason && /^failed:/i.test(reason);
  const hasValidationFailure = !isStaleAutoFailure && reason.toLowerCase().includes('fail');
  return !hasValidationFailure && hasStageEvidence(taskId);
}

export function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function pickDynamicAgent(taskId: string, stageRole?: string | null): { id: string; name: string } | null {
  const planningAgentsTask = queryOne<{ planning_agents?: string }>('SELECT planning_agents FROM tasks WHERE id = ?', [taskId]);
  const plannerCandidates: string[] = [];
  if (planningAgentsTask?.planning_agents) {
    try {
      const parsed = JSON.parse(planningAgentsTask.planning_agents) as Array<{ agent_id?: string; role?: string }>;
      for (const a of parsed) {
        if (a.role && stageRole && a.role.toLowerCase().includes(stageRole.toLowerCase()) && a.agent_id) plannerCandidates.push(a.agent_id);
      }
    } catch {}
  }

  // All role/fallback lookups filter on is_active=1 (COALESCE for rows
  // created before the column existed — default to active). An operator-
  // marked inactive agent is excluded from every routing decision.
  const checked = new Set<string>();
  for (const candidateId of plannerCandidates) {
    const candidate = queryOne<{ id: string; name: string; is_master: number; status: string; is_active: number }>(
      'SELECT id, name, is_master, status, is_active FROM agents WHERE id = ? LIMIT 1',
      [candidateId]
    );
    if (!candidate || candidate.status === 'offline' || Number(candidate.is_active ?? 1) !== 1) continue;
    checked.add(candidate.id);
    return { id: candidate.id, name: candidate.name };
  }

  if (stageRole) {
    // Prefer gateway-linked / session-routed agents. A matching-role "ghost"
    // (no gateway_agent_id, no session_key_prefix) is never actually reachable
    // via OpenClaw, so picking one silently breaks the dispatch.
    const byRole = queryOne<{ id: string; name: string }>(
      `SELECT id, name FROM agents
       WHERE role = ? AND status != 'offline' AND COALESCE(is_active, 1) = 1
       ORDER BY
         (gateway_agent_id IS NOT NULL OR session_key_prefix IS NOT NULL) DESC,
         status = 'standby' DESC,
         updated_at DESC
       LIMIT 1`,
      [stageRole]
    );
    if (byRole) return byRole;
  }

  const fallback = queryOne<{ id: string; name: string }>(
    `SELECT id, name FROM agents
     WHERE status != 'offline' AND COALESCE(is_active, 1) = 1
     ORDER BY
       (gateway_agent_id IS NOT NULL OR session_key_prefix IS NOT NULL) DESC,
       is_master ASC,
       updated_at DESC
     LIMIT 1`
  );
  if (fallback && !checked.has(fallback.id)) return fallback;

  return null;
}
