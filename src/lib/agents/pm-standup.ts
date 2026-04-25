/**
 * Proactive PM standup synthesizer (Phase 6 of the roadmap & PM-agent feature).
 *
 * Phase 5 wired the PM's *reactive* path (operator drops a disruption →
 * `dispatchPm` → proposal). Phase 6 adds the *proactive* path: a scheduled
 * scan that posts a "morning standup" proposal whenever the roadmap is
 * drifting in ways the operator should look at.
 *
 * Drift sources we surface (per spec §14, with thresholds documented inline):
 *
 *   1. Milestones with `derived_end > committed_end` — we propose
 *      `set_initiative_status='at_risk'` (only when not already at_risk),
 *      and a `shift_initiative_target` if the gap is wide enough that the
 *      operator likely wants to move the target.
 *   2. Initiatives with `derived_end > target_end + SLIPPAGE_THRESHOLD_DAYS`
 *      (3 days) — same treatment.
 *   3. Blocked initiatives that haven't moved (no recent updated_at change)
 *      — `update_status_check` suggesting the operator chase the blocker.
 *   4. Cycles in the dependency graph — surfaced in `impact_md` only;
 *      we don't generate shift diffs because the dates are NULL inside
 *      a cycle (engine breaks them).
 *   5. Stale in-progress tasks — initiatives with `status='in_progress'`
 *      whose tasks haven't been updated in N days. `update_status_check`
 *      suggesting a quick check-in.
 *
 * Determinism: given the same DB state and `today` anchor, this synthesizer
 * produces the same proposed_changes in the same order. That makes the
 * tests tractable and lets the operator compare Tuesday's proposal against
 * Monday's to see what shifted overnight.
 *
 * Idempotency: we refuse to create a second standup proposal in the same
 * UTC day for the same workspace — see `findExistingStandupToday`. Phase 4
 * already debounces derived_* writes; this is the matching debounce on the
 * proposal layer so a re-run of `checkAndRunDueSchedules` doesn't post
 * duplicate cards.
 *
 * No-drift behaviour: when nothing crosses any threshold we DO NOT create a
 * proposal — we instead emit one `events` row with `type='pm_standup_skipped'`
 * so the operator can see the PM ran but had nothing to say. Quiet PM is
 * better than spammy PM (the operator's chat shouldn't fill up with empty
 * cards every morning).
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb, queryAll, queryOne } from '@/lib/db';
import {
  getRoadmapSnapshot,
  type RoadmapSnapshot,
  type RoadmapInitiative,
} from '@/lib/db/roadmap';
import { previewDerivation } from '@/lib/roadmap/apply-derivation';
import { SLIPPAGE_THRESHOLD_DAYS } from '@/lib/roadmap/drift';
import { daysBetween } from '@/lib/roadmap/date-math';
import {
  createProposal,
  getProposal,
  type PmDiff,
  type PmProposal,
} from '@/lib/db/pm-proposals';
import { postPmChatMessage } from './pm-dispatch';

/**
 * Minimum gap (days) before we propose moving a target_end. Below this, we
 * only flip status to at_risk — the operator can absorb a couple-day slip
 * without re-publishing a target.
 */
const TARGET_SHIFT_THRESHOLD_DAYS = 5;

/**
 * Number of days a `status='in_progress'` initiative's tasks must have been
 * idle (no `updated_at` change) before we flag it as stale work.
 */
const STALE_TASK_DAYS = 7;

/**
 * Number of days a `status='blocked'` initiative must have sat untouched
 * before we suggest the operator chase the blocker.
 */
const STALE_BLOCKED_DAYS = 3;

export interface GenerateStandupInput {
  workspace_id: string;
  /** Anchor — defaults to current time. Tests pass a fixed date. */
  today?: Date | string;
  /**
   * When set, force-create the proposal even if one already exists today.
   * Used by the manual `POST /api/pm/standup` endpoint when the operator
   * explicitly clicks "Run standup now". The schedule path leaves this
   * undefined to honour idempotency.
   */
  force?: boolean;
}

export interface GenerateStandupResult {
  /** The new (or existing, if `force=false`) proposal — null when skipped. */
  proposal: PmProposal | null;
  /** Reason returned to the caller when no proposal was created. */
  skipped_reason:
    | null
    | 'no_drift'
    | 'already_today';
  /** Number of drift signals detected (whether or not a proposal was made). */
  drift_count: number;
}

/**
 * Generate today's standup proposal for `workspace_id`.
 *
 * Returns `proposal: null` and a non-null `skipped_reason` when nothing was
 * created. The caller (schedule handler / manual route) can show the
 * operator why.
 */
