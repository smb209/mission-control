import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run, transaction } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { notifyLearner } from '@/lib/learner';
import { internalDispatch } from '@/lib/internal-dispatch';
import { pickDynamicAgent } from '@/lib/task-governance';
import { getTaskWorkflow, populateTaskRolesFromAgents } from '@/lib/workflow-engine';
import type { Convoy, ConvoySubtask, Task, ConvoyStatus, DecompositionStrategy } from '@/lib/types';

/**
 * The decomposition LLM writes `depends_on` as zero-based symbolic refs
 * like "subtask-0", "subtask-1" (see src/app/api/tasks/[id]/convoy/route.ts
 * prompt). Translate those into the actual task UUIDs so downstream
 * dependency checks work without a symbol table. Unknown refs are dropped
 * with a warning — they'd only produce a permanently-blocked subtask.
 */
function resolveSymbolicDeps(
  deps: string[] | undefined,
  indexToTaskId: string[]
): string[] | undefined {
  if (!deps || deps.length === 0) return deps;
  const resolved: string[] = [];
  for (const dep of deps) {
    const match = /^subtask-(\d+)$/.exec(dep);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (idx >= 0 && idx < indexToTaskId.length) {
        resolved.push(indexToTaskId[idx]);
      } else {
        console.warn(`[Convoy] depends_on "${dep}" out of range — dropping`);
      }
    } else {
      // Already a UUID (or some other concrete ref) — pass through.
      resolved.push(dep);
    }
  }
  return resolved;
}

interface CreateSubtaskInput {
  title: string;
  description?: string;
  /** Pre-assigned agent from the decomposition LLM (may be null when the planner
   *  explicitly asks to create a new agent). Dispatch falls back to role-based
   *  pick when this is null/undefined. */
  agent_id?: string | null;
  depends_on?: string[];
  /** Role hint for dispatch. If omitted, convoy dispatch falls back to 'builder'. */
  suggested_role?: string;
}

interface CreateConvoyInput {
  parentTaskId: string;
  name: string;
  strategy: DecompositionStrategy;
  decompositionSpec?: string;
  subtasks?: CreateSubtaskInput[];
}

/**
 * Returns the most recently created still-active convoy for a parent task,
 * or null. The schema (as of migration 037) no longer requires one-convoy-
 * per-task; readers that need "the" convoy funnel through this helper so the
 * "latest active" semantic is explicit and consistent.
 *
 * `status='active'` excludes completing/done/failed/paused convoys — a new
 * round of coordinator-driven delegation after completion is free to create
 * a new active convoy rather than reopening a closed one.
 */
export function getActiveConvoyForTask(parentTaskId: string): Convoy | null {
  return queryOne<Convoy>(
    `SELECT * FROM convoys
     WHERE parent_task_id = ? AND status = 'active'
     ORDER BY datetime(created_at) DESC
     LIMIT 1`,
    [parentTaskId]
  ) ?? null;
}

/**
 * Create a convoy from a parent task with optional sub-tasks.
 */
