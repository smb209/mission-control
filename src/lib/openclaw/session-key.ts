import type { Agent } from '@/lib/types';
import { preferredRunnerGatewayId } from '@/lib/agent-catalog-sync';

/**
 * Resolve the OpenClaw sessionKey prefix for a target agent.
 *
 * Priority:
 *   1. `agent.session_key_prefix` if explicitly set (operator override).
 *   2. `agent:<gateway_agent_id>:` — preferred for gateway-synced agents,
 *      because the gateway treats `agent:<agentId>:<...>` as the agent's
 *      own namespace (see OpenClaw session-routing docs).
 *   3. `agent:<runner_id>:<slugified_name>:` — fallback for local/manual
 *      agents that have never been linked to a gateway agent. The org
 *      runner (`mc-runner` / `mc-runner-dev`) is the actual session
 *      host; the slug carves out a per-persona namespace under it.
 *      This matches the convention recurring jobs already use
 *      (`agent:mc-runner-dev:main:recurring-{job_id}`) and keeps the
 *      gateway from receiving prefixes for agents it's never seen.
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
  return `agent:${preferredRunnerGatewayId()}:${slug || 'unknown'}:`;
}

// UUID pattern. Exported so other session-key helpers can reuse it.
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * Extract the task UUID from a sessionKey, if present.
 *
 * Per-task session keys (coordinator dispatches, planning sessions) embed
 * the task's UUID as a suffix — e.g.
 *   agent:mc-coordinator:mission-control-coordinator-<UUID>
 *   agent:mc-coordinator:planning:<UUID>
 *
 * Shared per-agent sessions (e.g. agent:mc-researcher:main) have no task
 * identity and return null. The caller must fall back to the runId hint or
 * leave task_id NULL on the debug row rather than guessing.
 */
export function extractTaskIdFromSessionKey(sessionKey: string | null | undefined): string | null {
  if (!sessionKey) return null;
  const m = UUID_RE.exec(sessionKey);
  return m ? m[1] : null;
}

