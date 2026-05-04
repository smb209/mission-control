/**
 * Persona-init injection for direct chat with MC-managed personas.
 *
 * Background: the org runner (`mc-runner` / `mc-runner-dev`) is the
 * actual gateway agent that hosts every MC persona session. It has its
 * own SOUL/USER/AGENTS describing "I'm a neutral runner — adopt the
 * role the briefing assigns." For *task dispatches* the briefing
 * (built by `lib/agents/briefing.ts`) carries role-template markdown
 * to the runner.
 *
 * For *direct chat* with a local persona (e.g. operator chats with
 * "Arg Matey"), no dispatch briefing exists — the runner just sees
 * the user's text and replies as itself. The agent's per-row
 * `soul_md` / `user_md` / `agents_md` columns aren't relayed
 * anywhere.
 *
 * This module fixes that by prepending a one-shot "persona init" block
 * to the first chat message of a session (and after every `/reset`).
 * The block has clear delimiters so the runner can recognize it and
 * adopt the persona for the rest of the session — see
 * `agent-templates/runner-host/SOUL.md` for the runner-side contract.
 *
 * Why session-scoped (not per-message): the runner remembers context
 * across turns inside one session. Re-sending the persona on every
 * turn would burn tokens and risk drift if the operator edits the
 * markdown mid-session. Operators trigger `/reset` (sidebar or per-
 * agent) when they want the persona reloaded.
 */

import { queryOne, run } from '@/lib/db';
import type { Agent } from '@/lib/types';

/**
 * Has this MC agent already had a session bootstrapped on the
 * gateway? We use the existence of a row in `openclaw_sessions` for
 * this agent (status='active') as the signal — `/reset` clears those
 * rows, and the very first chat send for a fresh agent will find none.
 */
export function hasActiveOpenClawSession(agentId: string): boolean {
  const row = queryOne<{ id: string }>(
    `SELECT id FROM openclaw_sessions WHERE agent_id = ? AND status = 'active' LIMIT 1`,
    [agentId],
  );
  return !!row;
}

/**
 * Mark the session as initialized so subsequent chats skip the
 * persona-init injection. Idempotent — if a row already exists for
 * this agent, leave it alone; otherwise INSERT a new one. The
 * `sessionKey` argument is the literal gateway sessionKey we just
 * sent on (e.g. `agent:mc-runner-dev:arg-matey:chat-0fca4045`); we
 * store it verbatim so the per-session reset endpoint can route
 * `/reset` to the actual session and the gateway clears the right
 * one. (Earlier versions stored a synthetic `mc-persona-<id>` marker
 * here, which made Reset fire `/reset` at a non-existent sessionKey
 * and leave the real chat session intact.)
 */
export function markSessionInitialized(agentId: string, sessionKey: string): void {
  if (hasActiveOpenClawSession(agentId)) return;
  const now = new Date().toISOString();
  run(
    `INSERT INTO openclaw_sessions
       (id, agent_id, openclaw_session_id, channel, status, session_type, created_at, updated_at)
     VALUES (lower(hex(randomblob(16))), ?, ?, 'mission-control', 'active', 'persistent', ?, ?)`,
    [agentId, sessionKey, now, now],
  );
}

/**
 * Build the persona-init block prepended to the first chat message
 * after a fresh start / reset. Returns null when the agent has no
 * persona content at all (gateway-synced agents that haven't been
 * customised, or local agents the operator hasn't filled in yet) —
 * the caller should send the user's message as-is in that case.
 */
export const DEFAULT_SOUL_HEADER = 'Who you are';
export const DEFAULT_USER_HEADER = 'Who the operator is';
export const DEFAULT_AGENTS_HEADER = 'Your team';

export function buildPersonaInitBlock(
  agent: Pick<
    Agent,
    'name' | 'soul_md' | 'user_md' | 'agents_md' | 'soul_header' | 'user_header' | 'agents_header'
  >,
): string | null {
  const soul = agent.soul_md?.trim();
  const user = agent.user_md?.trim();
  const agents = agent.agents_md?.trim();
  if (!soul && !user && !agents) return null;

  const soulH = agent.soul_header?.trim() || DEFAULT_SOUL_HEADER;
  const userH = agent.user_header?.trim() || DEFAULT_USER_HEADER;
  const agentsH = agent.agents_header?.trim() || DEFAULT_AGENTS_HEADER;

  const sections: string[] = [];
  if (soul) sections.push(`## ${soulH}\n\n${soul}`);
  if (user) sections.push(`## ${userH}\n\n${user}`);
  if (agents) sections.push(`## ${agentsH}\n\n${agents}`);

  return [
    '<<<MC_PERSONA_INIT>>>',
    `**Mission Control persona init for "${agent.name}"** — adopt this persona for the rest of the session. These identity files are managed by the operator in MC; they will not be re-sent unless the operator triggers a session reset (\`/reset\`). The actual user message follows the closing marker below.`,
    '',
    sections.join('\n\n'),
    '<<<END_MC_PERSONA_INIT>>>',
    '',
  ].join('\n');
}
