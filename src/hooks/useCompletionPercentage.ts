'use client';

/**
 * Data hook for computing initiative completion percentage.
 *
 * Reads children of a given initiative and counts how many are `done`
 * (ignores `cancelled` and all other statuses).
 *
 * Returns:
 *   - `done`: number of children with status === 'done'
 *   - `total`: total number of non-archived children
 *   - `percentage`: integer 0–100 (0 when total === 0)
 *   - `label`: human-readable string like "3/7 done"
 *
 * Real-time updates: TODO. MC doesn't currently broadcast
 * `initiative_created` / `_updated` / `_deleted` SSE events, so the
 * hook can't subscribe to a live feed today. The label refreshes on
 * mount and whenever `initiativeId` changes; for in-place updates the
 * parent surface needs to re-key/re-mount, or this hook needs to
 * subscribe to a future initiative-level SSE channel. Either path is a
 * separate piece of work — track via the initiative-events build plan.
 */

import { useState, useEffect, useCallback } from 'react';

export interface CompletionResult {
  done: number;
  total: number;
  percentage: number;
  label: string;
}

function computeLabel(done: number, total: number): string {
  if (total === 0) return '0/0';
  return `${done}/${total} done`;
}

function computePercentage(done: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((done / total) * 100);
}

export function useCompletionPercentage(initiativeId: string | null): CompletionResult {
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);

  const fetchChildren = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/initiatives/${encodeURIComponent(id)}?include=children`);
      if (!res.ok) return;
      const data = await res.json();
      const children = (data.children ?? []) as Array<{ id: string; status: string }>;
      setTotal(children.length);
      setDone(children.filter((c) => c.status === 'done').length);
    } catch {
      // Non-fatal — leave stale values until the next mount / id change.
    }
  }, []);

  useEffect(() => {
    if (!initiativeId) {
      setDone(0);
      setTotal(0);
      return;
    }
    fetchChildren(initiativeId);
  }, [initiativeId, fetchChildren]);

  return {
    done,
    total,
    percentage: computePercentage(done, total),
    label: computeLabel(done, total),
  };
}
