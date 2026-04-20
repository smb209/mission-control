import { queryAll, run } from '@/lib/db';
import { logDebugEvent } from '@/lib/debug-log';
import { emitAutopilotActivity } from './activity';
import type { ResearchCycle, IdeationCycle } from '@/lib/types';

/**
 * Stall scanner for Product Autopilot cycles.
 *
 * The task-side scanner in src/lib/stall-detection.ts only scans `tasks`.
 * Research and ideation cycles live in their own tables with their own
 * `status='running'` + `last_heartbeat` fields. Without a scanner, a cycle
 * whose LLM call hangs past the fetch timeout (gateway crash, socket death,
 * Node aborting mid-read) sits in `running` forever — recovery.ts only fires
 * at app startup, which only catches cycles that survived a process restart.
 *
 * This scanner runs on the same 2-minute cadence as scanStalledTasks and
 * flips any cycle whose heartbeat is older than CYCLE_STALL_MINUTES to
 * `status='interrupted'` with a descriptive error_message. Marking
 * interrupted removes the cycle from the `running` set — next scan is a
 * no-op for the same row.
 */

/** Default threshold. Override via AUTOPILOT_CYCLE_STALL_MINUTES env var. */
const DEFAULT_CYCLE_STALL_MINUTES = 15;

export interface CycleStallReport {
  scanned: number;
  flagged: Array<{
    cycle_id: string;
    cycle_type: 'research' | 'ideation';
    product_id: string;
    current_phase: string;
    minutes_idle: number;
  }>;
}

function getThresholdMinutes(): number {
  const raw = process.env.AUTOPILOT_CYCLE_STALL_MINUTES;
  if (!raw) return DEFAULT_CYCLE_STALL_MINUTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CYCLE_STALL_MINUTES;
}

export async function scanStalledCycles(): Promise<CycleStallReport> {
  const thresholdMinutes = getThresholdMinutes();
  const nowMs = Date.now();

  const report: CycleStallReport = { scanned: 0, flagged: [] };

  const researchRunning = queryAll<ResearchCycle>(
    `SELECT * FROM research_cycles WHERE status = 'running'`
  );
  report.scanned += researchRunning.length;

  for (const cycle of researchRunning) {
    // Cycles with no heartbeat at all are suspicious — they never made it
    // past the INSERT. Use `started_at` as the fallback freshness signal.
    const tick = cycle.last_heartbeat || cycle.started_at;
    if (!tick) continue;

    const minutesIdle = (nowMs - new Date(tick).getTime()) / 60000;
    if (minutesIdle < thresholdMinutes) continue;

    markInterrupted('research_cycles', cycle.id, cycle.product_id, 'research', minutesIdle, cycle.current_phase || 'init', thresholdMinutes);
    report.flagged.push({
      cycle_id: cycle.id,
      cycle_type: 'research',
      product_id: cycle.product_id,
      current_phase: cycle.current_phase || 'init',
      minutes_idle: Math.round(minutesIdle),
    });
  }

  const ideationRunning = queryAll<IdeationCycle>(
    `SELECT * FROM ideation_cycles WHERE status = 'running'`
  );
  report.scanned += ideationRunning.length;

  for (const cycle of ideationRunning) {
    const tick = cycle.last_heartbeat || cycle.started_at;
    if (!tick) continue;

    const minutesIdle = (nowMs - new Date(tick).getTime()) / 60000;
    if (minutesIdle < thresholdMinutes) continue;

    markInterrupted('ideation_cycles', cycle.id, cycle.product_id, 'ideation', minutesIdle, cycle.current_phase || 'init', thresholdMinutes);
    report.flagged.push({
      cycle_id: cycle.id,
      cycle_type: 'ideation',
      product_id: cycle.product_id,
      current_phase: cycle.current_phase || 'init',
      minutes_idle: Math.round(minutesIdle),
    });
  }

  return report;
}

function markInterrupted(
  table: 'research_cycles' | 'ideation_cycles',
  cycleId: string,
  productId: string,
  cycleType: 'research' | 'ideation',
  minutesIdle: number,
  currentPhase: string,
  thresholdMinutes: number,
): void {
  const now = new Date().toISOString();
  const reason = `stalled_no_heartbeat (idle ${Math.round(minutesIdle)}m in ${currentPhase}, threshold ${thresholdMinutes}m, detected ${now})`;

  // Guard on status='running' so a late completion from the in-flight runner
  // can't flip us back — once we mark interrupted, we stay interrupted.
  run(
    `UPDATE ${table}
       SET status = 'interrupted', error_message = ?, completed_at = ?
     WHERE id = ? AND status = 'running'`,
    [reason, now, cycleId]
  );

  emitAutopilotActivity({
    productId,
    cycleId,
    cycleType,
    eventType: 'cycle_stalled',
    message: `${cycleType} cycle auto-marked interrupted after ${Math.round(minutesIdle)}m without heartbeat`,
    detail: `Phase was ${currentPhase}; threshold ${thresholdMinutes}m`,
  });

  logDebugEvent({
    type: 'autopilot.cycle_stalled',
    direction: 'internal',
    metadata: {
      table,
      cycle_id: cycleId,
      cycle_type: cycleType,
      product_id: productId,
      current_phase: currentPhase,
      minutes_idle: Math.round(minutesIdle),
      threshold_minutes: thresholdMinutes,
    },
  });
}
