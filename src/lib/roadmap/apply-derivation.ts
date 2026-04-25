/**
 * Apply derivation (Phase 4).
 *
 * Glue layer between the pure engine (`deriveSchedule`) and the database.
 * Responsibilities:
 *
 *   1. Pull a fresh snapshot via `getRoadmapSnapshot`.
 *   2. Compute per-owner velocity ratios from completed-task history.
 *   3. Run `deriveSchedule` to get the new (derived_start, derived_end) per
 *      initiative.
 *   4. UPDATE only the rows whose dates actually changed (idempotency: a
 *      no-op run touches no rows).
 *   5. For initiatives flagged `milestone_at_risk` whose status is
 *      currently `planned` or `in_progress`, set `status='at_risk'`. Don't
 *      override `cancelled`, `done`, or `blocked` — those are stronger
 *      operator-set states.
 *   6. Emit one `events` row summarizing the run.
 *
 * Single transaction wraps steps 4–6 so a partial failure doesn't leave
 * the schedule half-updated.
 *
 * Returns the drift list and update counts so callers (manual recompute
 * endpoint, schedule cron) can surface results to the operator.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb, queryAll } from '@/lib/db';
import {
  getRoadmapSnapshot,
  type RoadmapSnapshot,
  type RoadmapOwnerAvailability,
} from '@/lib/db/roadmap';
import { deriveSchedule, type DeriveResult } from './derive';
import { detectDrift, type DriftEvent } from './drift';
import { computeVelocity } from './velocity';

export interface ApplyDerivationResult {
  workspace_id: string;
  initiatives_scanned: number;
  initiatives_updated: number;
  status_flips: number;
  drifts: DriftEvent[];
  cycle: string[];
  warnings: string[];
}

export interface ApplyDerivationOptions {
  /** Anchor for the engine. Defaults to current date. */
  today?: Date | string;
  /**
   * Override the velocity map (used by tests). When undefined, the helper
   * computes ratios from each unique owner's completed-task history.
   */
  velocityMap?: Map<string, number>;
  /** Pre-fetched snapshot (used by tests to avoid re-querying). */
  snapshot?: RoadmapSnapshot;
}

export function applyDerivation(
  workspace_id: string,
  opts: ApplyDerivationOptions = {},
): ApplyDerivationResult {
  const snapshot = opts.snapshot ?? getRoadmapSnapshot({ workspace_id });
  const { derived } = computeDerivedSchedule(snapshot, {
    today: opts.today,
    velocityMap: opts.velocityMap,
  });

  const drifts = detectDrift(snapshot, derived);

  // Determine which rows actually need an UPDATE (only on diff). Spec
  // requires idempotency — a re-run with no changes mustn't bump
  // `updated_at` either.
  const updates: Array<{ id: string; start: string | null; end: string | null }> = [];
  for (const i of snapshot.initiatives) {
    const range = derived.schedule.get(i.id);
    if (!range) continue;
    if (range.derived_start !== i.derived_start || range.derived_end !== i.derived_end) {
      updates.push({ id: i.id, start: range.derived_start, end: range.derived_end });
    }
  }

  // Status flips: milestone_at_risk events on initiatives whose status is
  // currently `planned` or `in_progress`. We DON'T flip `done`, `cancelled`,
  // or `blocked` — those are stronger operator decisions.
  const flipIds: string[] = [];
  for (const ev of drifts) {
    if (ev.kind !== 'milestone_at_risk') continue;
    const i = snapshot.initiatives.find(x => x.id === ev.initiative_id);
    if (!i) continue;
    if (i.status === 'planned' || i.status === 'in_progress') {
      flipIds.push(ev.initiative_id);
    }
  }

  const db = getDb();
  let initiativesUpdated = 0;
  let statusFlips = 0;

  db.transaction(() => {
    const stmt = db.prepare(
      'UPDATE initiatives SET derived_start = ?, derived_end = ?, updated_at = ? WHERE id = ?',
    );
    const now = new Date().toISOString();
    for (const u of updates) {
      const r = stmt.run(u.start, u.end, now, u.id);
      if (r.changes > 0) initiativesUpdated++;
    }

    if (flipIds.length > 0) {
      const flipStmt = db.prepare(
        `UPDATE initiatives SET status = 'at_risk', updated_at = ? WHERE id = ? AND status IN ('planned','in_progress')`,
      );
      for (const id of flipIds) {
        const r = flipStmt.run(now, id);
        if (r.changes > 0) statusFlips++;
      }
    }

    // Emit a single summary event row (only when something happened, to
    // avoid spamming the live feed for nightly no-op runs).
    if (initiativesUpdated > 0 || statusFlips > 0 || drifts.length > 0) {
      db.prepare(
        `INSERT INTO events (id, type, message, metadata, created_at)
         VALUES (?, 'roadmap_drift_scan', ?, ?, ?)`,
      ).run(
        uuidv4(),
        `Roadmap drift scan: ${initiativesUpdated} updated, ${drifts.length} drift event(s)`,
        JSON.stringify({
          workspace_id,
          initiatives_scanned: snapshot.initiatives.length,
          initiatives_updated: initiativesUpdated,
          status_flips: statusFlips,
          drifts,
          cycle: derived.cycle,
          warnings: derived.warnings,
        }),
        now,
      );
    }
  })();

  return {
    workspace_id,
    initiatives_scanned: snapshot.initiatives.length,
    initiatives_updated: initiativesUpdated,
    status_flips: statusFlips,
    drifts,
    cycle: derived.cycle,
    warnings: derived.warnings,
  };
}

