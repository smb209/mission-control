import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run, transaction } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { sendMail } from '@/lib/mailbox';
import { resolveMasterOrchestrator } from '@/lib/master-orchestrator';
import { getMissionControlUrl } from '@/lib/config';
import type { Agent } from '@/lib/types';

export interface RollCallSession {
  id: string;
  workspace_id: string;
  initiator_agent_id: string;
  mode: 'direct' | 'coordinator';
  timeout_seconds: number;
  created_at: string;
  expires_at: string;
}

export interface RollCallEntry {
  id: string;
  rollcall_id: string;
  target_agent_id: string;
  delivery_status: 'pending' | 'sent' | 'failed' | 'skipped';
  delivery_error: string | null;
  delivered_at: string | null;
  reply_mail_id: string | null;
  reply_body: string | null;
  replied_at: string | null;
  created_at: string;
  // Joined on read
  target_agent_name?: string;
  target_agent_role?: string;
}

export type InitiateRollCallResult =
  | {
      ok: true;
      rollcall: RollCallSession;
      entries: RollCallEntry[];
    }
  | {
      ok: false;
      reason: 'no_master' | 'multiple_masters' | 'no_active_agents';
      detail: string;
      candidates?: Agent[];
    };

/**
 * Start a roll-call: ask every active agent in the workspace (except the
 * initiator) to check in. Delivery happens via mail push (chat.send to
 * the target's active session). Replies are captured when agents POST
 * back to `/api/agents/<initiator>/mail`.
 *
 * Modes:
 *   - 'direct'      : MC push-delivers the mail itself from the master
 *                     orchestrator to each target.
 *   - 'coordinator' : MC dispatches a task to the master orchestrator
 *                     and the master uses sessions_send / mail to
 *                     fan-out. Currently both modes use the same direct
 *                     push path underneath — coordinator mode just also
 *                     creates the orchestrator-visible task so the master
 *                     can follow up.
 */
