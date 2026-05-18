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
 * Real-time updates: polls `/api/initiatives/:id?include=children`
 * every 5 seconds so the bar stays current as children transition
 * between statuses.  Uses an AbortController so the interval is
 * cleanly cancelled on unmount or when `initiativeId` changes.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

export interface CompletionResult {
  done: number;
  total: number;
  percentage: number;
  label: string;
}

const POLL_MS = 5000;

function computeLabel(done: number, total: number): string {
  if (total === 0) return '0/0';
  return `${done}/${total} done`;
}

function computePercentage(done: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((done / total) * 100);
}

function fetchChildrenData(id: string): Promise<{ done: number; total: number }> {
  return fetch(`/api/initiatives/${encodeURIComponent(id)}?include=children`)
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      const children = (data.children ?? []) as Array<{ id: string; status: string }>;
      const total = children.length;
      const done = children.filter((c) => c.status === 'done').length;
      return { done, total };
    });
}

export function useCompletionPercentage(initiativeId: string | null): CompletionResult {
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(false);

  // One-shot fetch on mount / id change, then start polling.
  useEffect(() => {
    mountedRef.current = true;

    if (!initiativeId) {
      // Use setTimeout to avoid synchronous setState-in-effect warning.
      const timer = setTimeout(() => {
        if (mountedRef.current) {
          setDone(0);
          setTotal(0);
        }
      }, 0);
      return () => clearTimeout(timer);
    }

    let cancelled = false;

    const tick = async () => {
      try {
        const { done: d, total: t } = await fetchChildrenData(initiativeId);
        if (!cancelled && mountedRef.current) {
          setDone(d);
          setTotal(t);
        }
      } catch {
        // Non-fatal — leave stale values until the next tick.
      }
    };

    // Initial fetch
    tick();

    // Poll every 5s
    intervalRef.current = setInterval(tick, POLL_MS);

    return () => {
      cancelled = true;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [initiativeId]);

  return {
    done,
    total,
    percentage: computePercentage(done, total),
    label: computeLabel(done, total),
  };
}