export function createConvoy(input: CreateConvoyInput): Convoy {
  const { parentTaskId, name, strategy, decompositionSpec, subtasks = [] } = input;

  return transaction(() => {
    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [parentTaskId]);
    if (!task) throw new Error(`Task ${parentTaskId} not found`);
    if (task.is_subtask) throw new Error('Cannot create a convoy from a sub-task');

    // Multiple convoys per parent are allowed since migration 037, but we
    // still reject a second *active* convoy — callers that want to append
    // work should use addSubtasks() on the existing active convoy instead,
    // and the coordinator delegation path (spawn_subtask) already does so
    // via getActiveConvoyForTask() before falling back to createConvoy().
    const activeExisting = getActiveConvoyForTask(parentTaskId);
    if (activeExisting) throw new Error(`An active convoy already exists for task ${parentTaskId} — append via addSubtasks instead`);

    const convoyId = uuidv4();
    const now = new Date().toISOString();

    run(
      `INSERT INTO convoys (id, parent_task_id, name, status, decomposition_strategy, decomposition_spec, total_subtasks, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      [convoyId, parentTaskId, name, strategy, decompositionSpec || null, subtasks.length, now, now]
    );

    // Move parent task to convoy_active
    run(
      `UPDATE tasks SET status = 'convoy_active', updated_at = ? WHERE id = ?`,
      [now, parentTaskId]
    );

    // Pre-allocate UUIDs so we can translate symbolic `depends_on` refs
    // ("subtask-N") into real task IDs before inserting any rows.
    const indexToTaskId = subtasks.map(() => uuidv4());

    for (let i = 0; i < subtasks.length; i++) {
      const sub = subtasks[i];
      const subtaskId = indexToTaskId[i];
      const convoySubtaskId = uuidv4();
      const resolvedDeps = resolveSymbolicDeps(sub.depends_on, indexToTaskId);

      // Create the task entry
      run(
        `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, workspace_id, business_id, workflow_template_id, convoy_id, is_subtask, created_at, updated_at)
         VALUES (?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [subtaskId, sub.title, sub.description || null, task.priority, sub.agent_id || null, task.workspace_id, task.business_id, task.workflow_template_id || null, convoyId, now, now]
      );

      // Create the convoy_subtasks relationship
      run(
        `INSERT INTO convoy_subtasks (id, convoy_id, task_id, sort_order, depends_on, suggested_role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [convoySubtaskId, convoyId, subtaskId, i, resolvedDeps && resolvedDeps.length > 0 ? JSON.stringify(resolvedDeps) : null, sub.suggested_role || null, now]
      );
    }

    const convoy = queryOne<Convoy>('SELECT * FROM convoys WHERE id = ?', [convoyId])!;

    // Broadcast
    const updatedParent = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [parentTaskId]);
    if (updatedParent) broadcast({ type: 'task_updated', payload: updatedParent });
    broadcast({ type: 'convoy_created', payload: convoy });

    // Log event
    run(
      `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), 'task_status_changed', parentTaskId, `Convoy "${name}" created with ${subtasks.length} sub-tasks`, now]
    );

    return convoy;
  });
}

/**
 * Get convoy details for a parent task, with subtasks joined. Returns the
 * latest active convoy (see getActiveConvoyForTask); prior completed convoys
 * are not surfaced through this helper.
 */
export function getConvoy(parentTaskId: string): (Convoy & { subtasks: (ConvoySubtask & { task: Task })[] }) | null {
  const convoy = getActiveConvoyForTask(parentTaskId);
  if (!convoy) return null;

  const subtaskRows = queryAll<ConvoySubtask & { task_title: string; task_status: string; task_assigned_agent_id: string | null }>(
    `SELECT cs.*, t.title as task_title, t.status as task_status, t.assigned_agent_id as task_assigned_agent_id
     FROM convoy_subtasks cs
     JOIN tasks t ON cs.task_id = t.id
     WHERE cs.convoy_id = ?
     ORDER BY cs.sort_order`,
    [convoy.id]
  );

  const subtasks = subtaskRows.map(row => ({
    ...row,
    depends_on: row.depends_on ? JSON.parse(row.depends_on as unknown as string) : undefined,
    task: {
      id: row.task_id,
      title: row.task_title,
      status: row.task_status,
      assigned_agent_id: row.task_assigned_agent_id,
    } as Task,
  }));

  return { ...convoy, subtasks };
}

/**
 * Recalculate convoy progress counters from actual sub-task statuses.
 */
export function updateConvoyProgress(convoyId: string): void {
  const completed = queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM convoy_subtasks cs JOIN tasks t ON cs.task_id = t.id
     WHERE cs.convoy_id = ? AND t.status = 'done'`,
    [convoyId]
  )?.cnt || 0;

  const failed = queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM convoy_subtasks cs JOIN tasks t ON cs.task_id = t.id
     WHERE cs.convoy_id = ? AND t.status_reason IS NOT NULL AND t.status = 'in_progress'`,
    [convoyId]
  )?.cnt || 0;

  const now = new Date().toISOString();
  run(
    `UPDATE convoys SET completed_subtasks = ?, failed_subtasks = ?, updated_at = ? WHERE id = ?`,
    [completed, failed, now, convoyId]
  );

  const convoy = queryOne<Convoy>('SELECT * FROM convoys WHERE id = ?', [convoyId]);
  if (convoy) {
    broadcast({ type: 'convoy_progress', payload: convoy });
  }
}

