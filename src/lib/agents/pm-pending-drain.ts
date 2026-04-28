/**
 * Drain worker for the `pm_pending_notes` queue.
 *
 * `propose_from_notes` enqueues rows when the openclaw gateway is
 * unreachable. This worker picks up pending rows, dispatches them
 * through `dispatchPm` (with `allowFallback: false`), and stamps each
 * row as `dispatched` or increments its attempts on failure. After
 * `MAX_ATTEMPTS` failures the row stops being retried automatically;
 * it stays in the table for operator review.
 *
 * Triggered by:
 *   1. Openclaw client `'connected'` event (best-effort; runs once
 *      per successful reconnect).
 *   2. A 60s setInterval registered at app boot.
 */

import {
  listPendingNotes,
  markDispatched,
  markFailed,
  type PmPendingNote,
} from '@/lib/db/pm-pending-notes';
import { dispatchPm, PmDispatchGatewayUnavailableError } from '@/lib/agents/pm-dispatch';
import { getOpenClawClient } from '@/lib/openclaw/client';

const MAX_ATTEMPTS = 5;

interface GatewayProbe {
  isConnected(): boolean;
}

/**
 * Test seam — same pattern as `__setOpenClawClientForTests` in
 * pm-dispatch.ts. Tests that override the dispatch path also need to
 * override the gateway probe here so the drain worker doesn't bail
 * with `skipped_gateway_down` while they're trying to exercise it.
 */
let gatewayProbeOverride: GatewayProbe | null = null;
export function __setGatewayProbeForTests(probe: GatewayProbe | null): void {
  gatewayProbeOverride = probe;
}
function gatewayProbe(): GatewayProbe {
  return gatewayProbeOverride ?? (getOpenClawClient() as unknown as GatewayProbe);
}

export interface DrainResult {
  attempted: number;
  dispatched: number;
  failed: number;
  skipped_gateway_down: boolean;
}

/**
 * Drain pending notes through `dispatchPm`. Cheap when the queue is
 * empty (single indexed read). Safe to call repeatedly.
 */
export async function drainPendingNotes(): Promise<DrainResult> {
  const out: DrainResult = {
    attempted: 0,
    dispatched: 0,
    failed: 0,
    skipped_gateway_down: false,
  };

  const gw = gatewayProbe();
  if (!gw.isConnected()) {
    out.skipped_gateway_down = true;
    return out;
  }

  const pending = listPendingNotes({ maxAttempts: MAX_ATTEMPTS });
  for (const note of pending) {
    out.attempted++;
    try {
      const result = dispatchPm({
        workspace_id: note.workspace_id,
        trigger_text: note.notes_text,
        trigger_kind: 'notes_intake',
        allowFallback: false,
      });
      // Wait for the full lifecycle. notes_intake requires the named
      // agent — if no reply, we leave the row pending so the next drain
      // tick can retry.
      const settled = await result.completion;
      if (!settled.used_named_agent) {
        // Treat as failed for this attempt; cleanup the orphan placeholder.
        out.failed++;
        try {
          const { run } = await import('@/lib/db');
          run(`DELETE FROM pm_proposals WHERE id = ?`, [result.proposal.id]);
        } catch { /* best effort */ }
        markFailed(note.id, 'agent did not reply within tail window');
        continue;
      }
      markDispatched(note.id, settled.final.id);
      out.dispatched++;
    } catch (err) {
      out.failed++;
      const msg = err instanceof Error ? err.message : String(err);
      markFailed(note.id, msg);
      // If the gateway dropped mid-drain, stop early — no point hammering
      // a downed gateway for the remaining rows.
      if (err instanceof PmDispatchGatewayUnavailableError || !gw.isConnected()) {
        break;
      }
    }
  }
  return out;
}

// ─── Boot-time registration ─────────────────────────────────────────

let drainTimer: NodeJS.Timeout | null = null;
let registered = false;

/**
 * Register the periodic-tick + reconnect-hook drain triggers. Idempotent:
 * safe to call multiple times. Tests can opt out by not calling this.
 */
export function registerDrainTriggers(opts: { intervalMs?: number } = {}): void {
  if (registered) return;
  registered = true;
  const intervalMs = opts.intervalMs ?? 60_000;

  drainTimer = setInterval(() => {
    drainPendingNotes().catch(err => {
      console.warn('[pm-pending-drain] tick failed:', (err as Error).message);
    });
  }, intervalMs);
  // Don't keep the Node process alive just for this timer.
  if (typeof drainTimer.unref === 'function') drainTimer.unref();

  // Best-effort reconnect hook — the openclaw client may or may not
  // expose a typed event surface; check for a duck-typed `on` method.
  try {
    const gw = getOpenClawClient() as unknown as {
      on?: (event: string, cb: () => void) => void;
    };
    if (typeof gw.on === 'function') {
      gw.on('connected', () => {
        drainPendingNotes().catch(err => {
          console.warn('[pm-pending-drain] reconnect drain failed:', (err as Error).message);
        });
      });
    }
  } catch (err) {
    console.warn('[pm-pending-drain] reconnect hook unavailable:', (err as Error).message);
  }
}

/** Test-only: tear down timers + reset registration so tests start clean. */
export function __resetDrainTriggersForTests(): void {
  if (drainTimer) {
    clearInterval(drainTimer);
    drainTimer = null;
  }
  registered = false;
}

export type { PmPendingNote };
