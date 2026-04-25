/**
 * Initiative DB helpers (Phase 1 of the roadmap planning layer).
 *
 * Initiatives are planning-tree nodes (theme/milestone/epic/story).
 * See specs/roadmap-and-pm-spec.md §3-§6 for the data model.
 *
 * Notes:
 *   - All mutations write through the shared singleton db handle (`getDb`)
 *     so they share connection-level pragmas (foreign_keys=ON).
 *   - Tree moves (parent re-parent) and task re-parents go through
 *     transactional helpers so the audit row is always written with the
 *     state change.
 *   - Cycle detection on move walks the parent chain of `to_parent_id`
 *     looking for `id`. SQLite has no recursive CTE on this code path,
 *     but the planning tree is small (< low thousands) so the linear
 *     walk is fine.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb, queryAll, queryOne, run, transaction } from '@/lib/db';

export type InitiativeKind = 'theme' | 'milestone' | 'epic' | 'story';
export type InitiativeStatus = 'planned' | 'in_progress' | 'at_risk' | 'blocked' | 'done' | 'cancelled';
export type InitiativeDependencyKind = 'finish_to_start' | 'start_to_start' | 'blocking' | 'informational';

export interface Initiative {
  id: string;
  workspace_id: string;
  product_id: string | null;
  parent_initiative_id: string | null;
  kind: InitiativeKind;
  title: string;
  description: string | null;
  status: InitiativeStatus;
  owner_agent_id: string | null;
  estimated_effort_hours: number | null;
  complexity: 'S' | 'M' | 'L' | 'XL' | null;
  target_start: string | null;
  target_end: string | null;
  derived_start: string | null;
  derived_end: string | null;
  committed_end: string | null;
  status_check_md: string | null;
  sort_order: number;
  source_idea_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface InitiativeDependency {
  id: string;
  initiative_id: string;
  depends_on_initiative_id: string;
  kind: InitiativeDependencyKind;
  note: string | null;
  created_at: string;
}

export interface InitiativeParentHistoryRow {
  id: string;
  initiative_id: string;
  from_parent_id: string | null;
  to_parent_id: string | null;
  moved_by_agent_id: string | null;
  reason: string | null;
  created_at: string;
}

export interface CreateInitiativeInput {
  workspace_id: string;
  kind: InitiativeKind;
  title: string;
  product_id?: string | null;
  parent_initiative_id?: string | null;
  description?: string | null;
  status?: InitiativeStatus;
  owner_agent_id?: string | null;
  estimated_effort_hours?: number | null;
  complexity?: 'S' | 'M' | 'L' | 'XL' | null;
  target_start?: string | null;
  target_end?: string | null;
  committed_end?: string | null;
  status_check_md?: string | null;
  sort_order?: number;
  source_idea_id?: string | null;
}

const KINDS: ReadonlySet<InitiativeKind> = new Set(['theme', 'milestone', 'epic', 'story']);

function assertKind(kind: string): asserts kind is InitiativeKind {
  if (!KINDS.has(kind as InitiativeKind)) {
    throw new Error(`Invalid initiative kind: ${kind}`);
  }
}

export function createInitiative(input: CreateInitiativeInput): Initiative {
  assertKind(input.kind);

  if (input.parent_initiative_id) {
    const parent = queryOne<{ id: string }>(
      'SELECT id FROM initiatives WHERE id = ?',
      [input.parent_initiative_id],
    );
    if (!parent) {
      throw new Error(`Parent initiative not found: ${input.parent_initiative_id}`);
    }
  }

  const id = uuidv4();
  const now = new Date().toISOString();

  run(
    `INSERT INTO initiatives (
       id, workspace_id, product_id, parent_initiative_id, kind, title, description,
       status, owner_agent_id, estimated_effort_hours, complexity,
       target_start, target_end, committed_end, status_check_md, sort_order,
       source_idea_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspace_id,
      input.product_id ?? null,
      input.parent_initiative_id ?? null,
      input.kind,
      input.title,
      input.description ?? null,
      input.status ?? 'planned',
      input.owner_agent_id ?? null,
      input.estimated_effort_hours ?? null,
      input.complexity ?? null,
      input.target_start ?? null,
      input.target_end ?? null,
      input.committed_end ?? null,
      input.status_check_md ?? null,
      input.sort_order ?? 0,
      input.source_idea_id ?? null,
      now,
      now,
    ],
  );

  const row = queryOne<Initiative>('SELECT * FROM initiatives WHERE id = ?', [id]);
  if (!row) throw new Error('Insert succeeded but row not found');
  return row;
}

export interface GetInitiativeOptions {
  includeChildren?: boolean;
  includeTasks?: boolean;
}

export interface InitiativeWithRelations extends Initiative {
  children?: Initiative[];
  tasks?: Array<{ id: string; title: string; status: string }>;
}

export function getInitiative(id: string, opts: GetInitiativeOptions = {}): InitiativeWithRelations | undefined {
  const row = queryOne<Initiative>('SELECT * FROM initiatives WHERE id = ?', [id]);
  if (!row) return undefined;

  const result: InitiativeWithRelations = { ...row };

  if (opts.includeChildren) {
    result.children = queryAll<Initiative>(
      'SELECT * FROM initiatives WHERE parent_initiative_id = ? ORDER BY sort_order, created_at',
      [id],
    );
  }
  if (opts.includeTasks) {
    result.tasks = queryAll<{ id: string; title: string; status: string }>(
      'SELECT id, title, status FROM tasks WHERE initiative_id = ? ORDER BY created_at',
      [id],
    );
  }
  return result;
}

export interface ListInitiativesFilters {
  workspace_id?: string;
  product_id?: string;
  parent_id?: string | null; // null = root, string = that parent, undefined = any
  status?: InitiativeStatus;
  kind?: InitiativeKind;
}

export function listInitiatives(filters: ListInitiativesFilters = {}): Initiative[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.workspace_id) {
    where.push('workspace_id = ?');
    params.push(filters.workspace_id);
  }
  if (filters.product_id) {
    where.push('product_id = ?');
    params.push(filters.product_id);
  }
  if (filters.parent_id === null) {
    where.push('parent_initiative_id IS NULL');
  } else if (typeof filters.parent_id === 'string') {
    where.push('parent_initiative_id = ?');
    params.push(filters.parent_id);
  }
  if (filters.status) {
    where.push('status = ?');
    params.push(filters.status);
  }
  if (filters.kind) {
    where.push('kind = ?');
    params.push(filters.kind);
  }

  const sql = `SELECT * FROM initiatives ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY sort_order, created_at`;
  return queryAll<Initiative>(sql, params);
}

export interface InitiativeTreeNode extends Initiative {
  children: InitiativeTreeNode[];
}

/**
 * Build a nested tree for one workspace. If `root_id` is provided, returns
 * only that subtree; otherwise returns all root-level initiatives. Forest
 * is flattened into a single array so callers can render a top-level list.
 */
