import { queryAll, queryOne } from '@/lib/db';

/**
 * Parseable marker the Coordinator dispatch prompt requires on every
 * per-delegation activity message. Anchored at the start of the message so
 * prose surrounding the marker is ignored. The inner fields are matched
 * loosely — field presence matters more than exact formatting for the audit.
 */
const DELEGATION_MARKER_RE = /^\[DELEGATION\]/i;

export interface DelegationClaim {
  activity_id: string;
  created_at: string;
  agent_id: string | null;
  message: string;
  target: string | null;
  gateway_id: string | null;
  tool_call_id: string | null;
}

export interface CoordinatorAuditResult {
  /** Activities posted by the task's assigned (coordinator) agent that carry
   *  the [DELEGATION] marker. These are the coordinator's *claims* that a
   *  delegation happened. */
  claims: DelegationClaim[];
  /** Count of activities from agents OTHER than the assigned coordinator.
   *  These are the real signal that a peer received work and responded. */
  peerCallbacks: number;
  /** True when the coordinator has claimed at least one delegation but no
   *  peer has reported back after the freshness threshold. Callers use this
   *  to enrich stall reasons without blocking on exact-match proof. */
  suspicious: boolean;
  /** Minutes since the earliest delegation claim. Null when no claims. */
  minutesSinceFirstClaim: number | null;
  /** Activities that *look* like delegation announcements ("delegated", "sent
   *  to", etc.) but don't carry the marker. These are the umbrella-claim
   *  pattern we want to catch — they inflate the count of apparent work while
   *  carrying no proof of tool invocation. */
  unmarkedClaimActivities: number;
}

function parseDelegationFields(message: string): { target: string | null; gateway_id: string | null; tool_call_id: string | null } {
  // The marker format is:
  //   [DELEGATION] target="..." gateway_id="..." tool_call_id="..." slice="..."
  // but the LLM may drop quotes or use single quotes. Extract best-effort.
  const grab = (key: string): string | null => {
    const re = new RegExp(`${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'][^\\s]*))`, 'i');
    const m = re.exec(message);
    return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
  };
  return {
    target: grab('target'),
    gateway_id: grab('gateway_id'),
    tool_call_id: grab('tool_call_id'),
  };
}

/**
 * Audit a task's coordinator-claimed delegations against evidence that peer
 * agents actually received work. Used by stall detection to distinguish
 * "coordinator waiting on real peers" from "coordinator narrated a delegation
 * it never actually invoked".
 *
 * Freshness threshold: a claim older than `stalenessMinutes` with zero peer
 * callbacks is suspicious. Below that window we assume peers may still be
 * responding and don't flag. Defaults to 5 minutes.
 */
export function auditCoordinatorDelegations(
  taskId: string,
  opts: { stalenessMinutes?: number } = {}
): CoordinatorAuditResult {
  const stalenessMinutes = opts.stalenessMinutes ?? 5;

  const task = queryOne<{ assigned_agent_id: string | null }>(
    'SELECT assigned_agent_id FROM tasks WHERE id = ?',
    [taskId]
  );
  const coordId = task?.assigned_agent_id ?? null;

  // Every activity on the task with the parseable marker.
  const markedRows = queryAll<{ id: string; created_at: string; agent_id: string | null; message: string }>(
    `SELECT id, created_at, agent_id, message
     FROM task_activities
     WHERE task_id = ? AND message LIKE '[DELEGATION]%'
     ORDER BY created_at ASC`,
    [taskId]
  );
  const claims: DelegationClaim[] = markedRows
    .filter(r => DELEGATION_MARKER_RE.test(r.message))
    .map(r => ({
      activity_id: r.id,
      created_at: r.created_at,
      agent_id: r.agent_id,
      message: r.message,
      ...parseDelegationFields(r.message),
    }));

  // Umbrella-claim pattern: activities from the coordinator that talk about
  // delegating but don't carry the marker. Useful signal but not counted as
  // real delegations.
  let unmarkedClaimActivities = 0;
  if (coordId) {
    const umbrella = queryAll<{ id: string }>(
      `SELECT id FROM task_activities
       WHERE task_id = ?
         AND agent_id = ?
         AND (message LIKE '%delegat%' OR message LIKE '%dispatched to%' OR message LIKE '%sent to%')
         AND message NOT LIKE '[DELEGATION]%'`,
      [taskId, coordId]
    );
    unmarkedClaimActivities = umbrella.length;
  }

  // Peer callbacks: activities by agents OTHER than the coordinator. Exclude
  // system-generated status_changed rows (health/stall noise) and the
  // coordinator's own self-report rows.
  const peerCallbacks = Number(
    queryOne<{ n: number }>(
      `SELECT COUNT(*) as n FROM task_activities
       WHERE task_id = ?
         AND activity_type != 'status_changed'
         AND agent_id IS NOT NULL
         AND agent_id != COALESCE(?, '')`,
      [taskId, coordId]
    )?.n ?? 0
  );

  let minutesSinceFirstClaim: number | null = null;
  if (claims.length > 0) {
    minutesSinceFirstClaim = (Date.now() - new Date(claims[0].created_at).getTime()) / 60000;
  }

  const suspicious =
    claims.length > 0 &&
    peerCallbacks === 0 &&
    minutesSinceFirstClaim !== null &&
    minutesSinceFirstClaim >= stalenessMinutes;

  return {
    claims,
    peerCallbacks,
    suspicious,
    minutesSinceFirstClaim,
    unmarkedClaimActivities,
  };
}
