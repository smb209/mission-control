/**
 * Velocity model (Phase 4).
 *
 * Per spec §7.2, the derivation engine multiplies effort by a per-owner
 * velocity ratio so historically-slow owners get longer schedules and
 * historically-fast owners get shorter ones.
 *
 * "Velocity" here is the ratio of *expected* to *actual* work — values > 1
 * mean the owner finishes faster than estimated, values < 1 mean slower.
 * The engine divides effort by this ratio: `effective = effort / velocity`.
 *
 * Signal sources, in priority order:
 *
 *   1. cost ratio: `actual_cost_usd / estimated_cost_usd` per completed task.
 *      Cost is the closest proxy we have — Mission Control tracks LLM cost
 *      per task but not effort hours. Underspend (actual < estimated) means
 *      the task ran cheaper than planned, which usually means it finished
 *      faster than planned, so velocity = estimated / actual (inverted).
 *
 *   2. wall-clock: `(updated_at - created_at) hours` against an expected
 *      duration derived from complexity (when present on the linked
 *      initiative or task). Used when only one or neither cost field is set.
 *      We deliberately don't try to be clever about idle time — wall-clock
 *      is noisy but stable, and the average of many noisy samples lands
 *      somewhere reasonable.
 *
 *   3. Default 1.0 — no history, no adjustment.
 *
 * The output is clamped to [0.1, 10.0] to keep the engine stable. A team
 * that spent 100x its budget on one task shouldn't make every future task
 * stretch by 100x.
 *
 * Pure-ish: the *core* `computeVelocityFromTasks` is pure (takes rows in,
 * returns a number). `getVelocityRatio` is the DB-using wrapper — the
 * engine should pass the *ratio* (a number) into deriveSchedule, never the
 * helper itself, to keep deriveSchedule deterministic.
 */

import { queryAll } from '@/lib/db';

const MIN_RATIO = 0.1;
const MAX_RATIO = 10.0;
const DEFAULT_SINCE_DAYS = 90;

/**
 * Sample row consumed by `computeVelocityFromTasks`. Plain TS types so the
 * pure function is easy to test without a DB.
 */
export interface VelocitySampleTask {
  estimated_cost_usd?: number | null;
  actual_cost_usd?: number | null;
  /** Used by the wall-clock fallback. Both ISO timestamps. */
  created_at?: string | null;
  updated_at?: string | null;
  /** Used to derive an expected duration when only wall-clock is available. */
  complexity?: 'S' | 'M' | 'L' | 'XL' | null;
}

/**
 * Average ratio across the input rows. Each row contributes one sample if
 * it has usable signal; rows with no signal are skipped. If no row
 * contributes, returns 1.0 (default).
 */
export function computeVelocityFromTasks(tasks: VelocitySampleTask[]): number {
  const samples: number[] = [];

  for (const t of tasks) {
    const sample = sampleVelocity(t);
    if (sample != null) samples.push(sample);
  }

  if (samples.length === 0) return 1.0;
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return clampRatio(avg);
}

/**
 * Single-task ratio. Returns null when the task offers no usable signal.
 *
 * Cost ratio:
 *   ratio = estimated / actual          (so under-spend → > 1.0 = fast)
 *
 * Wall-clock fallback (no cost data):
 *   expected_hours = COMPLEXITY_HOURS[complexity]
 *   actual_hours = (updated_at - created_at) hours
 *   ratio = expected / actual
 *
 * Both formulas produce a number in the same direction: > 1.0 means faster
 * than expected, < 1.0 means slower.
 */
function sampleVelocity(t: VelocitySampleTask): number | null {
  const est = t.estimated_cost_usd;
  const act = t.actual_cost_usd;
  if (est != null && est > 0 && act != null && act > 0) {
    return est / act;
  }

  // Wall-clock fallback. Need both timestamps and a complexity bucket so we
  // know what "expected" duration is. Without complexity, wall-clock is
  // un-anchored and gives no useful ratio.
  if (t.complexity && t.created_at && t.updated_at) {
    const start = new Date(t.created_at).getTime();
    const end = new Date(t.updated_at).getTime();
    if (!isFinite(start) || !isFinite(end) || end <= start) return null;
    const actualHours = (end - start) / (1000 * 60 * 60);
    if (actualHours <= 0) return null;
    const expectedHours = COMPLEXITY_HOURS[t.complexity];
    return expectedHours / actualHours;
  }

  return null;
}

/** Mirror of effort.ts COMPLEXITY_HOURS — kept local so velocity.ts has no
 *  cross-file deps and the two tables can drift independently if a future
 *  spec change splits them. */
const COMPLEXITY_HOURS: Record<'S' | 'M' | 'L' | 'XL', number> = {
  S: 4,
  M: 12,
  L: 40,
  XL: 120,
};

function clampRatio(r: number): number {
  if (!isFinite(r) || r <= 0) return 1.0;
  if (r < MIN_RATIO) return MIN_RATIO;
  if (r > MAX_RATIO) return MAX_RATIO;
  return r;
}

export interface ComputeVelocityOptions {
  owner_agent_id: string;
  /** Look back this many days. Default 90. */
  since_days?: number;
}

/**
 * DB-using helper: pull recent completed tasks for the owner and compute.
 * Used by `applyDerivation` to populate a per-owner ratio map before
 * calling the (pure) derive function.
 */
export function computeVelocity(opts: ComputeVelocityOptions): number {
  const since = opts.since_days ?? DEFAULT_SINCE_DAYS;
  const cutoff = new Date(Date.now() - since * 24 * 60 * 60 * 1000).toISOString();

  // Tasks the agent worked on (assigned to them) and completed since cutoff.
  const rows = queryAll<VelocitySampleTask>(
    `SELECT estimated_cost_usd, actual_cost_usd, created_at, updated_at
     FROM tasks
     WHERE assigned_agent_id = ?
       AND status = 'done'
       AND updated_at >= ?`,
    [opts.owner_agent_id, cutoff],
  );

  // Tasks don't carry their own complexity field — pull it from the linked
  // initiative, when present, in a second pass. Cost-based samples don't
  // need it, so we only join when the cost fields are missing.
  // For simplicity (and to keep this query cheap), we fetch all completed
  // tasks for the owner that have an initiative_id and pull initiative
  // complexity in one shot.
  const augmented = queryAll<VelocitySampleTask & { initiative_id: string | null }>(
    `SELECT t.estimated_cost_usd, t.actual_cost_usd, t.created_at, t.updated_at,
            t.initiative_id, i.complexity AS complexity
     FROM tasks t
     LEFT JOIN initiatives i ON i.id = t.initiative_id
     WHERE t.assigned_agent_id = ?
       AND t.status = 'done'
       AND t.updated_at >= ?`,
    [opts.owner_agent_id, cutoff],
  );

  // Prefer the augmented rows (they include complexity). The first query is
  // kept around so the helper still works in unit tests where the join
  // returns nothing — but in practice `augmented` is a strict superset.
  const samples = augmented.length > 0 ? augmented : rows;
  return computeVelocityFromTasks(samples);
}

/**
 * Convenience wrapper: returns the ratio, clamped, with the default since
 * window. Provided so callers reading the spec verbatim ("getVelocityRatio")
 * have the function name they expect.
 */
export function getVelocityRatio(owner_agent_id: string): number {
  return computeVelocity({ owner_agent_id });
}
