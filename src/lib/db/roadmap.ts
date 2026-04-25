/**
 * Roadmap snapshot helper (Phase 3).
 *
 * Aggregates initiative tree, dependencies, and tasks for a workspace into
 * a single payload optimized for the timeline view. Keeps the DB round-trips
 * to a fixed number (one per logical group) so a 500-initiative workspace
 * still loads in a single tick.
 *
 * Filter semantics:
 *   - `workspace_id` (required): hard filter, applies before paging.
 *   - `product_id`: filter initiatives by product; tasks/deps are also
 *     restricted to the surviving initiative set.
 *   - `owner_agent_id`, `kind`, `status`: filter the initiative set.
 *   - `from`/`to`: clip by target window overlap (initiatives whose
 *     [target_start, target_end] window intersects [from, to] are kept).
 *     Initiatives with no target dates are kept regardless — the UI
 *     renders them as "no schedule" rows.
 *   - `MAX` cap: returns at most 500 rows; `truncated: true` is set if
 *     the underlying set was larger.
 *
 * Pure data — does no rendering, holds no React state. Callable from API
 * routes and (later) from MCP tools.
 */

import { queryAll } from '@/lib/db';
import { windowsOverlap } from '@/lib/roadmap/date-math';

const MAX = 500;

export type InitiativeKind = 'theme' | 'milestone' | 'epic' | 'story';
export type InitiativeStatus = 'planned' | 'in_progress' | 'at_risk' | 'blocked' | 'done' | 'cancelled';

export interface RoadmapInitiative {
  id: string;
  parent_initiative_id: string | null;
  product_id: string | null;
  kind: InitiativeKind;
  title: string;
  status: InitiativeStatus;
  owner_agent_id: string | null;
  owner_agent_name: string | null;
  complexity: 'S' | 'M' | 'L' | 'XL' | null;
  estimated_effort_hours: number | null;
  target_start: string | null;
  target_end: string | null;
  derived_start: string | null;
  derived_end: string | null;
  committed_end: string | null;
  status_check_md: string | null;
  sort_order: number;
  depth: number;
  task_counts: { draft: number; active: number; done: number; total: number };
}

export interface RoadmapDependency {
  id: string;
  initiative_id: string;
  depends_on_initiative_id: string;
  kind: string;
  note: string | null;
}

export interface RoadmapTask {
  id: string;
  initiative_id: string;
  title: string;
  status: string;
  assigned_agent_id: string | null;
}

export interface RoadmapSnapshot {
  initiatives: RoadmapInitiative[];
  dependencies: RoadmapDependency[];
  tasks: RoadmapTask[];
  workspace_id: string;
  product_id: string | null;
  truncated: boolean;
}

export interface RoadmapFilters {
  workspace_id: string;
  product_id?: string | null;
  owner_agent_id?: string | null;
  kind?: InitiativeKind;
  status?: InitiativeStatus;
  from?: string | null;
  to?: string | null;
}

/** Status families for task chip rendering. Mirrors initiatives page. */
const ACTIVE_STATUSES = new Set([
  'inbox',
  'planning',
  'assigned',
  'in_progress',
  'convoy_active',
  'testing',
  'review',
  'verification',
]);

interface RawInitiativeRow {
  id: string;
  workspace_id: string;
  product_id: string | null;
  parent_initiative_id: string | null;
  kind: InitiativeKind;
  title: string;
  status: InitiativeStatus;
  owner_agent_id: string | null;
  owner_agent_name: string | null;
  complexity: 'S' | 'M' | 'L' | 'XL' | null;
  estimated_effort_hours: number | null;
  target_start: string | null;
  target_end: string | null;
  derived_start: string | null;
  derived_end: string | null;
  committed_end: string | null;
  status_check_md: string | null;
  sort_order: number;
}

/**
 * Build the snapshot. Returns deterministic-order arrays — callers may
 * rely on `initiatives` being in (parent, sort_order, created_at) order
 * for the rail tree render.
 */
