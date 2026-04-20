import type { Agent } from '@/lib/types';

/**
 * Resolve the OpenClaw sessionKey prefix for a target agent.
 *
 * Priority:
 *   1. `agent.session_key_prefix` if explicitly set (operator override).
 *   2. `agent:<gateway_agent_id>:` — preferred for gateway-synced agents,
 *      because the gateway treats `agent:<agentId>:<...>` as the agent's
 *      own namespace (see OpenClaw session-routing docs).
 *   3. `agent:<slugified_name>:` — last-resort fallback for local/manual
 *      agents that have never been linked to a gateway agent.
 *
 * Previously the default was a hard-coded `agent:main:` which silently
 * routed every MC→agent chat.send to the gateway's "main" agent
 * regardless of which agent MC intended to reach. That masked test
 * failures (e.g. roll-call's "no session" results) and misrouted real
 * dispatches. Every call site that builds a sessionKey should use this
 * helper so the change lands uniformly.
 */
export function resolveAgentSessionKeyPrefix(
  agent: Pick<Agent, 'session_key_prefix' | 'gateway_agent_id' | 'name'>
): string {
  const explicit = agent.session_key_prefix?.trim();
  if (explicit) {
    return explicit.endsWith(':') ? explicit : `${explicit}:`;
  }
  if (agent.gateway_agent_id) {
    return `agent:${agent.gateway_agent_id}:`;
  }
  const slug = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `agent:${slug || 'unknown'}:`;
}
