'use client';

/**
 * /activity is now a thin redirect: instead of asking the operator to
 * pick a workspace, route directly to the currently-selected
 * workspace's activity dashboard. The workspace switcher at the top
 * of the left nav already declares "which workspace am I working in?"
 * — making the operator click again here was a wasted step.
 *
 * Edge cases:
 *   - No workspaces yet → render an empty state with a link to
 *     /settings/workspaces. (Previously the picker rendered the same
 *     empty state.)
 *   - Workspaces still loading → render a small spinner so we don't
 *     flash "no workspaces" before the fetch returns.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Activity } from 'lucide-react';
import { useCurrentWorkspaceId } from '@/components/shell/workspace-context';
import type { Workspace } from '@/lib/types';

export default function ActivityRedirectPage() {
  const router = useRouter();
  const currentWorkspaceId = useCurrentWorkspaceId();
  const [state, setState] = useState<'loading' | 'empty'>('loading');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/workspaces');
        if (!res.ok) {
          if (!cancelled) setState('empty');
          return;
        }
        const ws: Workspace[] = await res.json();
        if (cancelled) return;
        if (ws.length === 0) {
          setState('empty');
          return;
        }
        // Prefer the workspace the user has currently selected; fall
        // back to the first one if their selected id no longer exists
        // (e.g. it was deleted).
        const target =
          ws.find(w => w.id === currentWorkspaceId) ?? ws[0];
        router.replace(`/workspace/${target.slug}/activity`);
      } catch {
        if (!cancelled) setState('empty');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentWorkspaceId, router]);

  if (state === 'loading') {
    return (
      <div className="min-h-screen bg-mc-bg flex items-center justify-center">
        <div className="text-center">
          <Activity className="w-8 h-8 text-mc-accent mx-auto mb-3 animate-pulse" />
          <p className="text-mc-text-secondary text-sm">
            Routing to your workspace activity…
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-mc-bg flex items-center justify-center">
      <div className="text-center max-w-md px-6">
        <Activity className="w-12 h-12 text-mc-text-secondary mx-auto mb-4" />
        <h2 className="text-xl font-bold text-mc-text mb-2">No workspaces</h2>
        <p className="text-mc-text-secondary text-sm mb-4">
          Create a workspace to see agent activity.
        </p>
        <Link
          href="/settings/workspaces"
          className="inline-flex items-center px-4 py-2 rounded-lg border border-mc-accent/40 text-mc-accent hover:bg-mc-accent/10 text-sm"
        >
          Open workspace settings
        </Link>
      </div>
    </div>
  );
}