export function getInitiativeTree(workspace_id: string, root_id?: string): InitiativeTreeNode[] {
  const all = queryAll<Initiative>(
    'SELECT * FROM initiatives WHERE workspace_id = ? ORDER BY sort_order, created_at',
    [workspace_id],
  );

  const byParent = new Map<string | null, Initiative[]>();
  for (const row of all) {
    const key = row.parent_initiative_id ?? null;
    const list = byParent.get(key) ?? [];
    list.push(row);
    byParent.set(key, list);
  }

  function build(parentId: string | null): InitiativeTreeNode[] {
    const kids = byParent.get(parentId) ?? [];
    return kids.map(k => ({ ...k, children: build(k.id) }));
  }

  if (root_id) {
    const root = all.find(i => i.id === root_id);
    if (!root) return [];
    return [{ ...root, children: build(root.id) }];
  }
  return build(null);
}

export interface UpdateInitiativePatch {
  title?: string;
  description?: string | null;
  status?: InitiativeStatus;
  owner_agent_id?: string | null;
  estimated_effort_hours?: number | null;
  complexity?: 'S' | 'M' | 'L' | 'XL' | null;
  target_start?: string | null;
  target_end?: string | null;
  committed_end?: string | null;
  status_check_md?: string | null;
  sort_order?: number;
  product_id?: string | null;
  source_idea_id?: string | null;
  // Note: kind changes go through convertInitiative; parent changes go through moveInitiative.
}

