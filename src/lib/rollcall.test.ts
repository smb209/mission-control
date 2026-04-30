/**
 * Tests for `getPendingRollcallsForAgent` / `formatPendingRollcallsForDispatch` —
 * slice 4 of the autonomous-flow tightening.
 *
 * Closes FM3 from the post-mortem: stage-isolated sessions never saw
 * the rollcall mail (it had been delivered + cleaned up by the prior
 * session), so all replies came back with `rollcall_matched: false`.
 * This module reads from the durable `rollcall_entries` table so the
 * dispatch path can surface unanswered rollcalls regardless of mail
 * lifecycle.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '@/lib/db';
import {
  getPendingRollcallsForAgent,
  formatPendingRollcallsForDispatch,
} from './rollcall';

function seedAgent(name: string): string {
  const id = crypto.randomUUID();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_active, created_at, updated_at)
     VALUES (?, ?, 'builder', 'default', 1, datetime('now'), datetime('now'))`,
    [id, name],
  );
  return id;
}

interface SeedRollcallOpts {
  initiator: string;
  target: string;
  expiresInSeconds?: number;
  replied?: boolean;
  deliveryStatus?: 'pending' | 'sent' | 'failed' | 'skipped';
}

function seedRollcall(opts: SeedRollcallOpts): string {
  const rcId = crypto.randomUUID();
  const expires = new Date(
    Date.now() + (opts.expiresInSeconds ?? 30) * 1000,
  ).toISOString();
  run(
    `INSERT INTO rollcall_sessions (id, workspace_id, initiator_agent_id, mode, timeout_seconds, created_at, expires_at)
     VALUES (?, 'default', ?, 'direct', 30, datetime('now'), ?)`,
    [rcId, opts.initiator, expires],
  );
  run(
    `INSERT INTO rollcall_entries (id, rollcall_id, target_agent_id, delivery_status, replied_at, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [
      crypto.randomUUID(),
      rcId,
      opts.target,
      opts.deliveryStatus ?? 'sent',
      opts.replied ? new Date().toISOString() : null,
    ],
  );
  return rcId;
}

test('getPendingRollcallsForAgent returns active unreplied entries', () => {
  const orchestrator = seedAgent('orch');
  const target = seedAgent('builder-a');
  const rcId = seedRollcall({ initiator: orchestrator, target });
  const pending = getPendingRollcallsForAgent(target);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.rollcall_id, rcId);
  assert.equal(pending[0]!.initiator_agent_name, 'orch');
});

test('getPendingRollcallsForAgent skips replied entries', () => {
  const orchestrator = seedAgent('orch');
  const target = seedAgent('builder-b');
  seedRollcall({ initiator: orchestrator, target, replied: true });
  const pending = getPendingRollcallsForAgent(target);
  assert.equal(pending.length, 0);
});

test('getPendingRollcallsForAgent skips expired sessions', () => {
  const orchestrator = seedAgent('orch');
  const target = seedAgent('builder-c');
  // Expired 60s ago
  seedRollcall({ initiator: orchestrator, target, expiresInSeconds: -60 });
  const pending = getPendingRollcallsForAgent(target);
  assert.equal(pending.length, 0);
});

test('getPendingRollcallsForAgent skips delivery failures', () => {
  const orchestrator = seedAgent('orch');
  const target = seedAgent('builder-d');
  seedRollcall({ initiator: orchestrator, target, deliveryStatus: 'failed' });
  const pending = getPendingRollcallsForAgent(target);
  assert.equal(pending.length, 0);
});

test('formatPendingRollcallsForDispatch returns empty string when none pending', () => {
  const target = seedAgent('builder-e');
  assert.equal(formatPendingRollcallsForDispatch(target), '');
});

test('formatPendingRollcallsForDispatch surfaces the reply subject', () => {
  const orchestrator = seedAgent('orch');
  const target = seedAgent('builder-f');
  const rcId = seedRollcall({ initiator: orchestrator, target });
  const out = formatPendingRollcallsForDispatch(target);
  assert.match(out, /PENDING ROLL-CALLS/);
  assert.match(out, new RegExp(`roll_call_reply:${rcId}`));
});

// ─── Replay test from the AlertDialog post-mortem ─────────────────────

test("replay: stage-isolated session would see the rollcall the parent received", () => {
  // Original flow: orchestrator initiates a rollcall → mail delivered to
  // session A; session A is reset for stage isolation (new openclaw_session_id);
  // session B starts with no mail history. Pre-fix, session B wouldn't know
  // about the rollcall and reply with `roll_call_reply:false`. Post-fix, it
  // sees the entry directly because we read from rollcall_entries.
  const orchestrator = seedAgent('orch');
  const target = seedAgent('builder-replay');
  const rcId = seedRollcall({ initiator: orchestrator, target });
  // Simulate that the mail was already consumed by a prior session (we
  // never insert it; the entry is what survives).
  const dispatchSection = formatPendingRollcallsForDispatch(target);
  assert.match(dispatchSection, new RegExp(rcId));
});