/**
 * Check if a convoy is complete (all sub-tasks done) and transition accordingly.
 */
export function checkConvoyCompletion(convoyId: string): boolean {
  const convoy = queryOne<Convoy>('SELECT * FROM convoys WHERE id = ?', [convoyId]);
  if (!convoy || convoy.status !== 'active') return false;

  const total = convoy.total_subtasks;
  const completed = queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM convoy_subtasks cs JOIN tasks t ON cs.task_id = t.id
     WHERE cs.convoy_id = ? AND t.status = 'done'`,
    [convoyId]
  )?.cnt || 0;

  if (completed >= total && total > 0) {
    const now = new Date().toISOString();

    // Move convoy to completing → done
    run(
      `UPDATE convoys SET status = 'done', completed_subtasks = ?, updated_at = ? WHERE id = ?`,
      [completed, now, convoyId]
    );

    // Move parent task to review
    run(
      `UPDATE tasks SET status = 'review', updated_at = ? WHERE id = ?`,
      [now, convoy.parent_task_id]
    );

    const updatedParent = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [convoy.parent_task_id]);
    if (updatedParent) broadcast({ type: 'task_updated', payload: updatedParent });

    const updatedConvoy = queryOne<Convoy>('SELECT * FROM convoys WHERE id = ?', [convoyId]);
    if (updatedConvoy) broadcast({ type: 'convoy_completed', payload: updatedConvoy });

    run(
      `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
      [uuidv4(), 'task_status_changed', convoy.parent_task_id, `Convoy complete — all ${total} sub-tasks done`, now]
    );

    // Notify learner about convoy completion
    notifyLearner(convoy.parent_task_id, {
      previousStatus: 'convoy_active',
      newStatus: 'review',
      passed: true,
      context: `Convoy completed successfully with ${total} sub-tasks.`,
    }).catch(err => console.error('[Learner] convoy completion notification failed:', err));

    return true;
  }

  // Check failure threshold (more than half failed)
  const failed = queryOne<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM convoy_subtasks cs JOIN tasks t ON cs.task_id = t.id
     WHERE cs.convoy_id = ? AND t.status_reason IS NOT NULL`,
    [convoyId]
  )?.cnt || 0;

  if (failed > total / 2) {
    const now = new Date().toISOString();
    run(`UPDATE convoys SET status = 'failed', failed_subtasks = ?, updated_at = ? WHERE id = ?`, [failed, now, convoyId]);
    run(`UPDATE tasks SET status = 'review', status_reason = 'Convoy failed: too many sub-task failures', updated_at = ? WHERE id = ?`, [now, convoy.parent_task_id]);

    notifyLearner(convoy.parent_task_id, {
      previousStatus: 'convoy_active',
      newStatus: 'review',
      passed: false,
      failReason: `Convoy failed: ${failed} of ${total} sub-tasks failed (threshold exceeded).`,
    }).catch(err => console.error('[Learner] convoy failure notification failed:', err));
  }

  return false;
}

/**
 * Parallel subtask cap. Defaults to 10 (up from 5 pre-PR) to accommodate
 * agent-driven delegations that legitimately fan out to every peer in the
 * roster; operator-planned convoys rarely approach this. Override with
 * `MC_CONVOY_MAX_PARALLEL` env var.
 */
function getMaxParallelConvoySubtasks(): number {
  const raw = process.env.MC_CONVOY_MAX_PARALLEL;
  if (!raw) return 10;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
}
const MAX_PARALLEL_CONVOY_SUBTASKS = getMaxParallelConvoySubtasks();

export interface ConvoyDispatchResult {
  dispatched: number;
  total: number;
  skipped?: string;
  results: Array<{ taskId: string; success: boolean; error?: string }>;
}

/**
 * Advance every ready subtask in a convoy: auto-assign agents, move to
 * `assigned`, and POST to the per-task dispatch endpoint. Used both by the
 * explicit `/convoy/dispatch` endpoint (operator nudge) and by the PATCH
 * done-handler (auto-advance when a dependency completes).
 *
 * No-ops gracefully when the convoy is missing, inactive, or already at the
 * parallel-subtask cap. Never throws — callers should treat the result as
 * advisory.
 */
export async function dispatchReadyConvoySubtasks(convoyId: string): Promise<ConvoyDispatchResult> {
  const convoy = queryOne<Convoy>('SELECT * FROM convoys WHERE id = ?', [convoyId]);
  if (!convoy) return { dispatched: 0, total: 0, skipped: 'convoy not found', results: [] };
  if (convoy.status !== 'active') return { dispatched: 0, total: 0, skipped: `convoy is ${convoy.status}`, results: [] };

  const allDispatchable = getDispatchableSubtasks(convoyId);
  if (allDispatchable.length === 0) {
    return { dispatched: 0, total: 0, skipped: 'no subtasks ready', results: [] };
  }

  const currentlyActive = queryAll<{ id: string }>(
    `SELECT t.id FROM convoy_subtasks cs JOIN tasks t ON cs.task_id = t.id
     WHERE cs.convoy_id = ? AND t.status IN ('assigned', 'in_progress', 'testing', 'verification')`,
    [convoyId]
  ).length;
  const slots = Math.max(0, MAX_PARALLEL_CONVOY_SUBTASKS - currentlyActive);
  const dispatchable = allDispatchable.slice(0, slots);

  if (dispatchable.length === 0) {
    return { dispatched: 0, total: allDispatchable.length, skipped: `max parallel reached (${MAX_PARALLEL_CONVOY_SUBTASKS})`, results: [] };
  }

  const results: ConvoyDispatchResult['results'] = [];

  for (const subtask of dispatchable) {
    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [subtask.task_id]);
    if (!task) continue;

    let agentId = task.assigned_agent_id;
    if (!agentId) {
      const roleHint = subtask.suggested_role || 'builder';
      const picked = pickDynamicAgent(subtask.task_id, roleHint);
      if (picked) {
        agentId = picked.id;
        run('UPDATE tasks SET assigned_agent_id = ?, updated_at = datetime(\'now\') WHERE id = ?', [agentId, subtask.task_id]);
      }
    }

    if (!agentId) {
      results.push({ taskId: subtask.task_id, success: false, error: 'No agent available' });
      continue;
    }

    run('UPDATE tasks SET status = \'assigned\', updated_at = datetime(\'now\') WHERE id = ?', [subtask.task_id]);

    const result = await internalDispatch(subtask.task_id, { caller: 'convoy-dispatch' });
    results.push({ taskId: subtask.task_id, success: result.success, error: result.error });
  }

  updateConvoyProgress(convoyId);

  return {
    dispatched: results.filter(r => r.success).length,
    total: dispatchable.length,
    results,
  };
}

/**
 * Find sub-tasks that are ready to dispatch (in inbox, all dependencies done).
 */
export function getDispatchableSubtasks(convoyId: string): ConvoySubtask[] {
  const subtasks = queryAll<ConvoySubtask & { task_status: string }>(
    `SELECT cs.*, t.status as task_status
     FROM convoy_subtasks cs
     JOIN tasks t ON cs.task_id = t.id
     WHERE cs.convoy_id = ? AND t.status = 'inbox'
     ORDER BY cs.sort_order`,
    [convoyId]
  );

  // Get all done task IDs in this convoy for dependency checking
  const doneTaskIds = new Set(
    queryAll<{ task_id: string }>(
      `SELECT cs.task_id FROM convoy_subtasks cs JOIN tasks t ON cs.task_id = t.id
       WHERE cs.convoy_id = ? AND t.status = 'done'`,
      [convoyId]
    ).map(r => r.task_id)
  );

  return subtasks.filter(st => {
    const deps = st.depends_on ? JSON.parse(st.depends_on as unknown as string) as string[] : [];
    return deps.every(depId => doneTaskIds.has(depId));
  });
}

/**
 * Add subtask(s) to an existing convoy.
 */
export function addSubtasks(convoyId: string, subtasks: CreateSubtaskInput[]): ConvoySubtask[] {
  const convoy = queryOne<Convoy>('SELECT * FROM convoys WHERE id = ?', [convoyId]);
  if (!convoy) throw new Error(`Convoy ${convoyId} not found`);

  const parentTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [convoy.parent_task_id]);
  if (!parentTask) throw new Error('Parent task not found');

  const maxOrder = queryOne<{ max_order: number }>(
    'SELECT MAX(sort_order) as max_order FROM convoy_subtasks WHERE convoy_id = ?',
    [convoyId]
  )?.max_order || 0;

  const created: ConvoySubtask[] = [];
  const now = new Date().toISOString();

  return transaction(() => {
    // Pre-allocate UUIDs for the new subtasks so symbolic deps referring to
    // other new subtasks ("subtask-N", counting from the convoy start) resolve
    // correctly. Existing subtasks are also addressable by the same scheme.
    const existingByOrder = queryAll<{ task_id: string; sort_order: number }>(
      'SELECT task_id, sort_order FROM convoy_subtasks WHERE convoy_id = ? ORDER BY sort_order',
      [convoyId]
    );
    const indexToTaskId: string[] = existingByOrder.map(r => r.task_id);
    for (let i = 0; i < subtasks.length; i++) {
      indexToTaskId.push(uuidv4());
    }

    for (let i = 0; i < subtasks.length; i++) {
      const sub = subtasks[i];
      const subtaskId = indexToTaskId[existingByOrder.length + i];
      const convoySubtaskId = uuidv4();
      const resolvedDeps = resolveSymbolicDeps(sub.depends_on, indexToTaskId);

      run(
        `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, workspace_id, business_id, workflow_template_id, convoy_id, is_subtask, created_at, updated_at)
         VALUES (?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [subtaskId, sub.title, sub.description || null, parentTask.priority, sub.agent_id || null, parentTask.workspace_id, parentTask.business_id, parentTask.workflow_template_id || null, convoyId, now, now]
      );

      run(
        `INSERT INTO convoy_subtasks (id, convoy_id, task_id, sort_order, depends_on, suggested_role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [convoySubtaskId, convoyId, subtaskId, maxOrder + i + 1, resolvedDeps && resolvedDeps.length > 0 ? JSON.stringify(resolvedDeps) : null, sub.suggested_role || null, now]
      );

      created.push({ id: convoySubtaskId, convoy_id: convoyId, task_id: subtaskId, sort_order: maxOrder + i + 1, depends_on: resolvedDeps, suggested_role: sub.suggested_role || null, created_at: now });
    }

    // Update total count
    run(
      `UPDATE convoys SET total_subtasks = total_subtasks + ?, updated_at = ? WHERE id = ?`,
      [subtasks.length, now, convoyId]
    );

    return created;
  });
}

/**
 * Update convoy status (pause, resume, cancel).
 */
export function updateConvoyStatus(convoyId: string, status: ConvoyStatus): Convoy {
  const now = new Date().toISOString();
  run(`UPDATE convoys SET status = ?, updated_at = ? WHERE id = ?`, [status, now, convoyId]);
  const convoy = queryOne<Convoy>('SELECT * FROM convoys WHERE id = ?', [convoyId])!;
  return convoy;
}

/**
 * Delete a convoy and all its sub-tasks.
 */
export function deleteConvoy(convoyId: string): void {
  const convoy = queryOne<Convoy>('SELECT * FROM convoys WHERE id = ?', [convoyId]);
  if (!convoy) throw new Error(`Convoy ${convoyId} not found`);

  transaction(() => {
    // Delete sub-task entries (cascade will handle convoy_subtasks)
    const subtaskIds = queryAll<{ task_id: string }>(
      'SELECT task_id FROM convoy_subtasks WHERE convoy_id = ?',
      [convoyId]
    );
    for (const { task_id } of subtaskIds) {
      run('DELETE FROM tasks WHERE id = ?', [task_id]);
    }

    // Delete convoy
    run('DELETE FROM convoys WHERE id = ?', [convoyId]);

    // Reset parent task back to inbox
    const now = new Date().toISOString();
    run(
      `UPDATE tasks SET status = 'inbox', updated_at = ? WHERE id = ?`,
      [now, convoy.parent_task_id]
    );

    const updatedParent = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [convoy.parent_task_id]);
    if (updatedParent) broadcast({ type: 'task_updated', payload: updatedParent });
  });
}

// ─── Agent-initiated delegation ────────────────────────────────────

export interface SpawnDelegationInput {
  parentTaskId: string;
  parentAgentId: string;
  peerAgentId: string;
  peerGatewayId: string;
  suggestedRole: string;
  slice: string;
  message: string;
  expectedDeliverables: { title: string; kind: 'file' | 'note' | 'report' }[];
  acceptanceCriteria: string[];
  expectedDurationMinutes: number;
  checkinIntervalMinutes: number;
  dependsOnSubtaskIds?: string[];
}

export interface SpawnDelegationResult {
  subtaskId: string;
  childTaskId: string;
  convoyId: string;
  dispatchedAt: string;
  dueAt: string;
}

/**
 * Create (or append to) a convoy for a coordinator-initiated delegation.
 *
 * Invoked by the `spawn_subtask` MCP tool. Unlike `createConvoy` +
 * `addSubtasks`, this carries the SLO contract (slice, expected
 * deliverables, acceptance criteria, duration, cadence) onto the
 * `convoy_subtasks` row so stall detection and the coordinator's
 * `list_my_subtasks` read can reason about the delegation deterministically.
 *
 * The actual peer dispatch (HTTP POST to /api/tasks/:child_id/dispatch) is
 * the caller's job — we can't reach-around from here without a circular
 * dependency (dispatch needs convoy, convoy can't need dispatch). The
 * caller invokes the dispatch after this function returns.
 */
export function spawnDelegationSubtask(input: SpawnDelegationInput): SpawnDelegationResult {
  return transaction(() => {
    const parent = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [input.parentTaskId]);
    if (!parent) throw new Error(`Parent task ${input.parentTaskId} not found`);
    if (parent.is_subtask) throw new Error('Peer sub-delegation is not allowed (parent is itself a subtask)');

    // Lazy-create or reuse the active convoy on this parent task.
    let convoy = getActiveConvoyForTask(input.parentTaskId);
    const now = new Date().toISOString();

    if (!convoy) {
      const convoyId = uuidv4();
      run(
        `INSERT INTO convoys (id, parent_task_id, name, status, decomposition_strategy, total_subtasks, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 'agent', 0, ?, ?)`,
        [convoyId, input.parentTaskId, `${parent.title} — delegations`, now, now]
      );
      convoy = queryOne<Convoy>('SELECT * FROM convoys WHERE id = ?', [convoyId])!;
      // Move parent into convoy_active so the stall scanner and UI see it.
      run(
        `UPDATE tasks SET status = 'convoy_active', updated_at = ? WHERE id = ?`,
        [now, input.parentTaskId]
      );
      broadcast({ type: 'convoy_created', payload: convoy });
    }

    // Sort order = max+1 (append).
    const maxOrder = queryOne<{ max_order: number | null }>(
      'SELECT MAX(sort_order) as max_order FROM convoy_subtasks WHERE convoy_id = ?',
      [convoy.id]
    )?.max_order ?? 0;

    // Create the child task row. Pre-assigned to the peer; workflow
    // inheritance mirrors what addSubtasks does for operator flows.
    const childTaskId = uuidv4();
    run(
      `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, workspace_id, business_id, workflow_template_id, convoy_id, is_subtask, created_at, updated_at)
       VALUES (?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        childTaskId,
        input.slice.slice(0, 200),
        input.message.slice(0, 4000),
        parent.priority,
        input.peerAgentId,
        parent.workspace_id,
        parent.business_id,
        parent.workflow_template_id || null,
        convoy.id,
        now,
        now,
      ]
    );

    // Dispatched/due timestamps. The caller performs the HTTP dispatch
    // right after; storing the timestamp here keeps SLO math monotonic
    // even if the HTTP call retries.
    const dueAt = new Date(Date.now() + input.expectedDurationMinutes * 60_000).toISOString();

    const subtaskId = uuidv4();
    run(
      `INSERT INTO convoy_subtasks (
         id, convoy_id, task_id, sort_order, depends_on, suggested_role,
         slice, expected_deliverables, acceptance_criteria,
         expected_duration_minutes, checkin_interval_minutes,
         dispatched_at, due_at, deliverables_registered_count, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        subtaskId,
        convoy.id,
        childTaskId,
        maxOrder + 1,
        input.dependsOnSubtaskIds && input.dependsOnSubtaskIds.length > 0
          ? JSON.stringify(input.dependsOnSubtaskIds)
          : null,
        input.suggestedRole,
        input.slice,
        JSON.stringify(input.expectedDeliverables),
        JSON.stringify(input.acceptanceCriteria),
        input.expectedDurationMinutes,
        input.checkinIntervalMinutes,
        now,
        dueAt,
        now,
      ]
    );

    run(
      `UPDATE convoys SET total_subtasks = total_subtasks + 1, updated_at = ? WHERE id = ?`,
      [now, convoy.id]
    );

    // Propagate workflow role assignments to the child. Without this the
    // child inherits a multi-stage workflow (Build/Test/Review) but only
    // has assigned_agent_id set to the spawned peer — every other stage
    // role has no assignment, and the workflow engine's old fallback
    // would silently re-dispatch the same peer as Tester/Reviewer in its
    // own session. Now we wire the child's task_roles up front:
    //   1. The stage role matching the spawned peer's role → the peer.
    //   2. Every other stage role inherits from the parent's task_roles
    //      when present (so a Tester/Reviewer the operator wired up at
    //      the parent level cascades to spawned children).
    //   3. populateTaskRolesFromAgents fills any remaining gaps via fuzzy
    //      match against the workspace roster.
    const childWorkflow = getTaskWorkflow(childTaskId);
    if (childWorkflow) {
      const peerRoleKey = (input.suggestedRole || '').toLowerCase();
      const inserted = new Set<string>();

      // Stage role matching the peer agent's role
      for (const stage of childWorkflow.stages) {
        if (!stage.role) continue;
        if (stage.role.toLowerCase() === peerRoleKey) {
          run(
            `INSERT OR IGNORE INTO task_roles (id, task_id, role, agent_id, created_at)
             VALUES (?, ?, ?, ?, datetime('now'))`,
            [uuidv4(), childTaskId, stage.role, input.peerAgentId],
          );
          inserted.add(stage.role);
        }
      }

      // Inherit remaining stage roles from the parent's task_roles
      const parentRoles = queryAll<{ role: string; agent_id: string }>(
        'SELECT role, agent_id FROM task_roles WHERE task_id = ?',
        [parent.id],
      );
      const parentRoleMap = new Map<string, string>();
      for (const pr of parentRoles) {
        parentRoleMap.set(pr.role.toLowerCase(), pr.agent_id);
      }
      for (const stage of childWorkflow.stages) {
        if (!stage.role || inserted.has(stage.role)) continue;
        const parentAgentId = parentRoleMap.get(stage.role.toLowerCase());
        if (parentAgentId) {
          run(
            `INSERT OR IGNORE INTO task_roles (id, task_id, role, agent_id, created_at)
             VALUES (?, ?, ?, ?, datetime('now'))`,
            [uuidv4(), childTaskId, stage.role, parentAgentId],
          );
          inserted.add(stage.role);
        }
      }

      // Fall back to fuzzy matching for any role still unassigned. The
      // helper is a no-op when task_roles already has rows for every
      // stage role, so calling it after our explicit inserts is safe.
      populateTaskRolesFromAgents(childTaskId, parent.workspace_id);
    }

    return {
      subtaskId,
      childTaskId,
      convoyId: convoy.id,
      dispatchedAt: now,
      dueAt,
    };
  });
}
