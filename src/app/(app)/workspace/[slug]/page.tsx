'use client';

/**
 * Per-workspace task board ("Mission Queue"). After Polish D this page lives
 * inside the `(app)` route group, so the unified left-nav shell renders
 * around it. The previous standalone Header (with its own nav buttons) was
 * removed in favor of the shell — we still emit a workspace-internal
 * mobile bottom tab bar for switching between Queue / Agents / Feed /
 * Settings panels at small viewport sizes.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft, ListTodo, Activity, Settings as SettingsIcon, ExternalLink, BarChart3 } from 'lucide-react';
import { MissionQueue } from '@/components/MissionQueue';
import { LiveFeed } from '@/components/LiveFeed';
import { ReadyDeliverablesPanel } from '@/components/ReadyDeliverablesPanel';
import { SSEDebugPanel } from '@/components/SSEDebugPanel';
import { useMissionControl } from '@/lib/store';
import { debug } from '@/lib/debug';
import { useSetCurrentWorkspaceId } from '@/components/shell/workspace-context';
import type { Task, Workspace } from '@/lib/types';

// 'agents' is intentionally NOT in this union: agents have their own
// /agents page now, so we no longer mirror them on the workspace
// surface (used to be a leftover from the pre-/agents responsive
// layout that ate horizontal real estate even when shrunk).
type MobileTab = 'queue' | 'feed' | 'settings';

export default function WorkspacePage() {
  const params = useParams();
  const slug = params.slug as string;
  const setCurrentWorkspaceId = useSetCurrentWorkspaceId();

  const { setAgents, setTasks, setEvents, setIsOnline, setIsLoading, isLoading } = useMissionControl();

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileTab>('queue');
  const [isPortrait, setIsPortrait] = useState(true);

  // useSSE() now lives in AppShell — every page in the app shell receives
  // live updates without each page re-mounting its own EventSource.

  useEffect(() => {
    const media = window.matchMedia('(orientation: portrait)');
    const updateOrientation = () => setIsPortrait(media.matches);

    updateOrientation();
    media.addEventListener('change', updateOrientation);
    window.addEventListener('resize', updateOrientation);

    return () => {
      media.removeEventListener('change', updateOrientation);
      window.removeEventListener('resize', updateOrientation);
    };
  }, []);

  useEffect(() => {
    async function loadWorkspace() {
      try {
        const res = await fetch(`/api/workspaces/${slug}`);
        if (res.ok) {
          const data = await res.json();
          setWorkspace(data);
          // Sync the shell's active-workspace context to whichever slug
          // we just landed on. Keeps the left-nav switcher in agreement
          // with the URL bar on direct navigation / refresh.
          if (data?.id) setCurrentWorkspaceId(data.id);
        } else if (res.status === 404) {
          setNotFound(true);
          setIsLoading(false);
          return;
        }
      } catch (error) {
        console.error('Failed to load workspace:', error);
        setNotFound(true);
        setIsLoading(false);
        return;
      }
    }

    loadWorkspace();
  }, [slug, setIsLoading, setCurrentWorkspaceId]);

  useEffect(() => {
    // In landscape mode the queue gets a side-panel — default that
    // panel to the live feed (used to default to the agents tab back
    // when agents were rendered here).
    if (!isPortrait && mobileTab === 'queue') {
      setMobileTab('feed');
    }
  }, [isPortrait, mobileTab]);

  useEffect(() => {
    if (!workspace) return;

    const workspaceId = workspace.id;

    async function loadData() {
      try {
        debug.api('Loading workspace data...', { workspaceId });

        const [agentsRes, tasksRes, eventsRes] = await Promise.all([
          fetch(`/api/agents?workspace_id=${workspaceId}`),
          fetch(`/api/tasks?workspace_id=${workspaceId}`),
          fetch('/api/events'),
        ]);

        if (agentsRes.ok) setAgents(await agentsRes.json());
        if (tasksRes.ok) {
          const tasksData = await tasksRes.json();
          debug.api('Loaded tasks', { count: tasksData.length });
          setTasks(tasksData);
        }
        if (eventsRes.ok) setEvents(await eventsRes.json());
      } catch (error) {
        console.error('Failed to load data:', error);
      } finally {
        setIsLoading(false);
      }
    }

    async function checkOpenClaw() {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const openclawRes = await fetch('/api/openclaw/status', { signal: controller.signal });
        clearTimeout(timeoutId);

        if (openclawRes.ok) {
          const status = await openclawRes.json();
          setIsOnline(status.connected);
        }
      } catch {
        setIsOnline(false);
      }
    }

    loadData();
    checkOpenClaw();

    const eventPoll = setInterval(async () => {
      try {
        const res = await fetch('/api/events?limit=20');
        if (res.ok) {
          setEvents(await res.json());
        }
      } catch (error) {
        console.error('Failed to poll events:', error);
      }
    }, 30000);

    const taskPoll = setInterval(async () => {
      try {
        const res = await fetch(`/api/tasks?workspace_id=${workspaceId}`);
        if (res.ok) {
          const newTasks: Task[] = await res.json();
          const currentTasks = useMissionControl.getState().tasks;

          const hasChanges =
            newTasks.length !== currentTasks.length ||
            newTasks.some((t) => {
              const current = currentTasks.find((ct) => ct.id === t.id);
              return !current || current.updated_at !== t.updated_at;
            });

          if (hasChanges) {
            debug.api('[FALLBACK] Task changes detected via polling, updating store');
            setTasks(newTasks);
          }
        }
      } catch (error) {
        console.error('Failed to poll tasks:', error);
      }
    }, 60000);

    const connectionCheck = setInterval(async () => {
      try {
        const res = await fetch('/api/openclaw/status');
        if (res.ok) {
          const status = await res.json();
          setIsOnline(status.connected);
        }
      } catch {
        setIsOnline(false);
      }
    }, 30000);

    return () => {
      clearInterval(eventPoll);
      clearInterval(connectionCheck);
      clearInterval(taskPoll);
    };
  }, [workspace, setAgents, setTasks, setEvents, setIsOnline, setIsLoading]);

  if (notFound) {
    return (
      <div className="h-full bg-mc-bg flex items-center justify-center">
        <div className="text-center">
          <div className="text-6xl mb-4">🔍</div>
          <h1 className="text-2xl font-bold mb-2">Workspace Not Found</h1>
          <p className="text-mc-text-secondary mb-6">The workspace &ldquo;{slug}&rdquo; doesn&apos;t exist.</p>
          <Link href="/" className="inline-flex items-center gap-2 px-6 py-3 bg-mc-accent text-mc-bg rounded-lg font-medium hover:bg-mc-accent/90">
            <ChevronLeft className="w-4 h-4" />
            Back to Mission Control
          </Link>
        </div>
      </div>
    );
  }

  if (isLoading || !workspace) {
    return (
      <div className="h-full bg-mc-bg flex items-center justify-center">
        <div className="text-center">
          <div className="text-4xl mb-4 animate-pulse">🦞</div>
          <p className="text-mc-text-secondary">Loading {slug}...</p>
        </div>
      </div>
    );
  }

  const showMobileBottomTabs = isPortrait;

  return (
    <div className="h-full flex flex-col bg-mc-bg overflow-hidden">
      <div className="hidden lg:flex flex-1 overflow-hidden">
        {/*
          Agent roster lives on its own /agents page now — the
          workspace shows just queue + live feed regardless of
          viewport size. Removes the artifact where shrinking the
          window made an agents panel pop in over the right side.
        */}
        <MissionQueue workspaceId={workspace.id} />
        <LiveFeed topSlot={<ReadyDeliverablesPanel workspaceId={workspace.id} />} />
      </div>

      <div
        className={`lg:hidden flex-1 overflow-hidden ${
          showMobileBottomTabs ? 'pb-[calc(4.5rem+env(safe-area-inset-bottom))]' : 'pb-[env(safe-area-inset-bottom)]'
        }`}
      >
        {isPortrait ? (
          <>
            {mobileTab === 'queue' && <MissionQueue workspaceId={workspace.id} mobileMode isPortrait />}
            {mobileTab === 'feed' && (
              <div className="h-full p-3 overflow-y-auto">
                <LiveFeed mobileMode isPortrait />
              </div>
            )}
            {mobileTab === 'settings' && <MobileSettingsPanel workspace={workspace} />}
          </>
        ) : (
          <div className="h-full p-3 grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-3">
            <MissionQueue workspaceId={workspace.id} mobileMode isPortrait={false} />
            <div className="min-w-0 h-full flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setMobileTab('feed')}
                  className={`min-h-11 rounded-lg text-xs ${mobileTab === 'feed' ? 'bg-mc-accent text-mc-bg font-medium' : 'bg-mc-bg-secondary border border-mc-border text-mc-text-secondary'}`}
                >
                  Feed
                </button>
                <button
                  onClick={() => setMobileTab('settings')}
                  className={`min-h-11 rounded-lg text-xs ${mobileTab === 'settings' ? 'bg-mc-accent text-mc-bg font-medium' : 'bg-mc-bg-secondary border border-mc-border text-mc-text-secondary'}`}
                >
                  Settings
                </button>
              </div>

              <div className="min-h-0 flex-1">
                {mobileTab === 'settings' ? (
                  <MobileSettingsPanel workspace={workspace} denseLandscape />
                ) : (
                  <LiveFeed mobileMode isPortrait={false} />
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {showMobileBottomTabs && (
        <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-30 border-t border-mc-border bg-mc-bg-secondary pb-[env(safe-area-inset-bottom)]">
          <div className="grid grid-cols-3 gap-1 p-2">
            <MobileTabButton label="Queue" active={mobileTab === 'queue'} icon={<ListTodo className="w-5 h-5" />} onClick={() => setMobileTab('queue')} />
            <MobileTabButton label="Feed" active={mobileTab === 'feed'} icon={<Activity className="w-5 h-5" />} onClick={() => setMobileTab('feed')} />
            <MobileTabButton label="Settings" active={mobileTab === 'settings'} icon={<SettingsIcon className="w-5 h-5" />} onClick={() => setMobileTab('settings')} />
          </div>
        </nav>
      )}

      <SSEDebugPanel />
    </div>
  );
}

function MobileTabButton({ label, active, icon, onClick }: { label: string; active: boolean; icon: ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`min-h-11 rounded-lg flex flex-col items-center justify-center text-xs ${
        active ? 'bg-mc-accent text-mc-bg font-medium' : 'text-mc-text-secondary'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function MobileSettingsPanel({ workspace, denseLandscape = false }: { workspace: Workspace; denseLandscape?: boolean }) {
  return (
    <div className={`h-full overflow-y-auto ${denseLandscape ? 'p-0 pb-[env(safe-area-inset-bottom)]' : 'p-3 pb-[calc(1rem+env(safe-area-inset-bottom))]'}`}>
      <div className="space-y-3">
        <div className="bg-mc-bg-secondary border border-mc-border rounded-lg p-4">
          <div className="text-sm text-mc-text-secondary mb-2">Current workspace</div>
          <div className="flex items-center gap-2 text-base font-medium">
            <span>{workspace.icon}</span>
            <span>{workspace.name}</span>
          </div>
          <div className="text-xs text-mc-text-secondary mt-1">/{workspace.slug}</div>
        </div>


        <Link href={`/workspace/${workspace.slug}/activity`} className="w-full min-h-11 px-4 rounded-lg border border-mc-border bg-mc-bg-secondary flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4" />
            Agent Activity Dashboard
          </span>
          <ExternalLink className="w-4 h-4 text-mc-text-secondary" />
        </Link>
        <Link href="/settings" className="w-full min-h-11 px-4 rounded-lg border border-mc-border bg-mc-bg-secondary flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <SettingsIcon className="w-4 h-4" />
            Open Mission Control Settings
          </span>
          <ExternalLink className="w-4 h-4 text-mc-text-secondary" />
        </Link>
        <Link href="/settings/workspaces" className="w-full min-h-11 px-4 rounded-lg border border-mc-border bg-mc-bg-secondary flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <SettingsIcon className="w-4 h-4" />
            Manage Workspaces
          </span>
          <ExternalLink className="w-4 h-4 text-mc-text-secondary" />
        </Link>
      </div>
    </div>
  );
}
