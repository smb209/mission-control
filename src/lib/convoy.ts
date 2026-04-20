import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run, transaction } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { notifyLearner } from '@/lib/learner';
import { getMissionControlUrl } from '@/lib/config';
import { pickDynamicAgent } from '@/lib/task-governance';
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
 * Create a convoy from a parent task with optional sub-tasks.
 */
export function createConvoy(input: CreateConvoyInput): Convoy {
  const { parentTaskId, name, strategy, decompositionSpec, subtasks = [] } = input;

  return transaction(() => {
    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [parentTaskId]);
    if (!task) throw new Error(`Task ${parentTaskId} not found`);
    if (task.is_subtask) throw new Error('Cannot create a convoy from a sub-task');

    // Check no convoy already exists for this task
    const existing = queryOne<{ id: string }>('SELECT id FROM convoys WHERE parent_task_id = ?', [parentTaskId]);
    if (existing) throw new Error(`Convoy already exists for task ${parentTaskId}`);

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
 * Get convoy details for a parent task, with subtasks joined.
 */
export function getConvoy(parentTaskId: string): (Convoy & { subtasks: (ConvoySubtask & { task: Task })[] }) | null {
  const convoy = queryOne<Convoy>(
    'SELECT * FROM convoys WHERE parent_task_id = ?',
    [parentTaskId]
  );
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

const MAX_PARALLEL_CONVOY_SUBTASKS = 5;

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

  const missionControlUrl = getMissionControlUrl();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.MC_API_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.MC_API_TOKEN}`;
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

    try {
      const res = await fetch(`${missionControlUrl}/api/tasks/${subtask.task_id}/dispatch`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(30_000),
      });

      if (res.ok) {
        results.push({ taskId: subtask.task_id, success: true });
      } else {
        const errorText = await res.text();
        results.push({ taskId: subtask.task_id, success: false, error: errorText });
      }
    } catch (err) {
      results.push({ taskId: subtask.task_id, success: false, error: (err as Error).message });
    }
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
