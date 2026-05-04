'use client';

/**
 * Tiny hook that asks the existing /api/agents endpoint two questions
 * the Research surface needs to answer before letting the operator
 * dispatch a brief:
 *
 *   1. Does this workspace have a researcher in its roster?
 *   2. Is there a runner agent registered (any workspace) so
 *      dispatchScope can host the session?
 *
 * Both are needed for a brief to succeed; if either is missing we
 * surface a banner on /research and a warning dot on the nav.
 *
 * Uses the same `useMissionControl().events` SSE stream the rest of
 * the research surface uses, so the warning clears live when the
 * operator adds a researcher via the picker.
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
  /** True iff both prerequisites are met. */
  ok: boolean;
  refresh: () => void;
}

export function useResearchPreflight(workspaceId: string | null | undefined): ResearchPreflight {
  const { events } = useMissionControl();
  const [loading, setLoading] = useState(false);
  const [hasResearcher, setHasResearcher] = useState(false);
  const [hasRunner, setHasRunner] = useState(false);

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

  return {
    loading,
    hasResearcher,
    hasRunner,
    ok: hasResearcher && hasRunner,
    refresh,
  };
}
