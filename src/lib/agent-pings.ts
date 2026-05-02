/**
 * Per-agent ping tracker — lightweight, in-memory signal of when MC last
 * sent a message to each agent and when it last heard back. Powers the
 * sidebar "up/down arrow" indicators that fade from green to gray over 60
 * seconds so the operator can see at a glance which agents are currently
 * exchanging traffic.
 *
 * This is deliberately in-memory. The indicator is a *liveness cue*, not
 * a durable log — if the server restarts, indicators reset to gray and
 * re-populate as real traffic flows. For durable history use the debug
 * console (`/debug`) which persists to SQLite.
 */
import { queryAll } from '@/lib/db';
import { broadcast } from '@/lib/events';

export type PingDirection = 'sent' | 'received';

interface AgentPing {
  sentAt?: string;      // ISO timestamp of last MC → agent message
  receivedAt?: string;  // ISO timestamp of last agent → MC message
}

const pings = new Map<string, AgentPing>();

// Cached sessionKey-prefix → agentId index. We match an inbound/outbound
// sessionKey against every active agent's session_key_prefix; refreshing
// per-event would hammer SQLite, so the index is cached and rebuilt at
// most every few seconds.
interface PrefixEntry { agentId: string; prefix: string }
let prefixIndex: PrefixEntry[] | null = null;
let prefixIndexRefreshedAt = 0;
const PREFIX_INDEX_TTL_MS = 5_000;

function refreshPrefixIndex(): void {
  const now = Date.now();
  if (prefixIndex && now - prefixIndexRefreshedAt < PREFIX_INDEX_TTL_MS) return;
  try {
    const rows = queryAll<{ id: string; session_key_prefix: string | null; gateway_agent_id: string | null; name: string }>(
      `SELECT id, session_key_prefix, gateway_agent_id, name FROM agents`
    );
    const entries: PrefixEntry[] = [];
    for (const r of rows) {
      // Mirror resolveAgentSessionKeyPrefix() priority: explicit override,
      // then gateway id, then name slug. We don't import the helper here to
      // avoid a db ← session-key ← db cycle — the fallback logic is short.
      const explicit = r.session_key_prefix?.trim();
      let prefix: string | null = null;
      if (explicit) {
        prefix = explicit.endsWith(':') ? explicit : `${explicit}:`;
      } else if (r.gateway_agent_id) {
        prefix = `agent:${r.gateway_agent_id}:`;
      } else {
        const slug = r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (slug) prefix = `agent:${slug}:`;
      }
      if (prefix) {
        entries.push({ agentId: r.id, prefix });
        // Mirror buildAgentSessionKey's collapse rule: when an explicit
        // prefix already encodes `:main:` and the caller asks for the
        // `main` suffix, the helper strips the trailing `:` so we don't
        // emit `…:main:main`. The wire sessionKey is therefore one char
        // shorter than the indexed prefix, and `startsWith` would miss
        // it. Push the collapsed form too so the inbound/outbound ping
        // resolver matches the same sessionKey the gateway actually saw.
        // Without this, the PM (the only seeded agent with an explicit
        // `:main:` prefix today) never lit up the activity dot.
        if (/:main:$/.test(prefix)) {
          entries.push({ agentId: r.id, prefix: prefix.slice(0, -1) });
        }
      }
    }
    // Sort by prefix length desc so more-specific prefixes win when they
    // happen to overlap (e.g. "agent:mc-builder-2:" vs "agent:mc-builder:").
    entries.sort((a, b) => b.prefix.length - a.prefix.length);
    prefixIndex = entries;
    prefixIndexRefreshedAt = now;
  } catch {
    // DB not ready (e.g. during instrumentation boot) — leave index null and
    // retry on the next call. Callers treat null as "no match".
    prefixIndex = prefixIndex ?? [];
  }
}

export function resolveAgentIdFromSessionKey(sessionKey: string | null | undefined): string | null {
  if (!sessionKey) return null;
  refreshPrefixIndex();
  for (const entry of prefixIndex ?? []) {
    if (sessionKey.startsWith(entry.prefix)) return entry.agentId;
  }
  return null;
}

/**
 * Resolve every agent row whose prefix matches this sessionKey. When agents
 * are cloned across workspaces they share `gateway_agent_id`, so the same
 * sessionKey maps to one row per workspace. We need to ping all of them so
 * each workspace's sidebar dot lights up — single-winner resolution silently
 * starved cloned-workspace rows of activity signal.
 */
export function resolveAllAgentIdsFromSessionKey(sessionKey: string | null | undefined): string[] {
  if (!sessionKey) return [];
  refreshPrefixIndex();
  const matches: string[] = [];
  let bestPrefixLen = 0;
  for (const entry of prefixIndex ?? []) {
    if (!sessionKey.startsWith(entry.prefix)) continue;
    // Index is sorted longest-prefix-first. Once we've found the most
    // specific prefix, only collect siblings with the *same* prefix length —
    // shorter prefixes are less-specific matches we'd previously have
    // skipped under single-winner resolution.
    if (matches.length === 0) {
      bestPrefixLen = entry.prefix.length;
      matches.push(entry.agentId);
    } else if (entry.prefix.length === bestPrefixLen) {
      matches.push(entry.agentId);
    } else {
      break;
    }
  }
  return matches;
}

/**
 * Record a ping for an agent and broadcast it to SSE subscribers. Safe to
 * call from any traffic path — a missing/unresolvable agentId is a no-op.
 */
export function pingAgent(agentId: string | null | undefined, direction: PingDirection): void {
  if (!agentId) return;
  const at = new Date().toISOString();
  const existing = pings.get(agentId) ?? {};
  if (direction === 'sent') existing.sentAt = at;
  else existing.receivedAt = at;
  pings.set(agentId, existing);
  broadcast({ type: 'agent_pinged', payload: { agentId, direction, at } });
}

/**
 * Convenience: resolve from sessionKey + ping in one call. Returns true if
 * the sessionKey mapped to a known agent (useful for callers that want to
 * know whether the ping landed).
 */
export function pingAgentBySessionKey(sessionKey: string | null | undefined, direction: PingDirection): boolean {
  const agentIds = resolveAllAgentIdsFromSessionKey(sessionKey);
  if (agentIds.length === 0) return false;
  for (const agentId of agentIds) pingAgent(agentId, direction);
  return true;
}

export function getAllAgentPings(): Record<string, AgentPing> {
  const out: Record<string, AgentPing> = {};
  for (const [agentId, p] of pings.entries()) {
    out[agentId] = { ...p };
  }
  return out;
}

/**
 * Test-only: clear all pings. Not exported from any barrel; reach for it
 * directly from the test file if you ever need to reset between cases.
 */
export function __resetPingsForTests(): void {
  pings.clear();
  prefixIndex = null;
  prefixIndexRefreshedAt = 0;
}
