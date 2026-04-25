/**
 * Critical-path derivation engine (Phase 4 — spec §7.2).
 *
 * Pure function. Takes a roadmap snapshot + a per-owner velocity map, and
 * returns a Map<initiative_id, { derived_start, derived_end }>. Does no DB
 * writes — those happen in apply-derivation.ts.
 *
 * Algorithm in plain English:
 *
 *   1. Build a dependency graph using `initiative_dependencies`. Drop
 *      `informational` edges (non-blocking per spec). `start_to_start`
 *      edges block on the dependency's *start*; everything else blocks on
 *      its *end*.
 *
 *   2. Topologically sort the graph. If a cycle exists, the cycle members
 *      get NULL derived_* and the cycle is reported in the output. Other
 *      initiatives still derive normally if they don't transit through
 *      the cycle.
 *
 *   3. For each initiative in topo order:
 *        - effort = rollupEffort(i)         (sums descendants for containers)
 *        - velocity = velocityMap[owner] ?? 1.0
 *        - effective_days = ceil((effort / velocity) / HOURS_PER_DAY)
 *        - earliest_start = max(today, target_start ?? today,
 *                               max-over-deps(dep.derived_end | dep.derived_start))
 *        - derived_end = add `effective_days` business days to earliest_start
 *          (skipping weekends, ignoring public holidays — out of scope v1)
 *        - subtract owner availability windows: shift derived_end later by
 *          the count of business days the schedule [start, end] overlaps
 *          any unavailable window.
 *
 *   4. Initiatives whose effort is null (no signal, no descendant signal)
 *      get NULL derived_*. Don't guess — let the operator notice the gap.
 *
 * Determinism: given identical (snapshot, velocityMap, today) inputs, this
 * function produces identical output. No `new Date()` calls inside — pass
 * `today` explicitly.
 */

import type {
  RoadmapDependency,
  RoadmapInitiative,
  RoadmapOwnerAvailability,
  RoadmapSnapshot,
} from '@/lib/db/roadmap';
import { addDays, toIsoDay, toUtcDay } from './date-math';
import { rollupEffort } from './effort';

/**
 * Hours-per-workday assumption. 6 hours of focused work is the planning
 * heuristic from the spec. If estimates are quoted in "ideal hours" they
 * track real wall-clock days closely.
 */
export const HOURS_PER_DAY = 6;

export interface DerivedRange {
  derived_start: string | null;
  derived_end: string | null;
}

export interface DeriveOptions {
  /**
   * Per-owner velocity ratio. Owners not in the map fall back to 1.0
   * (no adjustment). Use `getVelocityRatio` to compute these from history.
   */
  velocityMap?: Map<string, number>;
  /**
   * The "today" anchor. Defaults to "now". Pass an explicit date in tests
   * for deterministic output.
   */
  today?: Date | string;
}

export interface DeriveResult {
  /** id → { derived_start, derived_end } (both ISO YYYY-MM-DD or null). */
  schedule: Map<string, DerivedRange>;
  /** Initiative ids belonging to a detected cycle, in arbitrary order. */
  cycle: string[];
  /** Initiative ids excluded because no effort signal was available. */
  noEffort: string[];
  /** Diagnostic warnings emitted during the run. */
  warnings: string[];
}

/**
 * Main entrypoint. See module header for algorithm.
 */
