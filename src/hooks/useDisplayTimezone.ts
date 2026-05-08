'use client';

/**
 * Resolve the display timezone for the current workspace.
 *
 * Reads `workspaces.display_timezone` (an IANA zone name like
 * `America/New_York`) from `/api/workspaces/:id`. Falls back to the
 * browser's auto-detected zone if the workspace hasn't set an
 * override; falls back to America/Los_Angeles only if Intl is
 * unavailable.
 *
 * Cached per-id at module scope so multiple `<Time>` components
 * mounting in a single render don't each fire a fetch. The cache is
 * populated on first read; subsequent renders return synchronously.
 *
 * See specs/timestamp-handling.md §PR-B.
 */

import { useEffect, useState } from 'react';
import { resolveDisplayTimezone } from '@/lib/timestamps';
import { useCurrentWorkspaceId } from '@/components/shell/workspace-context';

const TZ_CACHE = new Map<string, string | null>();
const PENDING = new Map<string, Promise<void>>();

function fetchWorkspaceTz(workspaceId: string): Promise<void> {
  if (PENDING.has(workspaceId)) return PENDING.get(workspaceId)!;
  const p = (async () => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}`);
      if (!res.ok) {
        TZ_CACHE.set(workspaceId, null);
        return;
      }
      const w = (await res.json()) as { display_timezone?: string | null };
      TZ_CACHE.set(workspaceId, w?.display_timezone ?? null);
    } catch {
      TZ_CACHE.set(workspaceId, null);
    } finally {
      PENDING.delete(workspaceId);
    }
  })();
  PENDING.set(workspaceId, p);
  return p;
}

/** Force re-fetch of the cached tz override (call after PATCHing
 *  workspaces). Cheap — most callers don't need this. */
export function invalidateDisplayTimezone(workspaceId: string): void {
  TZ_CACHE.delete(workspaceId);
}

/**
 * Hook returning the resolved IANA timezone string for display.
 * Always returns a usable value (never null) — auto-detect or LA
 * fallback covers the case where the override hasn't loaded yet.
 */
export function useDisplayTimezone(): string {
  const workspaceId = useCurrentWorkspaceId();
  const cached = TZ_CACHE.get(workspaceId);
  const [tz, setTz] = useState<string>(() => resolveDisplayTimezone(cached));

  useEffect(() => {
    if (TZ_CACHE.has(workspaceId)) {
      setTz(resolveDisplayTimezone(TZ_CACHE.get(workspaceId)));
      return;
    }
    let cancelled = false;
    fetchWorkspaceTz(workspaceId).then(() => {
      if (cancelled) return;
      setTz(resolveDisplayTimezone(TZ_CACHE.get(workspaceId)));
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  return tz;
}
