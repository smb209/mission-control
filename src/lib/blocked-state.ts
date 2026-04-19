import type { Task } from '@/lib/types';

/**
 * Structured "why is this task blocked" reason. Pure function — no DB, no
 * fetch, no React. Runs on the client from the `Task` row that the
 * `/api/tasks` endpoint already returns (with `assigned_agent.status` and
 * `assigned_agent.role` joined in).
 *
 * Mirrors the `blockedAgentIds` logic in AgentActivityDashboard.tsx, but
 * at the task level so the Kanban board can show WHY each card is stuck
 * instead of just dumping `planning_dispatch_error` verbatim.
 */
export type BlockedKind =
  | 'offline_agent'     // agent assigned but currently offline
  | 'dispatch_failed'   // planning_dispatch_error is populated
  | 'stalled'           // status_reason starts with 'stalled_' (scanner flag)
  | 'queued_review'     // in review with no reviewer free (handled by drainQueue)
  | 'queued_testing'    // in testing with no tester free
  | 'needs_agent';      // inbox with no assignee — needs operator input

export interface BlockedState {
  kind: BlockedKind;
  /** Short label shown on the card. */
  label: string;
  /** Longer explanation shown on hover / in the task modal. */
  tooltip: string;
  /** Tone for styling — 'error' | 'warn' | 'info'. */
  tone: 'error' | 'warn' | 'info';
}

const ACTIVE_STATUSES = new Set(['assigned', 'in_progress', 'convoy_active', 'testing', 'review', 'verification']);

/**
 * Parse a Node-fetch-style dispatch error into something operator-friendly.
 * workflow-engine.ts now stuffs the real cause ({ECONNREFUSED, timeout, ...})
 * into the stored error after the "fetch failed" sentinel. Strip the noise
 * so the badge shows "Gateway unreachable" instead of
 * "Dispatch error: fetch failed (connect ECONNREFUSED 127.0.0.1:4001)".
 */
function summarizeDispatchError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('econnrefused')) return 'Cannot reach Mission Control API — check URL';
  if (lower.includes('enotfound') || lower.includes('dns')) return 'Mission Control URL does not resolve';
  if (lower.includes('timeout') || lower.includes('etimedout')) return 'Dispatch timed out';
  if (lower.includes('gateway') && lower.includes('connect')) return 'Gateway disconnected';
  if (lower.includes('no eligible agent')) return 'No agent available for this role';
  if (lower.includes('no routable agent')) return 'No agent available for this role';
  if (lower.includes('agent has no session') || lower.includes('session')) return 'Agent has no active session';
  if (lower.includes('openclaw')) return 'Gateway error';
  // Fallback: trim leading "Dispatch error: " / "Auto-dispatch ... failed: "
  return raw.replace(/^(dispatch(?:\s+to\s+\S+)?\s+(?:error|failed)(?:\s*\([^)]*\))?:\s*)/i, '').slice(0, 100);
}

export function getBlockedState(task: Task): BlockedState | null {
  const status = task.status;
  const agent = task.assigned_agent;
  const dispatchError = task.planning_dispatch_error;
  const statusReason = task.status_reason;

  // 1. Dispatch error — highest priority because it means the server tried
  //    and failed. Surface the parsed cause so the user knows what to fix.
  if (dispatchError && ACTIVE_STATUSES.has(status)) {
    return {
      kind: 'dispatch_failed',
      label: `Blocked — ${summarizeDispatchError(dispatchError)}`,
      tooltip: dispatchError,
      tone: 'error',
    };
  }

  // 2. Assigned agent is offline but task is active. The agent went away
  //    after being assigned — the Blocked indicator ships the operator
  //    straight to "reassign or bring the agent back online".
  if (agent && agent.status === 'offline' && ACTIVE_STATUSES.has(status)) {
    return {
      kind: 'offline_agent',
      label: `Blocked — ${agent.name} is offline`,
      tooltip: `Agent "${agent.name}" is offline but still assigned to this task. Reassign or bring the agent back online.`,
      tone: 'error',
    };
  }

  // 3. Scanner-flagged stall (PR #2). Distinct from dispatch_failed because
  //    dispatch succeeded but the agent then went quiet.
  if (statusReason?.startsWith('stalled_') && ACTIVE_STATUSES.has(status)) {
    return {
      kind: 'stalled',
      label: 'Blocked — stalled',
      tooltip: statusReason,
      tone: 'warn',
    };
  }

  // 4. Testing / review with no agent assigned = queued waiting for the
  //    next stage's role to free up. Not an error — operator just needs
  //    visibility that it's not forgotten. (drainQueue will advance it.)
  if (status === 'testing' && !task.assigned_agent_id) {
    return {
      kind: 'queued_testing',
      label: 'In queue — waiting for tester',
      tooltip: 'No tester available yet. Will auto-advance when one frees up.',
      tone: 'info',
    };
  }
  if (status === 'review' && !task.assigned_agent_id) {
    return {
      kind: 'queued_review',
      label: 'In queue — waiting for reviewer',
      tooltip: 'No reviewer available yet. Will auto-advance when one frees up.',
      tone: 'info',
    };
  }

  // 5. Inbox with no agent — needs operator to assign someone. Matches the
  //    existing "Needs agent — assign to start" row in MissionQueue.
  if (status === 'inbox' && !task.assigned_agent_id) {
    return {
      kind: 'needs_agent',
      label: 'Needs agent — assign to start',
      tooltip: 'Task has no assigned agent. Pick one from the agent list.',
      tone: 'warn',
    };
  }

  return null;
}
