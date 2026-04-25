/**
 * Effort sizing helpers (Phase 4).
 *
 * Spec §16 Q1 (resolved): when an initiative has no `estimated_effort_hours`
 * but does have a complexity bucket, fall back to a fixed table. Operators
 * can override this per workspace later (out of scope v1). When neither is
 * set, return null — the derivation engine excludes the initiative from
 * scheduling rather than guessing (spec §7.2 step 2).
 *
 * Containers (initiatives with descendants) get effort by summing their
 * descendants' effective effort. The container's own `estimated_effort_hours`
 * is ignored when it has children — children are the source of truth, the
 * container is just a grouping. If no descendant has any effort signal
 * either, the container is excluded from derivation.
 *
 * Pure functions only. Operate on plain RoadmapInitiative shapes; do no DB
 * work. Tests can pass mini-snapshots.
 */

import type { RoadmapInitiative, RoadmapSnapshot } from '@/lib/db/roadmap';

export const COMPLEXITY_HOURS: Record<'S' | 'M' | 'L' | 'XL', number> = {
  S: 4,
  M: 12,
  L: 40,
  XL: 120,
};

/** Subset of initiative fields the effort helpers actually need. */
export interface EffortInputs {
  estimated_effort_hours?: number | null;
  complexity?: 'S' | 'M' | 'L' | 'XL' | null;
}

/**
 * Effective effort for a leaf initiative (no children, or container with
 * its own effort declared). Returns null when no signal is available.
 */
export function getEffectiveEffortHours(initiative: EffortInputs): number | null {
  if (initiative.estimated_effort_hours != null && initiative.estimated_effort_hours > 0) {
    return initiative.estimated_effort_hours;
  }
  if (initiative.complexity) {
    return COMPLEXITY_HOURS[initiative.complexity];
  }
  return null;
}

/**
 * Roll up effort for an initiative, summing descendants' effective effort
 * when present. If the initiative has children:
 *   - Sum all descendants' `getEffectiveEffortHours`. NULL descendants
 *     contribute 0 to the sum.
 *   - If the sum is > 0, return it; otherwise fall back to the container's
 *     own `getEffectiveEffortHours` (handles the case where the container
 *     was decomposed but children have no estimates yet).
 *   - If both produce nothing, return null.
 *
 * If the initiative has no children, behave like `getEffectiveEffortHours`.
 *
 * The snapshot is used to walk the tree without DB calls — pure function.
 */
export function rollupEffort(initiativeId: string, snapshot: RoadmapSnapshot): number | null {
  const byId = new Map<string, RoadmapInitiative>();
  const byParent = new Map<string | null, RoadmapInitiative[]>();
  for (const i of snapshot.initiatives) {
    byId.set(i.id, i);
    const list = byParent.get(i.parent_initiative_id ?? null) ?? [];
    list.push(i);
    byParent.set(i.parent_initiative_id ?? null, list);
  }

  const root = byId.get(initiativeId);
  if (!root) return null;

  const children = byParent.get(initiativeId) ?? [];
  if (children.length === 0) {
    return getEffectiveEffortHours(root);
  }

  // Sum effort across the *full* descendant subtree (not just direct kids),
  // since an epic → story → substory split should still attribute substory
  // effort to the epic.
  let sum = 0;
  let any = false;
  const stack: string[] = [...children.map(c => c.id)];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const node = byId.get(cur);
    if (!node) continue;
    const grandKids = byParent.get(cur) ?? [];
    if (grandKids.length === 0) {
      // Leaf — contributes its own effective effort.
      const e = getEffectiveEffortHours(node);
      if (e != null) {
        sum += e;
        any = true;
      }
    } else {
      // Recurse into descendants. Don't double-count by also adding the
      // container's own effort.
      for (const g of grandKids) stack.push(g.id);
    }
  }

  if (any) return sum;
  // No descendant effort — fall back to the container's own signal.
  return getEffectiveEffortHours(root);
}