/**
 * Returns a list of workspace_ids that have at least one initiative — the
 * scheduler iterates over these on each `roadmap_drift_scan` tick.
 */
export function listWorkspacesWithInitiatives(): string[] {
  return queryAll<{ workspace_id: string }>(
    'SELECT DISTINCT workspace_id FROM initiatives',
  ).map(r => r.workspace_id);
}

// ─── Preview helpers (Phase 5) ──────────────────────────────────────

export interface PreviewDerivationOptions {
  today?: Date | string;
  velocityMap?: Map<string, number>;
  /**
   * Override velocity for specific owners on top of (or in place of) the
   * computed velocity map. Useful for "if Sarah were 50% slower" what-ifs.
   */
  velocityOverrides?: Record<string, number>;
  /**
   * Extra availability rows to layer on top of the snapshot's existing
   * rows. Each row is treated identically to a real DB row by the
   * derivation engine — same overlap math, same effort calendar push.
   * IDs are auto-generated if missing.
   */
  availabilityOverrides?: Array<Omit<RoadmapOwnerAvailability, 'id'> & { id?: string }>;
}

export interface PreviewDerivationResult {
  derived: DeriveResult;
  drifts: DriftEvent[];
  /**
   * Per-initiative diff vs the snapshot's currently-stored derived_*
   * fields. Empty when nothing would change.
   */
  diffs: Array<{
    initiative_id: string;
    title: string;
    before: { derived_start: string | null; derived_end: string | null };
    after: { derived_start: string | null; derived_end: string | null };
  }>;
}

/**
 * Pure compute step: build the velocity map (computed + overrides) and run
 * `deriveSchedule`. Shared between `applyDerivation` and `previewDerivation`
 * so both honour the same precedence rules.
 *
 * Precedence: `opts.velocityMap` (if explicitly passed) wins as the base;
 * otherwise we compute per-owner from history. `opts.velocityOverrides`
 * are applied last and override either base.
 */
function computeDerivedSchedule(
  snapshot: RoadmapSnapshot,
  opts: { today?: Date | string; velocityMap?: Map<string, number>; velocityOverrides?: Record<string, number> },
): { derived: DeriveResult; velocityMap: Map<string, number> } {
  let velocityMap = opts.velocityMap;
  if (!velocityMap) {
    velocityMap = new Map<string, number>();
    const owners = new Set<string>();
    for (const i of snapshot.initiatives) {
      if (i.owner_agent_id) owners.add(i.owner_agent_id);
    }
    for (const owner of owners) {
      velocityMap.set(owner, computeVelocity({ owner_agent_id: owner }));
    }
  } else {
    // Clone so we don't mutate the caller's map when applying overrides.
    velocityMap = new Map(velocityMap);
  }
  if (opts.velocityOverrides) {
    for (const [owner, ratio] of Object.entries(opts.velocityOverrides)) {
      velocityMap.set(owner, ratio);
    }
  }
  const derived = deriveSchedule(snapshot, { velocityMap, today: opts.today });
  return { derived, velocityMap };
}

/**
 * What-if derivation: compute the schedule WITHOUT writing anything to the
 * database. Used by:
 *
 *   - The PM agent ("if Sarah is out, what slips?") via the
 *     `preview_derivation` MCP tool.
 *   - The /api/roadmap/recompute endpoint (Phase 4 follow-up) when the
 *     caller passes `?dry=1`.
 *
 * Layers `availabilityOverrides` on top of the snapshot's rows and applies
 * `velocityOverrides` on top of the computed/passed velocity map.
 *
 * Returns the full `DeriveResult`, the would-be drift events, and a
 * before-vs-after diff list for direct UI rendering.
 */
export function previewDerivation(
  snapshot: RoadmapSnapshot,
  opts: PreviewDerivationOptions = {},
): PreviewDerivationResult {
  // Layer availability overrides. We don't mutate the caller's snapshot;
  // we shallow-clone the array.
  const extraAvail: RoadmapOwnerAvailability[] = (opts.availabilityOverrides ?? []).map(
    (a, idx) => ({
      id: a.id ?? `__preview_${idx}`,
      agent_id: a.agent_id,
      unavailable_start: a.unavailable_start,
      unavailable_end: a.unavailable_end,
      reason: a.reason ?? null,
    }),
  );
  const previewSnapshot: RoadmapSnapshot = {
    ...snapshot,
    owner_availability: [...(snapshot.owner_availability ?? []), ...extraAvail],
  };

  const { derived } = computeDerivedSchedule(previewSnapshot, {
    today: opts.today,
    velocityOverrides: opts.velocityOverrides,
  });

  const drifts = detectDrift(previewSnapshot, derived);

  const diffs: PreviewDerivationResult['diffs'] = [];
  for (const i of snapshot.initiatives) {
    const range = derived.schedule.get(i.id);
    if (!range) continue;
    if (range.derived_start !== i.derived_start || range.derived_end !== i.derived_end) {
      diffs.push({
        initiative_id: i.id,
        title: i.title,
        before: { derived_start: i.derived_start, derived_end: i.derived_end },
        after: { derived_start: range.derived_start, derived_end: range.derived_end },
      });
    }
  }

  return { derived, drifts, diffs };
}