export function generateStandup(input: GenerateStandupInput): GenerateStandupResult {
  const today = normalizeToday(input.today);
  const todayIso = isoDate(today);

  // 1. Idempotency check (unless force=true). We use the events table — the
  //    most recent pm_standup_generated event for this workspace within
  //    the same UTC day is the signal. Cheap and self-cleaning.
  if (!input.force) {
    const existing = findExistingStandupToday(input.workspace_id, todayIso);
    if (existing) {
      return {
        proposal: existing,
        skipped_reason: 'already_today',
        drift_count: 0,
      };
    }
  }

  // 2. Pull a fresh snapshot. Phase 4's drift-scan handler runs
  //    `applyDerivation` BEFORE this — so derived_* fields are current.
  //    We then run `previewDerivation` (without overrides) to recompute
  //    the schedule from scratch and detect drift events the same way the
  //    drift-scan does, so the standup is robust even when called outside
  //    the scheduled flow.
  const snapshot = getRoadmapSnapshot({ workspace_id: input.workspace_id });
  const preview = previewDerivation(snapshot, { today });

  // 3. Detect drift signals using the snapshot + preview. Each signal
  //    becomes zero-or-more PmDiff entries plus a bullet line.
  const detection = detectStandupSignals(snapshot, preview, today);

  // 4. No drift → emit skipped event, return null.
  if (detection.signals.length === 0) {
    emitEvent({
      type: 'pm_standup_skipped',
      workspace_id: input.workspace_id,
      message: 'PM standup: no drift detected — quiet morning',
      metadata: {
        workspace_id: input.workspace_id,
        date: todayIso,
        initiatives_scanned: snapshot.initiatives.length,
      },
    });
    return { proposal: null, skipped_reason: 'no_drift', drift_count: 0 };
  }

  // 5. Build the proposal.
  const triggerText = `Daily roadmap standup — automated drift scan (${todayIso})`;
  const impactMd = composeImpactMd(detection, todayIso);

  const proposal = createProposal({
    workspace_id: input.workspace_id,
    trigger_text: triggerText,
    trigger_kind: 'scheduled_drift_scan',
    impact_md: impactMd,
    proposed_changes: detection.changes,
  });

  // 6. Best-effort: post into the PM chat thread so the operator sees the
  //    new card immediately. Same mechanism as Phase 5's reactive path.
  try {
    postPmChatMessage({
      workspace_id: input.workspace_id,
      content: impactMd,
      proposal_id: proposal.id,
      role: 'assistant',
    });
  } catch (err) {
    console.warn('[pm-standup] chat insert failed:', (err as Error).message);
  }

  // 7. Emit the generated event so the live feed shows the standup landed.
  emitEvent({
    type: 'pm_standup_generated',
    workspace_id: input.workspace_id,
    message: `PM standup posted: ${detection.changes.length} change${detection.changes.length === 1 ? '' : 's'} proposed`,
    metadata: {
      workspace_id: input.workspace_id,
      proposal_id: proposal.id,
      date: todayIso,
      drift_count: detection.signals.length,
      change_kinds: detection.changes.map(c => c.kind),
    },
  });

  return {
    proposal,
    skipped_reason: null,
    drift_count: detection.signals.length,
  };
}

// ─── Detection ──────────────────────────────────────────────────────

interface StandupDetection {
  signals: StandupSignal[];
  changes: PmDiff[];
  bullets: string[];
  /** Cycle membership pulled out so impact_md can flag it specifically. */
  cycle_initiative_ids: string[];
}

type StandupSignal =
  | {
      kind: 'milestone_at_risk';
      initiative: RoadmapInitiative;
      derived_end: string;
      committed_end: string;
      days_over: number;
    }
  | {
      kind: 'slippage';
      initiative: RoadmapInitiative;
      derived_end: string;
      target_end: string;
      days_over: number;
    }
  | {
      kind: 'stale_blocked';
      initiative: RoadmapInitiative;
      days_idle: number;
    }
  | {
      kind: 'stale_in_progress';
      initiative: RoadmapInitiative;
      days_idle: number;
      task_count: number;
    }
  | {
      kind: 'cycle_detected';
      initiative_ids: string[];
    };

/**
 * Pure-ish signal detection. Reads:
 *   - snapshot (initiatives, dependencies, tasks)
 *   - preview (the just-recomputed schedule + drifts)
 *
 * Hits the DB once for stale-task data (initiative_id → max(task.updated_at)).
 * Returns ordered signals + matching diffs + bullets — order is stable (sort
 * by initiative.id within each category) so two runs against the same
 * snapshot produce identical proposals.
 */
