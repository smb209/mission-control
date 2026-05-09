/**
 * Pre-dispatch workspace-roster gate.
 *
 * Refuses to dispatch a task whose downstream stages need roles the
 * workspace can't currently fill. Converts the recurring "mid-flight stall
 * because no reviewer existed" failure into a one-time, operator-actionable
 * error at dispatch time.
 *
 * See specs/review-stage-robustness-spec.md (Slice 0).
 *
 * Activated by env var `MC_ROSTER_GATE=1` (default off for one cycle so
 * operators can backfill before flipping default-on).
 */
import { queryOne, queryAll, run } from '@/lib/db';
import { logTaskActivity } from '@/lib/activity-log';
import { sendMail } from '@/lib/mailbox';
import { getPmAgent } from '@/lib/agents/pm-resolver';
import type { Task, WorkflowStage } from '@/lib/types';

/** Roles the gate can require. Mirrors resolveBriefingRole's known set. */
export type RosterRole =
  | 'builder'
  | 'tester'
  | 'reviewer'
  | 'researcher'
  | 'writer'
  | 'learner'
  | 'coordinator'
  | 'pm';

const KNOWN_ROLES: ReadonlySet<RosterRole> = new Set([
  'builder', 'tester', 'reviewer', 'researcher', 'writer', 'learner', 'coordinator', 'pm',
]);

export function isRosterGateEnabled(): boolean {
  return process.env.MC_ROSTER_GATE === '1';
}

/**
 * Compute the set of roles a task is expected to need across its full
 * lifecycle. Conservative on purpose: false-positive failures at dispatch
 * ("you're missing X") are operator-actionable, whereas false negatives
 * recreate the original stall pattern.
 */
export function requiredRolesForTask(taskId: string): Set<RosterRole> {
  const task = queryOne<Task & { workflow_template_id: string | null }>(
    `SELECT id, status, convoy_id, workflow_template_id, is_subtask
     FROM tasks WHERE id = ?`,
    [taskId],
  );
  if (!task) return new Set();

  // Convoy subtask: trust the suggested_role, plus reviewer for the review
  // stage. Convoy parents that are themselves convoy_active union across
  // their children below.
  if (task.convoy_id) {
    const subtask = queryOne<{ suggested_role: string | null }>(
      `SELECT suggested_role FROM convoy_subtasks WHERE task_id = ?`,
      [taskId],
    );
    const roles = new Set<RosterRole>();
    if (subtask?.suggested_role && KNOWN_ROLES.has(subtask.suggested_role as RosterRole)) {
      roles.add(subtask.suggested_role as RosterRole);
    } else {
      roles.add('builder');
    }
    roles.add('reviewer');
    return roles;
  }

  // Convoy parent (status convoy_active): union across children.
  if (task.status === 'convoy_active') {
    const children = queryAll<{ suggested_role: string | null }>(
      `SELECT suggested_role FROM convoy_subtasks
       WHERE convoy_id = (SELECT convoy_id FROM convoy_subtasks WHERE task_id = ? LIMIT 1)`,
      [taskId],
    );
    const roles = new Set<RosterRole>();
    for (const c of children) {
      if (c.suggested_role && KNOWN_ROLES.has(c.suggested_role as RosterRole)) {
        roles.add(c.suggested_role as RosterRole);
      } else {
        roles.add('builder');
      }
    }
    roles.add('reviewer');
    return roles;
  }

  // Workflow-template task: union across stage roles. Default reviewer added
  // if any stage's status is 'review' (template format may omit explicit role).
  if (task.workflow_template_id) {
    const tpl = queryOne<{ stages: string }>(
      'SELECT stages FROM workflow_templates WHERE id = ?',
      [task.workflow_template_id],
    );
    if (tpl?.stages) {
      try {
        const stages = JSON.parse(tpl.stages) as WorkflowStage[];
        const roles = new Set<RosterRole>();
        let hasReviewStage = false;
        for (const stage of stages) {
          if (stage.role && KNOWN_ROLES.has(stage.role as RosterRole)) {
            roles.add(stage.role as RosterRole);
          }
          if (stage.status === 'review' || stage.status === 'verification') hasReviewStage = true;
        }
        if (hasReviewStage) roles.add('reviewer');
        if (roles.size === 0) {
          // Empty / malformed template — fall through to default ladder.
          return new Set<RosterRole>(['builder', 'reviewer']);
        }
        return roles;
      } catch {
        // Fall through to default.
      }
    }
  }

  // Plain task default: builder works it, reviewer evaluates it.
  return new Set<RosterRole>(['builder', 'reviewer']);
}