export function deriveSchedule(snapshot: RoadmapSnapshot, opts: DeriveOptions = {}): DeriveResult {
  const today = toUtcDay(opts.today ?? new Date());
  const velocityMap = opts.velocityMap ?? new Map<string, number>();

  // Index initiatives.
  const byId = new Map<string, RoadmapInitiative>();
  for (const i of snapshot.initiatives) byId.set(i.id, i);

  // Group availability by owner for quick lookup.
  const availByAgent = new Map<string, RoadmapOwnerAvailability[]>();
  for (const a of snapshot.owner_availability ?? []) {
    const list = availByAgent.get(a.agent_id) ?? [];
    list.push(a);
    availByAgent.set(a.agent_id, list);
  }

  // Dependency edges (filtered to blocking kinds) keyed by from-initiative
  // (the dependent). We also need the reverse map for the topo sort.
  const blockingEdges: RoadmapDependency[] = (snapshot.dependencies ?? []).filter(
    d => d.kind !== 'informational',
  );

  // adjacency: dep -> dependents (the initiative that depends on this one
  //                              comes after in topo order)
  const out: Map<string, string[]> = new Map();
  // reverse adjacency: dependent -> deps it waits for
  const inEdges: Map<string, RoadmapDependency[]> = new Map();
  // in-degree counter for Kahn's algorithm
  const inDegree: Map<string, number> = new Map();

  for (const i of snapshot.initiatives) {
    inDegree.set(i.id, 0);
  }
  for (const e of blockingEdges) {
    if (!byId.has(e.initiative_id) || !byId.has(e.depends_on_initiative_id)) continue;
    const outs = out.get(e.depends_on_initiative_id) ?? [];
    outs.push(e.initiative_id);
    out.set(e.depends_on_initiative_id, outs);

    const ins = inEdges.get(e.initiative_id) ?? [];
    ins.push(e);
    inEdges.set(e.initiative_id, ins);

    inDegree.set(e.initiative_id, (inDegree.get(e.initiative_id) ?? 0) + 1);
  }

  // Kahn's topological sort. Sort the queue by id at insertion to keep
  // determinism across runs (Map iteration order is insertion order, which
  // depends on input shape; explicitly sorting removes that dependence).
  const queue: string[] = [];
  for (const [id, n] of inDegree.entries()) {
    if (n === 0) queue.push(id);
  }
  queue.sort();
  const topoOrder: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    topoOrder.push(id);
    const outs = out.get(id) ?? [];
    for (const next of outs) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) {
        // Insert sorted to keep determinism.
        let i = 0;
        while (i < queue.length && queue[i] < next) i++;
        queue.splice(i, 0, next);
      }
    }
  }

  // Anything left with in-degree > 0 is in a cycle.
  const cycle: string[] = [];
  for (const [id, n] of inDegree.entries()) {
    if (n > 0) cycle.push(id);
  }
  cycle.sort();

  const warnings: string[] = [];
  if (cycle.length > 0) {
    warnings.push(`Cycle detected among ${cycle.length} initiative(s): ${cycle.join(', ')}`);
  }

  // Compute schedule for non-cycle initiatives in topo order.
  const schedule = new Map<string, DerivedRange>();
  const noEffort: string[] = [];

  // Initialize cycle members to null up front so deps that reference them
  // can be skipped without crashing.
  for (const id of cycle) {
    schedule.set(id, { derived_start: null, derived_end: null });
  }

  for (const id of topoOrder) {
    const init = byId.get(id);
    if (!init) continue;

    const effort = rollupEffort(id, snapshot);
    if (effort == null) {
      schedule.set(id, { derived_start: null, derived_end: null });
      noEffort.push(id);
      continue;
    }

    const velocity = (init.owner_agent_id && velocityMap.get(init.owner_agent_id)) || 1.0;
    const adjustedHours = effort / velocity;
    const effectiveDays = Math.max(1, Math.ceil(adjustedHours / HOURS_PER_DAY));

    // Earliest start: max(today, target_start, max over deps).
    const candidates: Date[] = [today];
    if (init.target_start) {
      try {
        candidates.push(toUtcDay(init.target_start));
      } catch {
        warnings.push(`Initiative ${id}: invalid target_start "${init.target_start}", ignoring`);
      }
    }
    const deps = inEdges.get(id) ?? [];
    let depBlocked = false;
    for (const dep of deps) {
      const depRange = schedule.get(dep.depends_on_initiative_id);
      if (!depRange) continue;
      // start_to_start: the dependent can begin when the prereq begins.
      // finish_to_start / blocking: the dependent must wait for prereq end.
      const anchor =
        dep.kind === 'start_to_start' ? depRange.derived_start : depRange.derived_end;
      if (anchor == null) {
        // The prereq has no derived schedule. Block this initiative's
        // schedule too — we don't know when the prereq actually finishes.
        depBlocked = true;
        break;
      }
      try {
        // For finish-to-start we start the day AFTER the prereq ends.
        const offset = dep.kind === 'start_to_start' ? 0 : 1;
        candidates.push(addDays(anchor, offset));
      } catch {
        // Bad ISO string in DB; skip this dep.
      }
    }
    if (depBlocked) {
      schedule.set(id, { derived_start: null, derived_end: null });
      continue;
    }

    let start = maxDate(candidates);
    start = nextBusinessDay(start);

    // Walk forward day-by-day from `start`, counting only business days
    // that are NOT inside any owner-availability window. End the schedule
    // when we've accumulated `effectiveDays` working days. This naturally
    // pushes the end past unavailable windows by exactly the number of
    // business days they consume — no fixed-point iteration needed.
    const ownerAvail = init.owner_agent_id
      ? availByAgent.get(init.owner_agent_id) ?? []
      : [];

    let end = start;
    let workdaysAccumulated = 0;
    let safety = 365 * 2; // bounded — a 2-year schedule is the cap
    let cursor = start;
    while (safety-- > 0) {
      if (!isWeekend(cursor) && !isAvailableBlocked(cursor, ownerAvail)) {
        workdaysAccumulated++;
        end = cursor;
        if (workdaysAccumulated >= effectiveDays) break;
      }
      cursor = addDays(cursor, 1);
    }

    // If `start` itself was inside an availability window, slide it forward
    // to the first usable day.
    let realStart = start;
    let s2 = 60;
    while (s2-- > 0 && (isWeekend(realStart) || isAvailableBlocked(realStart, ownerAvail))) {
      realStart = addDays(realStart, 1);
    }

    schedule.set(id, {
      derived_start: toIsoDay(realStart),
      derived_end: toIsoDay(end),
    });
  }

  // Initiatives that weren't visited (e.g. cycle members already set, or
  // input snapshot included an id not in inDegree somehow) — fill with
  // explicit nulls for stability.
  for (const i of snapshot.initiatives) {
    if (!schedule.has(i.id)) {
      schedule.set(i.id, { derived_start: null, derived_end: null });
    }
  }

  return { schedule, cycle, noEffort, warnings };
}

// ─── helpers ──────────────────────────────────────────────────────

function maxDate(dates: Date[]): Date {
  let m = dates[0];
  for (let i = 1; i < dates.length; i++) {
    if (dates[i].getTime() > m.getTime()) m = dates[i];
  }
  return m;
}

/** True when `d` (UTC) is Sat (6) or Sun (0). */
function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/** Roll forward to the next non-weekend day (or `d` itself if it already is). */
function nextBusinessDay(d: Date): Date {
  let cur = toUtcDay(d);
  while (isWeekend(cur)) cur = addDays(cur, 1);
  return cur;
}

/** True if `day` falls inside any of the unavailable windows (inclusive). */
function isAvailableBlocked(day: Date, windows: RoadmapOwnerAvailability[]): boolean {
  if (windows.length === 0) return false;
  const t = day.getTime();
  for (const w of windows) {
    let ws: number, we: number;
    try {
      ws = toUtcDay(w.unavailable_start).getTime();
      we = toUtcDay(w.unavailable_end).getTime();
    } catch {
      continue;
    }
    if (t >= ws && t <= we) return true;
  }
  return false;
}