function detectStandupSignals(
  snapshot: RoadmapSnapshot,
  preview: ReturnType<typeof previewDerivation>,
  today: Date,
): StandupDetection {
  const signals: StandupSignal[] = [];
  const changes: PmDiff[] = [];
  const bullets: string[] = [];
  const initiativesById = new Map<string, RoadmapInitiative>();
  for (const i of snapshot.initiatives) initiativesById.set(i.id, i);

  // Track which initiatives are inside a cycle so we don't propose date
  // shifts for them (their derived_* are NULL).
  const cycleSet = new Set<string>(preview.derived.cycle);

  // 1. milestone_at_risk + slippage from preview.drifts.
  // Sort drift events deterministically (by initiative_id then kind).
  const sortedDrifts = [...preview.drifts].sort((a, b) => {
    const aKey = `${'initiative_id' in a ? a.initiative_id : ''}__${a.kind}`;
    const bKey = `${'initiative_id' in b ? b.initiative_id : ''}__${b.kind}`;
    return aKey.localeCompare(bKey);
  });

  for (const drift of sortedDrifts) {
    if (drift.kind === 'milestone_at_risk') {
      const init = initiativesById.get(drift.initiative_id);
      if (!init) continue;
      signals.push({
        kind: 'milestone_at_risk',
        initiative: init,
        derived_end: drift.derived_end,
        committed_end: drift.committed_end,
        days_over: drift.days_over,
      });
      // Flip to at_risk only when not already at_risk/blocked/cancelled/done.
      if (init.status === 'planned' || init.status === 'in_progress') {
        changes.push({
          kind: 'set_initiative_status',
          initiative_id: init.id,
          status: 'at_risk',
        });
      }
      // Suggest moving the committed_end via target_end shift only when the
      // gap is large enough that the operator likely wants to re-publish.
      // We don't touch committed_end directly (PM diff vocabulary doesn't
      // include it — operator decides whether to re-commit).
      if (drift.days_over >= TARGET_SHIFT_THRESHOLD_DAYS) {
        changes.push({
          kind: 'shift_initiative_target',
          initiative_id: init.id,
          target_end: drift.derived_end,
          reason: `Milestone at risk: derived_end ${drift.derived_end} exceeds committed_end ${drift.committed_end} by ${drift.days_over}d`,
        });
      }
      bullets.push(
        `⚠ Milestone "${init.title}" at risk — derived ${drift.derived_end} vs committed ${drift.committed_end} (+${drift.days_over}d)`,
      );
      continue;
    }
    if (drift.kind === 'slippage') {
      const init = initiativesById.get(drift.initiative_id);
      if (!init) continue;
      // Threshold check is already inside detectDrift (SLIPPAGE_THRESHOLD_DAYS).
      signals.push({
        kind: 'slippage',
        initiative: init,
        derived_end: drift.derived_end,
        target_end: drift.target_end,
        days_over: drift.days_over,
      });
      if (init.status === 'planned' || init.status === 'in_progress') {
        changes.push({
          kind: 'set_initiative_status',
          initiative_id: init.id,
          status: 'at_risk',
        });
      }
      if (drift.days_over >= TARGET_SHIFT_THRESHOLD_DAYS) {
        changes.push({
          kind: 'shift_initiative_target',
          initiative_id: init.id,
          target_end: drift.derived_end,
          reason: `Slippage: derived_end ${drift.derived_end} exceeds target_end ${drift.target_end} by ${drift.days_over}d`,
        });
      }
      bullets.push(
        `↗ "${init.title}" slipping — derived ${drift.derived_end} vs target ${drift.target_end} (+${drift.days_over}d)`,
      );
      continue;
    }
    if (drift.kind === 'cycle_detected') {
      signals.push({ kind: 'cycle_detected', initiative_ids: [...drift.initiative_ids] });
      const titles = drift.initiative_ids
        .map(id => initiativesById.get(id)?.title ?? id)
        .slice(0, 5);
      bullets.push(`⊗ Dependency cycle detected: ${titles.join(' → ')}`);
      // Intentionally NO set_initiative_status / shift diffs for cycle
      // members — derivation engine sets their dates to NULL inside the
      // cycle and the operator's first job is to break the cycle, not
      // shift dates.
      continue;
    }
    // 'no_effort_signal' is too noisy for a standup (every back-of-the-
    // -envelope idea would fire). Phase 4 already surfaces them in the
    // drift event metadata; we pass.
  }

  // 2. Stale blocked initiatives — `status='blocked'` and updated_at > N days.
  const stale = findStaleInitiatives(snapshot, today);

  for (const row of stale.blocked) {
    const init = initiativesById.get(row.initiative_id);
    if (!init) continue;
    signals.push({
      kind: 'stale_blocked',
      initiative: init,
      days_idle: row.days_idle,
    });
    const note = `[standup] Blocked ${row.days_idle}d — chase the blocker or unblock manually.`;
    changes.push({
      kind: 'update_status_check',
      initiative_id: init.id,
      status_check_md: appendStatusCheck(init.status_check_md, note),
    });
    bullets.push(`⏸ "${init.title}" blocked ${row.days_idle}d — needs a check-in`);
  }

  // 3. Stale in-progress initiatives — owner not pushing, no task updates.
  for (const row of stale.in_progress) {
    if (cycleSet.has(row.initiative_id)) continue;
    const init = initiativesById.get(row.initiative_id);
    if (!init) continue;
    signals.push({
      kind: 'stale_in_progress',
      initiative: init,
      days_idle: row.days_idle,
      task_count: row.task_count,
    });
    const note = `[standup] In-progress but no task activity in ${row.days_idle}d. Check on PR review status / pings.`;
    changes.push({
      kind: 'update_status_check',
      initiative_id: init.id,
      status_check_md: appendStatusCheck(init.status_check_md, note),
    });
    bullets.push(
      `🟡 "${init.title}" in-progress — no task updates in ${row.days_idle}d`,
    );
  }

  // Dedupe set_initiative_status diffs (a single initiative can match
  // both milestone_at_risk and slippage if the operator set both
  // committed_end and target_end). Keep the first; same with
  // shift_initiative_target.
  const dedupedChanges = dedupeChanges(changes);

  return {
    signals,
    changes: dedupedChanges,
    bullets,
    cycle_initiative_ids: [...cycleSet],
  };
}