export function updateInitiative(id: string, patch: UpdateInitiativePatch): Initiative {
  const existing = queryOne<Initiative>('SELECT id FROM initiatives WHERE id = ?', [id]);
  if (!existing) throw new Error(`Initiative not found: ${id}`);

  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${key} = ?`);
    values.push(value);
  }
  if (sets.length === 0) {
    return queryOne<Initiative>('SELECT * FROM initiatives WHERE id = ?', [id])!;
  }
  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  run(`UPDATE initiatives SET ${sets.join(', ')} WHERE id = ?`, values);
  return queryOne<Initiative>('SELECT * FROM initiatives WHERE id = ?', [id])!;
}

/**
 * Re-parent an initiative. Rejects cycles (where to_parent is the initiative
 * itself or one of its descendants). Records an audit row in the same
 * transaction as the parent change.
 */
export function moveInitiative(
  id: string,
  to_parent_id: string | null,
  moved_by_agent_id?: string | null,
  reason?: string | null,
): Initiative {
  const existing = queryOne<Initiative>('SELECT * FROM initiatives WHERE id = ?', [id]);
  if (!existing) throw new Error(`Initiative not found: ${id}`);

  if (to_parent_id) {
    if (to_parent_id === id) {
      throw new Error('Cannot move an initiative under itself');
    }
    const target = queryOne<{ id: string }>('SELECT id FROM initiatives WHERE id = ?', [to_parent_id]);
    if (!target) throw new Error(`Target parent not found: ${to_parent_id}`);
    if (isDescendant(to_parent_id, id)) {
      throw new Error('Move would create a cycle');
    }
  }

  return transaction(() => {
    const now = new Date().toISOString();
    run(
      'UPDATE initiatives SET parent_initiative_id = ?, updated_at = ? WHERE id = ?',
      [to_parent_id, now, id],
    );
    run(
      `INSERT INTO initiative_parent_history (id, initiative_id, from_parent_id, to_parent_id, moved_by_agent_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        id,
        existing.parent_initiative_id,
        to_parent_id,
        moved_by_agent_id ?? null,
        reason ?? null,
        now,
      ],
    );
    return queryOne<Initiative>('SELECT * FROM initiatives WHERE id = ?', [id])!;
  });
}

/**
 * Returns true if `candidate` is a descendant of `ancestor` (or equal to it).
 * Walk down the tree from ancestor and look for candidate.
 */
function isDescendant(candidate: string, ancestor: string): boolean {
  if (candidate === ancestor) return true;
  const stack: string[] = [ancestor];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const kids = queryAll<{ id: string }>(
      'SELECT id FROM initiatives WHERE parent_initiative_id = ?',
      [cur],
    );
    for (const k of kids) {
      if (k.id === candidate) return true;
      stack.push(k.id);
    }
  }
  return false;
}

/**
 * Change an initiative's `kind`. v1: no separate audit table for kind changes —
 * the caller can record context in the initiative's description or
 * status_check_md. The /convert endpoint exists primarily so the UI distinguishes
 * "convert to epic" from a generic PATCH (per spec §16 Q5).
 */
export function convertInitiative(
  id: string,
  new_kind: InitiativeKind,
  _moved_by_agent_id?: string | null,
  _reason?: string | null,
): Initiative {
  assertKind(new_kind);
  const existing = queryOne<Initiative>('SELECT id FROM initiatives WHERE id = ?', [id]);
  if (!existing) throw new Error(`Initiative not found: ${id}`);

  run(
    'UPDATE initiatives SET kind = ?, updated_at = ? WHERE id = ?',
    [new_kind, new Date().toISOString(), id],
  );
  return queryOne<Initiative>('SELECT * FROM initiatives WHERE id = ?', [id])!;
}

/**
 * Delete an initiative. Blocked when any descendant initiative or task
 * references it (per spec §4.6) — operator must re-parent or cancel
 * descendants first.
 */
export function deleteInitiative(id: string): void {
  const existing = queryOne<Initiative>('SELECT id FROM initiatives WHERE id = ?', [id]);
  if (!existing) throw new Error(`Initiative not found: ${id}`);

  const childCount = queryOne<{ n: number }>(
    'SELECT COUNT(*) as n FROM initiatives WHERE parent_initiative_id = ?',
    [id],
  );
  if (childCount && childCount.n > 0) {
    throw new Error(`Cannot delete initiative with ${childCount.n} child initiative(s)`);
  }
  const taskCount = queryOne<{ n: number }>(
    'SELECT COUNT(*) as n FROM tasks WHERE initiative_id = ?',
    [id],
  );
  if (taskCount && taskCount.n > 0) {
    throw new Error(`Cannot delete initiative with ${taskCount.n} task(s) referencing it`);
  }

  run('DELETE FROM initiatives WHERE id = ?', [id]);
}

export interface AddDependencyInput {
  initiative_id: string;
  depends_on_initiative_id: string;
  kind?: InitiativeDependencyKind;
  note?: string | null;
}

