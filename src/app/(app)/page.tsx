'use client';

/**
 * Home redirect.
 *
 * The All-Workspaces card view was removed in Polish D — workspace
 * selection lives in the left-nav switcher now. Hitting `/` should drop
 * the operator straight into the active workspace's task board. When no
 * workspaces exist (fresh install / nuked db), we show a small empty
 * state with a "Create your first workspace" CTA that opens the same
 * drawer used by the switcher's `+ New workspace` entry.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Folder, Plus } from 'lucide-react';
import { useCurrentWorkspaceId } from '@/components/shell/workspace-context';
import { CreateWorkspaceDrawer } from '@/components/shell/CreateWorkspaceDrawer';
import type { WorkspaceLite } from '@/components/shell/workspace-context';

export default function HomePage() {
  const router = useRouter();
  const currentWorkspaceId = useCurrentWorkspaceId();

  const [workspaces, setWorkspaces] = useState<WorkspaceLite[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Fetch the workspace list once on mount. Cheap query.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/workspaces')
      .then(r => (r.ok ? r.json() : []))
      .then((rows: WorkspaceLite[]) => {
        if (cancelled) return;
        setWorkspaces(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([]);
      });
    return () => { cancelled = true; };
  }, []);

  // Pick the workspace to redirect to: prefer the active one, fall back
  // to the first available.
  const target = useMemo(() => {
    if (!workspaces || workspaces.length === 0) return null;
    const active = workspaces.find(w => w.id === currentWorkspaceId);
    return active ?? workspaces[0];
  }, [workspaces, currentWorkspaceId]);

  // Once we know where to go, replace the URL so the browser back button
  // doesn't bounce the operator back to this redirect shell.
  useEffect(() => {
    if (!target) return;
    router.replace(`/workspace/${target.slug}`);
  }, [target, router]);

  if (workspaces === null) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-mc-text-secondary text-sm">Loading…</div>
      </div>
    );
  }

  if (workspaces.length === 0) {
    return (
      <>
        <div className="h-full flex items-center justify-center px-4">
          <div className="max-w-md text-center">
            <div className="w-14 h-14 rounded-full bg-mc-bg-tertiary border border-mc-border flex items-center justify-center mx-auto mb-4">
              <Folder className="w-7 h-7 text-mc-text-secondary" />
            </div>
            <h1 className="text-xl font-semibold mb-1">No workspaces yet</h1>
            <p className="text-mc-text-secondary text-sm mb-5">
              A workspace is a container for tasks, agents, and initiatives. Create your first one to start dispatching work.
            </p>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-mc-accent text-mc-bg rounded-sm font-medium hover:bg-mc-accent/90"
            >
              <Plus className="w-4 h-4" />
              Create your first workspace
            </button>
          </div>
        </div>
        <CreateWorkspaceDrawer
          open={createOpen}
          onClose={() => setCreateOpen(false)}
        />
      </>
    );
  }

  // We have a target — render a quiet placeholder while the redirect
  // takes effect. Should be ~1 frame.
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-mc-text-secondary text-sm">Loading {target?.name}…</div>
    </div>
  );
}