interface StaleRow {
  initiative_id: string;
  days_idle: number;
  task_count: number;
}

interface StaleResult {
  blocked: StaleRow[];
  in_progress: StaleRow[];
}

/**
 * Find initiatives whose tasks haven't been touched recently. We compute
 * `days_idle` from the most recent of:
 *   - the initiative's own `updated_at`
 *   - the max `updated_at` across that initiative's tasks (any status)
 *
 * For initiatives with no tasks, we fall back to the initiative's
 * `updated_at`. Returns rows in initiative_id order for determinism.
 */
function findStaleInitiatives(
  snapshot: RoadmapSnapshot,
  today: Date,
): StaleResult {
  const blocked: StaleRow[] = [];
  const in_progress: StaleRow[] = [];

  // Pull (initiative_id, max(task.updated_at), count) once per workspace.
  // Cheap — workspaces are small. Group by initiative_id.
  const taskActivity = queryAll<{
    initiative_id: string;
    max_updated_at: string | null;
    task_count: number;
  }>(
    `SELECT initiative_id,
            MAX(updated_at) AS max_updated_at,
            COUNT(*) AS task_count
       FROM tasks
      WHERE workspace_id = ? AND initiative_id IS NOT NULL
      GROUP BY initiative_id`,
    [snapshot.workspace_id],
  );
  const activityById = new Map<string, { max: string | null; count: number }>();
  for (const a of taskActivity) {
    activityById.set(a.initiative_id, { max: a.max_updated_at, count: a.task_count });
  }

  // Pull initiative.updated_at for the workspace's initiatives (the snapshot
  // doesn't include it). One query — keyed by id.
  const initRows = queryAll<{ id: string; updated_at: string | null }>(
    'SELECT id, updated_at FROM initiatives WHERE workspace_id = ?',
    [snapshot.workspace_id],
  );
  const initUpdatedAt = new Map<string, string | null>();
  for (const r of initRows) initUpdatedAt.set(r.id, r.updated_at);

  // Sort by id for determinism.
  const sorted = [...snapshot.initiatives].sort((a, b) => a.id.localeCompare(b.id));
  for (const init of sorted) {
    if (init.status !== 'blocked' && init.status !== 'in_progress') continue;
    const activity = activityById.get(init.id);
    const lastTouched =
      activity?.max ?? initUpdatedAt.get(init.id) ?? null;
    if (!lastTouched) continue;
    const idle = daysBetween(lastTouched.slice(0, 10), isoDate(today));
    if (!isFinite(idle) || idle <= 0) continue;
    if (init.status === 'blocked' && idle >= STALE_BLOCKED_DAYS) {
      blocked.push({
        initiative_id: init.id,
        days_idle: idle,
        task_count: activity?.count ?? 0,
      });
    }
    if (init.status === 'in_progress' && idle >= STALE_TASK_DAYS) {
      in_progress.push({
        initiative_id: init.id,
        days_idle: idle,
        task_count: activity?.count ?? 0,
      });
    }
  }
  return { blocked, in_progress };
}