export function addInitiativeDependency(input: AddDependencyInput): InitiativeDependency {
  if (input.initiative_id === input.depends_on_initiative_id) {
    throw new Error('Initiative cannot depend on itself');
  }
  const a = queryOne<{ id: string }>('SELECT id FROM initiatives WHERE id = ?', [input.initiative_id]);
  if (!a) throw new Error(`Initiative not found: ${input.initiative_id}`);
  const b = queryOne<{ id: string }>('SELECT id FROM initiatives WHERE id = ?', [input.depends_on_initiative_id]);
  if (!b) throw new Error(`Depends-on initiative not found: ${input.depends_on_initiative_id}`);

  const existing = queryOne<InitiativeDependency>(
    'SELECT * FROM initiative_dependencies WHERE initiative_id = ? AND depends_on_initiative_id = ?',
    [input.initiative_id, input.depends_on_initiative_id],
  );
  if (existing) throw new Error('Dependency already exists');

  const id = uuidv4();
  run(
    `INSERT INTO initiative_dependencies (id, initiative_id, depends_on_initiative_id, kind, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.initiative_id,
      input.depends_on_initiative_id,
      input.kind ?? 'finish_to_start',
      input.note ?? null,
      new Date().toISOString(),
    ],
  );
  return queryOne<InitiativeDependency>('SELECT * FROM initiative_dependencies WHERE id = ?', [id])!;
}

export function removeInitiativeDependency(dependency_id: string): void {
  const existing = queryOne<InitiativeDependency>(
    'SELECT id FROM initiative_dependencies WHERE id = ?',
    [dependency_id],
  );
  if (!existing) throw new Error(`Dependency not found: ${dependency_id}`);
  run('DELETE FROM initiative_dependencies WHERE id = ?', [dependency_id]);
}

export interface InitiativeDependencyEdges {
  outgoing: InitiativeDependency[]; // initiatives this one depends on
  incoming: InitiativeDependency[]; // initiatives that depend on this one
}

export function getInitiativeDependencies(id: string): InitiativeDependencyEdges {
  return {
    outgoing: queryAll<InitiativeDependency>(
      'SELECT * FROM initiative_dependencies WHERE initiative_id = ? ORDER BY created_at',
      [id],
    ),
    incoming: queryAll<InitiativeDependency>(
      'SELECT * FROM initiative_dependencies WHERE depends_on_initiative_id = ? ORDER BY created_at',
      [id],
    ),
  };
}

export function getInitiativeHistory(id: string): InitiativeParentHistoryRow[] {
  return queryAll<InitiativeParentHistoryRow>(
    'SELECT * FROM initiative_parent_history WHERE initiative_id = ? ORDER BY created_at',
    [id],
  );
}

/**
 * Internal helper used by tests (and Phase 2 promotion logic) to attach a
 * task to an initiative with the initial audit row written. Exported so
 * Phase 1 tests can exercise the `task_initiative_history` invariant
 * without the promotion endpoint existing yet.
 */
export function attachTaskToInitiative(
  task_id: string,
  initiative_id: string,
  moved_by_agent_id?: string | null,
  reason?: string | null,
): void {
  transaction(() => {
    run(
      'UPDATE tasks SET initiative_id = ?, updated_at = ? WHERE id = ?',
      [initiative_id, new Date().toISOString(), task_id],
    );
    run(
      `INSERT INTO task_initiative_history (id, task_id, from_initiative_id, to_initiative_id, moved_by_agent_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), task_id, null, initiative_id, moved_by_agent_id ?? null, reason ?? null, new Date().toISOString()],
    );
  });
}

/**
 * Move a task between initiatives, writing an audit row in the same
 * transaction. Phase 2 will expose this via /api/tasks/[id]/move-initiative.
 */
export function moveTaskToInitiative(
  task_id: string,
  to_initiative_id: string | null,
  moved_by_agent_id?: string | null,
  reason?: string | null,
): void {
  const task = queryOne<{ id: string; initiative_id: string | null }>(
    'SELECT id, initiative_id FROM tasks WHERE id = ?',
    [task_id],
  );
  if (!task) throw new Error(`Task not found: ${task_id}`);

  if (to_initiative_id) {
    const target = queryOne<{ id: string }>('SELECT id FROM initiatives WHERE id = ?', [to_initiative_id]);
    if (!target) throw new Error(`Target initiative not found: ${to_initiative_id}`);
  }

  // Use the shared db handle so the inner statements share the
  // transaction created by `transaction()`.
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE tasks SET initiative_id = ?, updated_at = ? WHERE id = ?').run(
      to_initiative_id,
      new Date().toISOString(),
      task_id,
    );
    db.prepare(
      `INSERT INTO task_initiative_history (id, task_id, from_initiative_id, to_initiative_id, moved_by_agent_id, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      uuidv4(),
      task_id,
      task.initiative_id,
      to_initiative_id,
      moved_by_agent_id ?? null,
      reason ?? null,
      new Date().toISOString(),
    );
  })();
}