export async function initiateRollCall(params: {
  workspaceId: string;
  mode: 'direct' | 'coordinator';
  timeoutSeconds?: number;
}): Promise<InitiateRollCallResult> {
  const { workspaceId, mode, timeoutSeconds = 30 } = params;

  // Resolve the master orchestrator (exactly one, else error).
  const master = resolveMasterOrchestrator(workspaceId);
  if (!master.ok) {
    return {
      ok: false,
      reason: master.reason === 'none' ? 'no_master' : 'multiple_masters',
      detail:
        master.reason === 'none'
          ? `No master orchestrator found in workspace "${workspaceId}". Mark one agent with is_master=1 via PATCH /api/agents/[id].`
          : `${master.candidates.length} agents are marked as master orchestrators in workspace "${workspaceId}": ${master.candidates
              .map(a => a.name)
              .join(', ')}. Exactly one is required — un-mark the others via PATCH.`,
      candidates: master.reason === 'multiple' ? master.candidates : undefined,
    };
  }

  // Active agents in the workspace, excluding the master itself.
  const targets = queryAll<Agent>(
    `SELECT * FROM agents
       WHERE workspace_id = ?
         AND id != ?
         AND COALESCE(is_active, 1) = 1
         AND COALESCE(status, 'standby') != 'offline'
       ORDER BY role ASC, name ASC`,
    [workspaceId, master.agent.id]
  );

  if (targets.length === 0) {
    return {
      ok: false,
      reason: 'no_active_agents',
      detail: `No other active agents in workspace "${workspaceId}". Mark at least one agent as is_active=1.`,
    };
  }

  const rollcallId = uuidv4();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + timeoutSeconds * 1000).toISOString();

  // Insert session + entries in one transaction so the UI can subscribe
  // to a single rollcall_id and pick up a complete roster on first read.
  transaction(() => {
    run(
      `INSERT INTO rollcall_sessions (id, workspace_id, initiator_agent_id, mode, timeout_seconds, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [rollcallId, workspaceId, master.agent.id, mode, timeoutSeconds, nowIso, expiresAt]
    );
    for (const t of targets) {
      run(
        `INSERT INTO rollcall_entries (id, rollcall_id, target_agent_id, created_at)
         VALUES (?, ?, ?, ?)`,
        [uuidv4(), rollcallId, t.id, nowIso]
      );
    }
  });

  broadcast({
    type: 'rollcall_started',
    payload: { rollcall_id: rollcallId, workspace_id: workspaceId, mode, target_count: targets.length },
  });

  // Deliver mail to each target. We do this sequentially (not in parallel)
  // because our OpenClawClient singleton serializes via a single WebSocket
  // — parallel fire would interleave RPC requests but gain little given
  // the typical target count (<10). Keeping it sequential also gives us
  // deterministic ordering in the debug feed.
  //
  // Each target gets a personalized mail body that hard-codes:
  //   - their own MC agent_id (they don't need to guess / introspect)
  //   - the master's MC agent_id (they don't need to resolve via list_peers)
  //   - a ready-to-invoke MCP tool-call shape (sc-mission-control__send_mail)
  //     so there's one unambiguous pattern to mimic
  //
  // Prior versions of this prompt showed agents trying every port from
  // 3000 upward, probing with PUT when POST was right, and filling
  // `from_agent_id` with whatever random uuid they could scrape off
  // their own session. Being explicit eliminates that.
  //
  // The curl recipe was retired here after PR 28 (cutover). Transport auth
  // (MC_API_TOKEN bearer) is handled by the mcp-launcher and never appears
  // in agent-facing text. The sc-mission-control__send_mail tool routes
  // through sendAgentMail(), which calls recordRollCallReplyIfMatch —
  // same side effect as the old HTTP path, so rollcall-entry matching
  // still flips the UI status from "waiting" to "responded".
  const missionControlUrl = getMissionControlUrl();

  // Sanity check: roll-call replies go back through the MC MCP endpoint.
  // If MISSION_CONTROL_URL points to localhost / 127.0.0.1 / ::1, any
  // launcher running on a different host won't be able to reach it.
  // We don't block — a single-host dev setup is legitimate — but log
  // loudly so the misconfiguration surfaces before the first 30s timeout.
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(missionControlUrl)) {
    console.warn(
      `[RollCall] MISSION_CONTROL_URL is set to ${missionControlUrl}. ` +
      `If any sc-mission-control mcp-launcher runs on a different host it ` +
      `will not be able to reach MC to post replies. Set ` +
      `MISSION_CONTROL_URL to an address reachable from that host (e.g. ` +
      `your LAN IP) and restart MC.`
    );
  }

  for (const target of targets) {
    const body = `ROLL CALL — please reply briefly with your current status.

**Your Mission Control agent_id:** \`${target.id}\`
**Your role:** ${target.role}
**Reply within:** ${timeoutSeconds}s

**REPLY** — call the \`sc-mission-control__send_mail\` MCP tool with your short status note substituted:

\`\`\`
sc-mission-control__send_mail({
  agent_id: "${target.id}",
  to_agent_id: "${master.agent.id}",
  subject: "roll_call_reply:${rollcallId}",
  body: "CHECKED_IN: ${target.role}, status=ok, note=<your short note>"
})
\`\`\`

Transport authentication is handled by your MCP launcher — no token or Authorization header required from you.

Keep the reply brief — a single \`CHECKED_IN:\` line is enough.`;

    let deliveryStatus: 'sent' | 'failed' | 'skipped' = 'failed';
    let deliveryError: string | null = null;
    try {
      const result = await sendMail({
        fromAgentId: master.agent.id,
        toAgentId: target.id,
        subject: `roll_call:${rollcallId}`,
        body,
        push: true,
      });
      deliveryStatus = result.delivery?.status ?? 'failed';
      deliveryError = result.delivery?.error ?? null;
    } catch (err) {
      deliveryStatus = 'failed';
      deliveryError = (err as Error).message;
    }

    run(
      `UPDATE rollcall_entries
         SET delivery_status = ?, delivery_error = ?, delivered_at = ?
       WHERE rollcall_id = ? AND target_agent_id = ?`,
      [deliveryStatus, deliveryError, new Date().toISOString(), rollcallId, target.id]
    );
  }

  // Return the assembled roster. The caller will poll GET for updates as
  // replies come in — or subscribe to the `rollcall_entry_updated` SSE
  // event stream we'll emit when replies land.
  const rollcall = queryOne<RollCallSession>('SELECT * FROM rollcall_sessions WHERE id = ?', [rollcallId])!;
  const entries = queryAll<RollCallEntry>(
    `SELECT e.*, a.name as target_agent_name, a.role as target_agent_role
       FROM rollcall_entries e
       JOIN agents a ON a.id = e.target_agent_id
       WHERE e.rollcall_id = ?
       ORDER BY a.role ASC, a.name ASC`,
    [rollcallId]
  );

  broadcast({
    type: 'rollcall_delivered',
    payload: { rollcall_id: rollcallId, entries },
  });

  return { ok: true, rollcall, entries };
}

/**
 * Fetch current status of a roll-call, including any replies that have
 * arrived since delivery.
 */
export function getRollCallStatus(rollcallId: string): {
  rollcall: RollCallSession;
  entries: RollCallEntry[];
} | null {
  const rollcall = queryOne<RollCallSession>(
    'SELECT * FROM rollcall_sessions WHERE id = ?',
    [rollcallId]
  );
  if (!rollcall) return null;

  const entries = queryAll<RollCallEntry>(
    `SELECT e.*, a.name as target_agent_name, a.role as target_agent_role
       FROM rollcall_entries e
       JOIN agents a ON a.id = e.target_agent_id
       WHERE e.rollcall_id = ?
       ORDER BY a.role ASC, a.name ASC`,
    [rollcallId]
  );

  return { rollcall, entries };
}

/**
 * Try to record a mail message as the reply to an open roll-call entry.
 * Called from the mail POST handler when `subject` starts with
 * "roll_call_reply" or "roll_call:<id>" — matches by (rollcall_id,
 * from_agent_id). No-op if no matching entry is found (e.g. late reply
 * after expiry or stray mail).
 */
export function recordRollCallReplyIfMatch(params: {
  mailId: string;
  fromAgentId: string;
  toAgentId: string;
  subject: string | null | undefined;
  body: string;
}): { matched: boolean; rollcallId?: string } {
  const { mailId, fromAgentId, toAgentId, subject, body } = params;
  if (!subject) return { matched: false };

  // Accept either "roll_call_reply:<uuid>" or "roll_call:<uuid>"
  const match = subject.match(/^roll_call(?:_reply)?:([\w-]+)/i);
  const rollcallId = match?.[1];
  if (!rollcallId) return { matched: false };

  const rollcall = queryOne<RollCallSession>(
    'SELECT * FROM rollcall_sessions WHERE id = ? AND initiator_agent_id = ?',
    [rollcallId, toAgentId]
  );
  if (!rollcall) return { matched: false };

  const entry = queryOne<{ id: string; replied_at: string | null }>(
    'SELECT id, replied_at FROM rollcall_entries WHERE rollcall_id = ? AND target_agent_id = ?',
    [rollcallId, fromAgentId]
  );
  if (!entry || entry.replied_at) return { matched: false };

  run(
    `UPDATE rollcall_entries
       SET reply_mail_id = ?, reply_body = ?, replied_at = ?
     WHERE id = ?`,
    [mailId, body, new Date().toISOString(), entry.id]
  );

  broadcast({
    type: 'rollcall_entry_updated',
    payload: {
      rollcall_id: rollcallId,
      target_agent_id: fromAgentId,
      reply_received: true,
    },
  });

  return { matched: true, rollcallId };
}