export function getRoadmapSnapshot(filters: RoadmapFilters): RoadmapSnapshot {
  const where: string[] = ['i.workspace_id = ?'];
  const params: unknown[] = [filters.workspace_id];

  if (filters.product_id) {
    where.push('i.product_id = ?');
    params.push(filters.product_id);
  }
  if (filters.owner_agent_id) {
    where.push('i.owner_agent_id = ?');
    params.push(filters.owner_agent_id);
  }
  if (filters.kind) {
    where.push('i.kind = ?');
    params.push(filters.kind);
  }
  if (filters.status) {
    where.push('i.status = ?');
    params.push(filters.status);
  }

  // Pull rows + owner agent name in one shot via LEFT JOIN.
  const sql = `
    SELECT
      i.id, i.workspace_id, i.product_id, i.parent_initiative_id,
      i.kind, i.title, i.status, i.owner_agent_id,
      a.name AS owner_agent_name,
      i.complexity, i.estimated_effort_hours,
      i.target_start, i.target_end,
      i.derived_start, i.derived_end, i.committed_end,
      i.status_check_md, i.sort_order
    FROM initiatives i
    LEFT JOIN agents a ON a.id = i.owner_agent_id
    WHERE ${where.join(' AND ')}
    ORDER BY i.sort_order, i.created_at
  `;
  const rawRows = queryAll<RawInitiativeRow>(sql, params);

  // Date-window filter (post-query because the predicate uses the windowsOverlap
  // helper, which handles NULL endpoints uniformly with the JS code).
  const dateFiltered = (filters.from || filters.to)
    ? rawRows.filter(r => {
        // Initiatives with neither target_start nor target_end are kept —
        // they're "no schedule" backlog items, useful regardless of clip.
        if (r.target_start == null && r.target_end == null) return true;
        return windowsOverlap(r.target_start, r.target_end, filters.from ?? null, filters.to ?? null);
      })
    : rawRows;

  const truncated = dateFiltered.length > MAX;
  const visibleRows = truncated ? dateFiltered.slice(0, MAX) : dateFiltered;

  // Compute tree depth — distance from root, walking parent_initiative_id.
  // Done in JS so we don't need a recursive CTE. Built in an in-memory map
  // keyed on id to avoid O(n²) walks.
  const byId = new Map<string, RawInitiativeRow>();
  for (const r of visibleRows) byId.set(r.id, r);

  const depthCache = new Map<string, number>();
  function depthOf(id: string): number {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    const row = byId.get(id);
    if (!row) {
      // Parent isn't in the visible set (filtered out). Treat as root.
      depthCache.set(id, 0);
      return 0;
    }
    if (!row.parent_initiative_id || !byId.has(row.parent_initiative_id)) {
      depthCache.set(id, 0);
      return 0;
    }
    const d = depthOf(row.parent_initiative_id) + 1;
    depthCache.set(id, d);
    return d;
  }

  const visibleIds = new Set(visibleRows.map(r => r.id));

  // Tasks for the visible initiatives — single query, then bucketed.
  const taskRows: Array<{
    id: string;
    initiative_id: string | null;
    title: string;
    status: string;
    assigned_agent_id: string | null;
  }> = visibleIds.size === 0
    ? []
    : queryAll(
        `SELECT id, initiative_id, title, status, assigned_agent_id
         FROM tasks
         WHERE initiative_id IN (${Array.from(visibleIds).map(() => '?').join(',')})
         ORDER BY created_at`,
        Array.from(visibleIds),
      );

  // Dependencies between visible initiatives.
  const depRows: RoadmapDependency[] = visibleIds.size === 0
    ? []
    : queryAll<RoadmapDependency>(
        `SELECT id, initiative_id, depends_on_initiative_id, kind, note
         FROM initiative_dependencies
         WHERE initiative_id IN (${Array.from(visibleIds).map(() => '?').join(',')})
            OR depends_on_initiative_id IN (${Array.from(visibleIds).map(() => '?').join(',')})`,
        [...Array.from(visibleIds), ...Array.from(visibleIds)],
      );

  // task_counts per initiative_id, bucketed by status family.
  const counts: Record<string, { draft: number; active: number; done: number; total: number }> = {};
  for (const t of taskRows) {
    if (!t.initiative_id) continue;
    const c = counts[t.initiative_id] || (counts[t.initiative_id] = { draft: 0, active: 0, done: 0, total: 0 });
    c.total += 1;
    if (t.status === 'draft') c.draft += 1;
    else if (t.status === 'done') c.done += 1;
    else if (ACTIVE_STATUSES.has(t.status)) c.active += 1;
  }

  const initiatives: RoadmapInitiative[] = visibleRows.map(r => ({
    id: r.id,
    parent_initiative_id: r.parent_initiative_id,
    product_id: r.product_id,
    kind: r.kind,
    title: r.title,
    status: r.status,
    owner_agent_id: r.owner_agent_id,
    owner_agent_name: r.owner_agent_name,
    complexity: r.complexity,
    estimated_effort_hours: r.estimated_effort_hours,
    target_start: r.target_start,
    target_end: r.target_end,
    derived_start: r.derived_start,
    derived_end: r.derived_end,
    committed_end: r.committed_end,
    status_check_md: r.status_check_md,
    sort_order: r.sort_order,
    depth: depthOf(r.id),
    task_counts: counts[r.id] || { draft: 0, active: 0, done: 0, total: 0 },
  }));

  return {
    initiatives,
    dependencies: depRows,
    tasks: taskRows
      .filter((t): t is RoadmapTask => t.initiative_id != null)
      .map(t => ({
        id: t.id,
        initiative_id: t.initiative_id!,
        title: t.title,
        status: t.status,
        assigned_agent_id: t.assigned_agent_id,
      })),
    workspace_id: filters.workspace_id,
    product_id: filters.product_id ?? null,
    truncated,
  };
}
