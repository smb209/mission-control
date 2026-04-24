import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { Agent, AgentMailMessage, OpenClawSession } from '@/lib/types';

interface SendMailInput {
  /** Optional convoy scope (original convoy mail flow). */
  convoyId?: string | null;
  /** Optional task scope — mail is associated with this task for context injection. */
  taskId?: string | null;
  fromAgentId: string;
  toAgentId: string;
  subject?: string;
  body: string;
  /**
   * If true, also push-deliver the mail via chat.send to the target's
   * active OpenClaw session so the target sees it immediately (rather
   * than on their next dispatch via formatMailForDispatch). Used for
   * roll-call and urgent help-requests.
   */
  push?: boolean;
}

export interface SendMailResult {
  message: AgentMailMessage;
  /** Only set when push=true. */
  delivery?: {
    status: 'sent' | 'failed' | 'skipped';
    error?: string;
    sessionKey?: string;
  };
}

/**
 * Send mail from one agent to another. Scope is optional — both convoy_id
 * and task_id may be null for ad-hoc mail (roll-call, general questions
 * to the master orchestrator, etc.). When `push=true`, the mail is also
 * delivered immediately via the target's active session so the target
 * doesn't have to wait for a dispatch to receive it.
 */
export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  const { convoyId, taskId, fromAgentId, toAgentId, subject, body, push } = input;

  // If a convoy is specified, verify it exists — matches the old strict
  // behavior for the existing convoy mail API. Non-convoy mail skips this
  // check, which is what makes the roll-call/help-request paths work.
  if (convoyId) {
    const convoy = queryOne<{ id: string }>('SELECT id FROM convoys WHERE id = ?', [convoyId]);
    if (!convoy) throw new Error(`Convoy ${convoyId} not found`);
  }

  const id = uuidv4();
  const now = new Date().toISOString();

  run(
    `INSERT INTO agent_mailbox (id, convoy_id, task_id, from_agent_id, to_agent_id, subject, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, convoyId ?? null, taskId ?? null, fromAgentId, toAgentId, subject || null, body, now]
  );

  const message = queryOne<AgentMailMessage>('SELECT * FROM agent_mailbox WHERE id = ?', [id])!;

  broadcast({ type: 'mail_received', payload: message });

  if (!push) return { message };

  // Push delivery. We frame the mail body so the receiving agent can
  // distinguish mail from a regular task dispatch, and include the
  // message_id so the operator can trace the mail row through the debug
  // feed. If delivery fails, the DB row is still there — a later
  // dispatch will pick it up via formatMailForDispatch. We surface the
  // failure in the return value so roll-call can record it accurately.
  try {
    // Lazy-import to avoid pulling the openclaw client into non-push callers.
    const { getOpenClawClient } = await import('@/lib/openclaw/client');
    const client = getOpenClawClient();
    if (!client.isConnected()) {
      await client.connect();
    }

    // Build a sessionKey that targets the agent's own namespace. The prefix
    // resolver prefers an explicit `session_key_prefix`, then the gateway
    // agent id, then a name-slug fallback — anything but the old
    // `agent:main:` catchall that misrouted to the gateway's main agent.
    // We append a mail-scoped suffix so each mail occupies its own
    // session bucket (the gateway creates it on receipt if needed — no
    // pre-existing openclaw_sessions row required).
    const { resolveAgentSessionKeyPrefix } = await import('@/lib/openclaw/session-key');
    const target = queryOne<Pick<OpenClawSession, 'id'> & { name: string; session_key_prefix: string | null; gateway_agent_id: string | null }>(
      'SELECT id, name, session_key_prefix, gateway_agent_id FROM agents WHERE id = ?',
      [toAgentId]
    );
    if (!target) {
      return {
        message,
        delivery: { status: 'skipped', error: `Target agent ${toAgentId} not found` },
      };
    }
    const fromAgent = queryOne<{ name: string }>('SELECT name FROM agents WHERE id = ?', [fromAgentId]);
    const prefix = resolveAgentSessionKeyPrefix({
      session_key_prefix: target.session_key_prefix ?? undefined,
      gateway_agent_id: target.gateway_agent_id ?? undefined,
      name: target.name,
    } as Agent);
    const sessionKey = `${prefix}mc-mail-${id}`;

    // Frame the mail so the agent recognises it as MC→agent mail (not a
    // regular task dispatch). We deliberately don't append a generic
    // "reply by POST" footer here — callers know the exact reply shape
    // they want (roll-call needs a specific subject format; help-request
    // flows may not need a reply at all), and appending a generic footer
    // caused agents to guess URLs / methods / body shapes rather than
    // follow the caller's explicit instructions.
    const framedMessage = `📬 **MAIL from ${fromAgent?.name || fromAgentId}** (mail_id=${id})
${subject ? `**Subject:** ${subject}\n` : ''}
${body}`;

    await client.call('chat.send', {
      sessionKey,
      message: framedMessage,
      idempotencyKey: `mail-${id}`,
    });

    return {
      message,
      delivery: { status: 'sent', sessionKey },
    };
  } catch (err) {
    return {
      message,
      delivery: { status: 'failed', error: (err as Error).message },
    };
  }
}

/**
 * Get unread mail for an agent.
 */
export function getUnreadMail(agentId: string): AgentMailMessage[] {
  const rows = queryAll<AgentMailMessage>(
    `SELECT m.*, fa.name as from_agent_name, ta.name as to_agent_name
     FROM agent_mailbox m
     LEFT JOIN agents fa ON m.from_agent_id = fa.id
     LEFT JOIN agents ta ON m.to_agent_id = ta.id
     WHERE m.to_agent_id = ? AND m.read_at IS NULL
     ORDER BY m.created_at ASC`,
    [agentId]
  );
  return rows;
}

/**
 * Mark a message as read.
 */
export function markAsRead(messageId: string): void {
  const now = new Date().toISOString();
  run('UPDATE agent_mailbox SET read_at = ? WHERE id = ?', [now, messageId]);
}

/**
 * Get all mail in a convoy.
 */
export function getConvoyMail(convoyId: string): AgentMailMessage[] {
  return queryAll<AgentMailMessage>(
    `SELECT m.*, fa.name as from_agent_name, ta.name as to_agent_name
     FROM agent_mailbox m
     LEFT JOIN agents fa ON m.from_agent_id = fa.id
     LEFT JOIN agents ta ON m.to_agent_id = ta.id
     WHERE m.convoy_id = ?
     ORDER BY m.created_at ASC`,
    [convoyId]
  );
}

/** Match roll_call / roll_call_reply subjects. Single-use by design. */
const ROLL_CALL_SUBJECT_RE = /^roll_call(?:_reply)?:/i;
/** Cap on non-roll_call messages rendered per dispatch. */
const MAX_MAIL_RENDERED = 5;

/**
 * Format unread mail for injection into agent dispatch context.
 *
 * Rules (see issue where a "favorite color" test task got 10 queued
 * roll_call blocks in a single dispatch):
 *  - Roll-call mail is single-use: only the newest roll_call is rendered,
 *    older ones are collapsed into a one-line summary, and ALL roll_call
 *    rows are deleted (not just marked read) so they can never re-appear.
 *    The durable record lives in `rollcall_entries`.
 *  - Other mail is capped at MAX_MAIL_RENDERED most-recent entries with
 *    an overflow line for the remainder. Rendered entries are marked
 *    read; unrendered overflow stays unread so the next dispatch sees it.
 */
export function formatMailForDispatch(agentId: string): string | null {
  const messages = getUnreadMail(agentId); // ORDER BY created_at ASC
  if (messages.length === 0) return null;

  const rollCalls: AgentMailMessage[] = [];
  const others: AgentMailMessage[] = [];
  for (const msg of messages) {
    if (msg.subject && ROLL_CALL_SUBJECT_RE.test(msg.subject)) {
      rollCalls.push(msg);
    } else {
      others.push(msg);
    }
  }

  const lines: string[] = [];

  if (rollCalls.length > 0) {
    // Newest roll_call (getUnreadMail is ASC, so the last element is newest)
    const newest = rollCalls[rollCalls.length - 1];
    const from = (newest as AgentMailMessage & { from_agent_name?: string }).from_agent_name || newest.from_agent_id;
    const subjectLine = newest.subject ? ` (${newest.subject})` : '';
    lines.push(`- From **${from}**${subjectLine}: ${newest.body}`);
    if (rollCalls.length > 1) {
      lines.push(`- _(${rollCalls.length - 1} older roll_call request(s) collapsed — only the newest is shown; stale ones were discarded.)_`);
    }
    // Delete every roll_call row — they are one-shot and the durable
    // state lives in rollcall_entries. Keeping them around is what caused
    // the original "10 roll_calls concatenated into one prompt" bug.
    for (const msg of rollCalls) {
      run('DELETE FROM agent_mailbox WHERE id = ?', [msg.id]);
    }
  }

  // Render the most-recent N non-roll_call messages; summarise overflow.
  const rendered = others.slice(-MAX_MAIL_RENDERED);
  const overflow = others.length - rendered.length;
  for (const msg of rendered) {
    const from = (msg as AgentMailMessage & { from_agent_name?: string }).from_agent_name || msg.from_agent_id;
    const subjectLine = msg.subject ? ` (${msg.subject})` : '';
    lines.push(`- From **${from}**${subjectLine}: ${msg.body}`);
    markAsRead(msg.id);
  }
  if (overflow > 0) {
    lines.push(`- _(${overflow} older message(s) omitted — still unread and will surface on the next dispatch.)_`);
  }

  if (lines.length === 0) return null;
  return '\n📬 **Messages from your convoy teammates:**\n' + lines.join('\n') + '\n';
}
