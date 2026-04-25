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
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) setCurrentWorkspaceIdState(stored);
    } catch { /* private mode etc. */ }
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
