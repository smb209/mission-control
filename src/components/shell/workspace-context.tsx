'use client';

/**
 * Lightweight context for "which workspace is the operator currently
 * planning against?" — separate from the deep-load WorkspacePage state.
 *
 * The shell needs *one* shared selection so the workspace switcher in the
 * left nav and any plan-page that wants to filter (initiatives / roadmap /
 * pm) agree. We intentionally avoid plumbing this through `useMissionControl`
 * — that store hydrates from SSE and would force every plan page to wire
 * itself up. localStorage gives us a sticky default with zero coupling.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

export interface WorkspaceLite {
  id: string;
  slug: string;
  name: string;
  icon?: string | null;
}

const STORAGE_KEY = 'mc.currentWorkspaceId';
const DEFAULT_ID = 'default';

interface WorkspaceContextValue {
  currentWorkspaceId: string;
  setCurrentWorkspaceId: (id: string) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [currentWorkspaceId, setCurrentWorkspaceIdState] = useState<string>(DEFAULT_ID);

  // Hydrate from localStorage on mount. SSR returns DEFAULT_ID so the
  // markup is stable.
  //
  // Self-heal: if the cached id doesn't match any existing workspace
  // (e.g. the workspace was deleted by a `yarn db:reset` since the
  // last visit), fall back to DEFAULT_ID and clear the stale entry.
  // Without this, modals like DiscoverAgentsModal would post the
  // dead id and trigger an opaque FK violation in the API.
  useEffect(() => {
    let cancelled = false;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch { /* private mode etc. */ }
    if (!stored || stored === DEFAULT_ID) {
      if (stored === DEFAULT_ID) setCurrentWorkspaceIdState(DEFAULT_ID);
      return;
    }
    // Optimistically apply the cached id while validation runs — most
    // sessions are continuing where they left off; we don't want the UI
    // to flicker through DEFAULT_ID for the round-trip.
    setCurrentWorkspaceIdState(stored);
    (async () => {
      try {
        const res = await fetch('/api/workspaces');
        if (!res.ok) return;
        const list = (await res.json()) as Array<{ id: string }>;
        if (cancelled) return;
        const stillExists = Array.isArray(list) && list.some((w) => w.id === stored);
        if (!stillExists) {
          setCurrentWorkspaceIdState(DEFAULT_ID);
          try {
            window.localStorage.removeItem(STORAGE_KEY);
          } catch { /* ignore */ }
        }
      } catch {
        // Network blip — keep the cached id; next mount retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setCurrentWorkspaceId = useCallback((id: string) => {
    setCurrentWorkspaceIdState(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch { /* ignore */ }
  }, []);

  const value = useMemo(
    () => ({ currentWorkspaceId, setCurrentWorkspaceId }),
    [currentWorkspaceId, setCurrentWorkspaceId],
  );

  return (
    <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
  );
}

export function useCurrentWorkspaceId(): string {
  const ctx = useContext(WorkspaceContext);
  return ctx?.currentWorkspaceId ?? DEFAULT_ID;
}

export function useSetCurrentWorkspaceId(): (id: string) => void {
  const ctx = useContext(WorkspaceContext);
  return ctx?.setCurrentWorkspaceId ?? (() => { /* no-op outside provider */ });
}
