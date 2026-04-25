/**
 * Drift detector (Phase 4 — spec §7.2 step 5).
 *
 * Pure function. Compares a snapshot against a derived-schedule map and
 * emits a typed list of drift events the apply step (or the future PM
 * agent) can act on.
 *
 *   milestone_at_risk   derived_end > committed_end (only on milestones)
 *   slippage            derived_end > target_end + SLIPPAGE_THRESHOLD_DAYS
 *   cycle_detected      reported once per cycle from deriveSchedule
 *   no_effort_signal    initiative excluded for missing effort, with the
 *                       nearest milestone ancestor (if any) for context
 */

import type { RoadmapInitiative, RoadmapSnapshot } from '@/lib/db/roadmap';
import type { DeriveResult } from './derive';
import { daysBetween } from './date-math';

/**
 * "A target_end < derived_end by more than this" counts as slippage. Set
 * conservatively — the engine snaps to whole days, so single-day rounding
 * shouldn't fire alerts.
 */
export const SLIPPAGE_THRESHOLD_DAYS = 3;

export type DriftEvent =
  | {
      kind: 'milestone_at_risk';
      initiative_id: string;
      committed_end: string;
      derived_end: string;
      days_over: number;
    }
  | {
      kind: 'slippage';
      initiative_id: string;
      target_end: string;
      derived_end: string;
      days_over: number;
    }
  | {
      kind: 'cycle_detected';
      initiative_ids: string[];
    }
  | {
      kind: 'no_effort_signal';
      initiative_id: string;
      ancestor_milestone_id?: string;
    };

export function detectDrift(
  snapshot: RoadmapSnapshot,
  derivedResult: DeriveResult,
): DriftEvent[] {
  const events: DriftEvent[] = [];
  const byId = new Map<string, RoadmapInitiative>();
  for (const i of snapshot.initiatives) byId.set(i.id, i);

  // Cycle detection emits one combined event so consumers don't have to
  // group by membership themselves.
  if (derivedResult.cycle.length > 0) {
    events.push({ kind: 'cycle_detected', initiative_ids: [...derivedResult.cycle] });
  }

  for (const i of snapshot.initiatives) {
    const derived = derivedResult.schedule.get(i.id);
    if (!derived) continue;

    // milestone_at_risk: only initiatives with kind='milestone' and a
    // committed_end can fire this.
    if (
      i.kind === 'milestone' &&
      i.committed_end &&
      derived.derived_end &&
      derived.derived_end > i.committed_end
    ) {
      const days = daysBetween(i.committed_end, derived.derived_end);
      if (days > 0) {
        events.push({
          kind: 'milestone_at_risk',
          initiative_id: i.id,
          committed_end: i.committed_end,
          derived_end: derived.derived_end,
          days_over: days,
        });
      }
    }

    // slippage: target_end exists and derived_end is more than threshold
    // days past it. Skip milestones — they have their own (stronger)
    // milestone_at_risk event from committed_end.
    if (
      i.kind !== 'milestone' &&
      i.target_end &&
      derived.derived_end &&
      derived.derived_end > i.target_end
    ) {
      const days = daysBetween(i.target_end, derived.derived_end);
      if (days > SLIPPAGE_THRESHOLD_DAYS) {
        events.push({
          kind: 'slippage',
          initiative_id: i.id,
          target_end: i.target_end,
          derived_end: derived.derived_end,
          days_over: days,
        });
      }
    }
  }

  // no_effort_signal: each initiative excluded because it has no effort.
  // Walk up the parent chain to the nearest milestone for context — if a
  // story has no estimate but rolls into a milestone, that milestone is
  // the operator's first stop for fixing the gap.
  const noEffortSeen = new Set(derivedResult.noEffort);
  for (const id of derivedResult.noEffort) {
    const ancestor = nearestMilestone(id, byId);
    events.push({
      kind: 'no_effort_signal',
      initiative_id: id,
      ancestor_milestone_id: ancestor ?? undefined,
    });
  }
  // Suppress unused-var warning if all noEffort fired above.
  void noEffortSeen;

  return events;
}

function nearestMilestone(
  startId: string,
  byId: Map<string, RoadmapInitiative>,
): string | null {
  let cur = byId.get(startId);
  // Don't return the start itself — we want an *ancestor*.
  if (cur?.parent_initiative_id) {
    cur = byId.get(cur.parent_initiative_id);
  } else {
    return null;
  }
  while (cur) {
    if (cur.kind === 'milestone') return cur.id;
    if (!cur.parent_initiative_id) return null;
    cur = byId.get(cur.parent_initiative_id);
  }
  return null;
}
