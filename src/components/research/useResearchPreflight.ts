'use client';

/**
 * Tiny hook that asks three questions the Research surface needs to
 * answer before letting the operator dispatch a brief:
 *
 *   1. Does this workspace have a researcher in its roster?
 *   2. Is there a runner agent registered (any workspace) so
 *      dispatchScope can host the session?
 *   3. Is the openclaw gateway client currently connected?
 *
 * All three are needed; if any is missing we surface a banner on
 * /research and a warning dot on the nav.
 *
 * Uses SSE for the agent-roster checks and a 5-second poll for the
 * gateway-connection check (the openclaw client doesn't currently
 * emit connection-state events to the SSE bus, so polling is the
 * pragmatic floor — fast enough to clear within seconds of an HMR
 * reconnect, cheap enough to leave running).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMissionControl } from '@/lib/store';

const RELEVANT_AGENT_EVENTS = [
  'agent_spawned',
  'agents_cleared',
] as const;

interface AgentRow {
  id: string;
  role: string;
  is_active?: number;
  source?: string;
  gateway_agent_id?: string;
  workspace_id: string;
}

export interface ResearchPreflight {
  loading: boolean;
  hasResearcher: boolean;
  hasRunner: boolean;
  gatewayConnected: boolean;
  /** True iff all three prerequisites are met. */
  ok: boolean;
  refresh: () => void;
}

const GATEWAY_POLL_INTERVAL_MS = 5_000;

export function useResearchPreflight(workspaceId: string | null | undefined): ResearchPreflight {
  const { events } = useMissionControl();
  const [loading, setLoading] = useState(false);
  const [hasResearcher, setHasResearcher] = useState(false);
  const [hasRunner, setHasRunner] = useState(false);
  // Optimistic default — assume the gateway is connected and let the
  // first poll correct us. Otherwise the banner flashes "reconnecting"
  // for a fraction of a second on every page load.
  const [gatewayConnected, setGatewayConnected] = useState(true);

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setHasResearcher(false);
      setHasRunner(false);
      return;
    }
    setLoading(true);
    try {
      // Workspace-scoped fetch for the researcher check.
      const wsRows: AgentRow[] = await fetch(`/api/agents?workspace_id=${encodeURIComponent(workspaceId)}`)
        .then(r => r.ok ? r.json() : []);
      setHasResearcher(
        wsRows.some(a => a.role === 'researcher' && (a.is_active ?? 1) === 1),
      );

      // Runner check is global (single mc-runner-dev row in `default`
      // hosts every workspace's sessions). Cheapest is to hit /api/agents
      // unscoped and look for any runner row.
      const allRows: AgentRow[] = await fetch(`/api/agents`)
        .then(r => r.ok ? r.json() : []);
      setHasRunner(
        allRows.some(a =>
          a.role === 'runner' &&
          (a.gateway_agent_id === 'mc-runner-dev' || a.gateway_agent_id === 'mc-runner'),
        ),
      );
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Re-check when agent inventory changes.
  const latestEventId = useMemo(
    () => events.find(e => RELEVANT_AGENT_EVENTS.includes(e.type as typeof RELEVANT_AGENT_EVENTS[number]))?.id,
    [events],
  );
  useEffect(() => { if (latestEventId) refresh(); }, [latestEventId, refresh]);

  // Gateway connection poll. Light — a single GET that just reads
  // client.isConnected(); no side effects.
  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const r = await fetch('/api/openclaw/connection');
        if (!r.ok) return;
        const { connected } = (await r.json()) as { connected: boolean };
        if (!cancelled) setGatewayConnected(!!connected);
      } catch {
        if (!cancelled) setGatewayConnected(false);
      }
    };
    probe();
    const id = setInterval(probe, GATEWAY_POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return {
    loading,
    hasResearcher,
    hasRunner,
    gatewayConnected,
    ok: hasResearcher && hasRunner && gatewayConnected,
    refresh,
  };
}