/**
 * Append a status-check note as a new line, preserving any existing text.
 * Truncates to keep the column readable (5KB hard cap).
 */
function appendStatusCheck(existing: string | null, note: string): string {
  const head = (existing ?? '').trim();
  const combined = head ? `${head}\n\n${note}` : note;
  return combined.length > 5000 ? combined.slice(0, 5000) : combined;
}

/**
 * Dedupe set_initiative_status / shift_initiative_target / update_status_check
 * by initiative_id (keep first), and dedupe add_dependency by edge. Other
 * kinds pass through unchanged.
 */
function dedupeChanges(changes: PmDiff[]): PmDiff[] {
  const seen = new Set<string>();
  const out: PmDiff[] = [];
  for (const c of changes) {
    let key: string | null = null;
    if (c.kind === 'set_initiative_status') key = `set:${c.initiative_id}`;
    else if (c.kind === 'shift_initiative_target') key = `shift:${c.initiative_id}`;
    else if (c.kind === 'update_status_check') key = `chk:${c.initiative_id}`;
    else if (c.kind === 'add_dependency')
      key = `dep:${c.initiative_id}->${c.depends_on_initiative_id}`;
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(c);
  }
  return out;
}

// ─── Impact_md composition ──────────────────────────────────────────

function composeImpactMd(
  detection: StandupDetection,
  todayIso: string,
): string {
  const headline =
    detection.changes.length === 0
      ? `### Daily standup — ${todayIso}: drift detected, no actionable changes`
      : `### Daily standup — ${todayIso}: ${detection.changes.length} change${detection.changes.length === 1 ? '' : 's'} proposed`;

  const lines: string[] = [headline, ''];
  if (detection.cycle_initiative_ids.length > 0) {
    lines.push(
      `**Dependency cycle present** — ${detection.cycle_initiative_ids.length} initiatives. ` +
        `Date diffs are skipped for these; break the cycle first.`,
      '',
    );
  }
  for (const b of detection.bullets.slice(0, 12)) {
    lines.push(`- ${b}`);
  }
  if (detection.bullets.length > 12) {
    lines.push(`- _…and ${detection.bullets.length - 12} more_`);
  }
  return lines.join('\n');
}

// ─── Idempotency lookup ─────────────────────────────────────────────

/**
 * Returns the most recent `pm_standup_generated` proposal for this workspace
 * created today (UTC), if any. Used by the schedule path to avoid duplicate
 * cards if the cron fires twice.
 *
 * We match on the date *embedded in the trigger_text* (e.g.
 * "Daily roadmap standup — automated drift scan (2026-04-24)") rather than
 * on `created_at`. This way the "logical day" the standup was generated for
 * is what counts — not when the row happened to be inserted. Tests can pass
 * a fixed `today` and re-running with the same `today` is correctly
 * idempotent even when wall-clock has advanced.
 */
function findExistingStandupToday(
  workspaceId: string,
  todayIso: string,
): PmProposal | null {
  const stamp = `(${todayIso})`;
  const row = queryOne<{ id: string }>(
    `SELECT id FROM pm_proposals
      WHERE workspace_id = ?
        AND trigger_kind = 'scheduled_drift_scan'
        AND status = 'draft'
        AND trigger_text LIKE ?
      ORDER BY created_at DESC
      LIMIT 1`,
    [workspaceId, `%${stamp}%`],
  );
  if (!row) return null;
  return getProposal(row.id) ?? null;
}

// ─── Event emission ─────────────────────────────────────────────────

interface EmitEventInput {
  type: 'pm_standup_generated' | 'pm_standup_skipped';
  workspace_id: string;
  message: string;
  metadata: Record<string, unknown>;
}

function emitEvent(input: EmitEventInput): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO events (id, type, message, metadata, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    uuidv4(),
    input.type,
    input.message,
    JSON.stringify(input.metadata),
    new Date().toISOString(),
  );
}

// ─── Date utils ─────────────────────────────────────────────────────

function normalizeToday(today: Date | string | undefined): Date {
  if (today instanceof Date) return today;
  if (typeof today === 'string') {
    const d = new Date(today);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