export interface RosterValidationFail {
  ok: false;
  missing: RosterRole[];
  availableByRole: Record<string, number>;
}
export type RosterValidationResult = { ok: true } | RosterValidationFail;

/**
 * Check whether the workspace has at least one available agent for each
 * required role. "Available" = not offline, not disabled (`is_active != 0`).
 * Role match: prefer the agent's `role` column; fall back to gateway-id
 * derivation for legacy rows where role is unset.
 */
export function validateWorkspaceRoster(
  workspaceId: string,
  requiredRoles: Iterable<RosterRole>,
): RosterValidationResult {
  const required = Array.from(new Set(requiredRoles));
  if (required.length === 0) return { ok: true };

  const agents = queryAll<{ role: string | null; gateway_agent_id: string | null }>(
    `SELECT role, gateway_agent_id FROM agents
     WHERE COALESCE(workspace_id, 'default') = ?
       AND COALESCE(is_active, 1) = 1
       AND status != 'offline'`,
    [workspaceId],
  );

  const availableByRole: Record<string, number> = {};
  for (const a of agents) {
    const resolved = resolveAgentRole(a.role, a.gateway_agent_id);
    if (resolved) availableByRole[resolved] = (availableByRole[resolved] ?? 0) + 1;
  }

  const missing = required.filter(r => (availableByRole[r] ?? 0) === 0);
  if (missing.length === 0) return { ok: true };
  return { ok: false, missing, availableByRole };
}

function resolveAgentRole(role: string | null, gatewayId: string | null): RosterRole | null {
  if (role && KNOWN_ROLES.has(role as RosterRole)) return role as RosterRole;
  if (!gatewayId) return null;
  const baseId = gatewayId.replace(/^mc-/, '').replace(/-dev$/, '');
  if (baseId === 'project-manager') return 'pm';
  if (KNOWN_ROLES.has(baseId as RosterRole)) return baseId as RosterRole;
  return null;
}

export interface RosterGateOk { ok: true }
export interface RosterGateBlocked {
  ok: false;
  code: 'roster_incomplete';
  missing: RosterRole[];
  availableByRole: Record<string, number>;
  message: string;
}
export type RosterGateResult = RosterGateOk | RosterGateBlocked;

/**
 * Top-level entry. Computes required roles, validates against the
 * workspace, and on failure flips the task to `needs_user_input`, logs an
 * activity, and writes a mailbox row to the workspace operator/PM.
 *
 * Returns { ok: true } when the gate is disabled (`MC_ROSTER_GATE != 1`)
 * so callers can call unconditionally.
 */
export async function enforceRosterGate(taskId: string): Promise<RosterGateResult> {
  if (!isRosterGateEnabled()) return { ok: true };

  const task = queryOne<{ workspace_id: string | null; status: string }>(
    'SELECT workspace_id, status FROM tasks WHERE id = ?',
    [taskId],
  );
  if (!task) return { ok: true };

  const workspaceId = task.workspace_id ?? 'default';
  const required = requiredRolesForTask(taskId);
  const result = validateWorkspaceRoster(workspaceId, required);
  if (result.ok) return { ok: true };

  const missing = result.missing;
  const message = `Cannot dispatch — workspace "${workspaceId}" is missing role(s): ${missing.join(', ')}. Onboard or enable an agent for each missing role and retry dispatch.`;
  const now = new Date().toISOString();

  // Flip status to needs_user_input with a structured reason.
  run(
    `UPDATE tasks
     SET status = 'needs_user_input',
         status_reason = ?,
         updated_at = ?
     WHERE id = ?`,
    [`roster_incomplete: ${missing.join(',')}`, now, taskId],
  );

  logTaskActivity({
    taskId,
    type: 'roster_incomplete',
    message,
    metadata: { missing, available_by_role: result.availableByRole, workspace_id: workspaceId },
  });

  // Mailbox-ping the workspace PM (operator surrogate). Best-effort: if
  // the workspace has no PM resolvable, log and continue — the
  // status_reason + activity are still actionable in the UI.
  const pm = getPmAgent(workspaceId);
  if (pm) {
    try {
      await sendMail({
        taskId,
        fromAgentId: pm.id,
        toAgentId: pm.id,
        subject: `Roster incomplete: missing ${missing.join(', ')}`,
        body: message,
      });
    } catch (err) {
      console.warn(`[RosterGate] mailbox send failed for task=${taskId}:`, err);
    }
  } else {
    console.warn(`[RosterGate] no PM/operator resolvable for workspace=${workspaceId}; skipping mailbox ping`);
  }

  return {
    ok: false,
    code: 'roster_incomplete',
    missing,
    availableByRole: result.availableByRole,
    message,
  };
}
