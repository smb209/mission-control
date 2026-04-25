'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Zap, Settings, ChevronLeft, LayoutGrid, Rocket, GanttChart, ListTree, Bot } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import { format } from 'date-fns';
import type { Workspace, Agent, Task, TaskStatus } from '@/lib/types';

// Label + colour map for the "Tasks in Queue" stage breakdown. Kept in
// Header so the tooltip can render a stable order regardless of hash-map
// iteration; counts at zero are hidden.
const STAGE_LABELS: Array<{ status: TaskStatus; label: string; color: string }> = [
  { status: 'inbox', label: 'Inbox', color: 'text-mc-text-secondary' },
  { status: 'pending_dispatch', label: 'Pending dispatch', color: 'text-mc-text-secondary' },
  { status: 'planning', label: 'Planning', color: 'text-blue-400' },
  { status: 'assigned', label: 'Assigned', color: 'text-cyan-400' },
  { status: 'in_progress', label: 'In progress', color: 'text-cyan-400' },
  { status: 'convoy_active', label: 'Convoy active', color: 'text-purple-400' },
  { status: 'testing', label: 'Testing', color: 'text-amber-400' },
  { status: 'verification', label: 'Verification', color: 'text-orange-400' },
];

function ActiveAgentsTooltip({ activeAgents, activeSubAgents }: { activeAgents: Agent[]; activeSubAgents: number }) {
  if (activeAgents.length === 0 && activeSubAgents === 0) {
    return <span className="text-mc-text-secondary">Nothing currently working.</span>;
  }
  return (
    <div className="space-y-1">
      {activeAgents.map(a => (
        <div key={a.id} className="flex items-center gap-2 text-xs">
          <span className="text-base">{a.avatar_emoji}</span>
          <span className="flex-1 truncate">{a.name}</span>
          <span className="text-mc-text-secondary">{a.role}</span>
        </div>
      ))}
      {activeSubAgents > 0 && (
        <div className="text-xs text-mc-text-secondary pt-1 border-t border-mc-border">
          + {activeSubAgents} sub-agent{activeSubAgents === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );
}

function QueuedTasksTooltip({ tasks }: { tasks: Task[] }) {
  const queued = tasks.filter(t => t.status !== 'done' && t.status !== 'review' && t.status !== 'cancelled');
  if (queued.length === 0) {
    return <span className="text-mc-text-secondary">No tasks in queue.</span>;
  }
  const counts: Record<string, number> = {};
  for (const t of queued) counts[t.status] = (counts[t.status] || 0) + 1;
  const rows = STAGE_LABELS
    .map(s => ({ ...s, count: counts[s.status] || 0 }))
    .filter(s => s.count > 0);
  return (
    <div className="space-y-1">
      {rows.map(r => (
        <div key={r.status} className="flex items-center justify-between gap-3 text-xs">
          <span className={r.color}>{r.label}</span>
          <span className="font-mono text-mc-text">{r.count}</span>
        </div>
      ))}
      <div className="text-xs text-mc-text-secondary pt-1 border-t border-mc-border flex justify-between">
        <span>Total</span>
        <span className="font-mono">{queued.length}</span>
      </div>
    </div>
  );
}

interface HeaderProps {
  workspace?: Workspace;
  isPortrait?: boolean;
}

export function Header({ workspace, isPortrait = true }: HeaderProps) {
  const router = useRouter();
  const { agents, tasks, isOnline } = useMissionControl();
  const [currentTime, setCurrentTime] = useState(new Date());
  const [activeSubAgents, setActiveSubAgents] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const loadSubAgentCount = async () => {
      try {
        const res = await fetch('/api/openclaw/sessions?session_type=subagent&status=active');
        if (res.ok) {
          const sessions = await res.json();
          setActiveSubAgents(sessions.length);
        }
      } catch (error) {
        console.error('Failed to load sub-agent count:', error);
      }
    };

    loadSubAgentCount();
    const interval = setInterval(loadSubAgentCount, 30000);
    return () => clearInterval(interval);
  }, []);

  // "Agents active" counts persistent agents currently assigned to a live
  // task. Sub-agent sessions used to be summed in too, but with the new
  // routing model (Coordinator → sessions_send → persistent agents) a
  // sub-agent session is a child of an existing agent, not an additional
  // worker — adding it double-counts. The sub-agent count is still
  // surfaced separately in the sidebar when >0.
  const workingAgentsList = agents.filter((a) => a.status === 'working');
  const activeAgents = workingAgentsList.length;
  const tasksInQueue = tasks.filter((t) => t.status !== 'done' && t.status !== 'review').length;

  const portraitWorkspaceHeader = !!workspace && isPortrait;

  return (
    <header
      className={`bg-mc-bg-secondary border-b border-mc-border px-3 md:px-4 ${
        portraitWorkspaceHeader ? 'py-2.5 space-y-2.5' : 'h-14 flex items-center justify-between gap-2'
      }`}
    >
      {portraitWorkspaceHeader ? (
        <>
          <div className="flex items-center justify-between gap-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <Link href="/" className="flex items-center gap-1 text-mc-text-secondary hover:text-mc-accent transition-colors shrink-0">
                <ChevronLeft className="w-4 h-4" />
                <LayoutGrid className="w-4 h-4" />
              </Link>
              <div className="flex items-center gap-2 px-2.5 py-1.5 bg-mc-bg-tertiary rounded-sm min-w-0">
                <span className="text-base">{workspace.icon}</span>
                <span className="font-medium truncate text-sm">{workspace.name}</span>
              </div>
            </div>

            <Link href="/roadmap" className="min-h-11 min-w-11 p-2 hover:bg-mc-bg-tertiary rounded-sm text-mc-text-secondary" title="Roadmap">
              <GanttChart className="w-5 h-5" />
            </Link>
            <Link href="/initiatives" className="min-h-11 min-w-11 p-2 hover:bg-mc-bg-tertiary rounded-sm text-mc-text-secondary" title="Initiatives">
              <ListTree className="w-5 h-5" />
            </Link>
            <Link href="/pm" className="min-h-11 min-w-11 p-2 hover:bg-mc-bg-tertiary rounded-sm text-mc-text-secondary" title="PM agent">
              <Bot className="w-5 h-5" />
            </Link>
            <Link href="/autopilot" className="min-h-11 min-w-11 p-2 hover:bg-mc-bg-tertiary rounded-sm text-mc-text-secondary" title="Autopilot">
              <Rocket className="w-5 h-5" />
            </Link>
            <button onClick={() => router.push('/settings')} className="min-h-11 min-w-11 p-2 hover:bg-mc-bg-tertiary rounded-sm text-mc-text-secondary shrink-0" title="Settings">
              <Settings className="w-5 h-5" />
            </button>
          </div>

          <div className="flex items-center gap-2 min-w-0">
            <div
              className={`flex items-center gap-2 px-3 min-h-11 rounded border text-xs font-medium ${
                isOnline
                  ? 'bg-mc-accent-green/20 border-mc-accent-green text-mc-accent-green'
                  : 'bg-mc-accent-red/20 border-mc-accent-red text-mc-accent-red'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-mc-accent-green animate-pulse' : 'bg-mc-accent-red'}`} />
              {isOnline ? 'ONLINE' : 'OFFLINE'}
            </div>

            <div className="flex-1 grid grid-cols-2 gap-2">
              <div className="relative group min-h-11 rounded-sm border border-mc-border bg-mc-bg-tertiary px-2 flex items-center justify-center gap-1.5 text-xs cursor-help">
                <span className="text-mc-accent-cyan font-semibold">{activeAgents}</span>
                <span className="text-mc-text-secondary">active</span>
                <div className="hidden group-hover:block absolute top-full mt-1 left-0 right-0 md:left-auto md:right-auto md:w-64 z-40 p-2 rounded-lg border border-mc-border bg-mc-bg shadow-lg">
                  <div className="text-[11px] uppercase tracking-wider text-mc-text-secondary mb-1.5">Agents active</div>
                  <ActiveAgentsTooltip activeAgents={workingAgentsList} activeSubAgents={activeSubAgents} />
                </div>
              </div>
              <div className="relative group min-h-11 rounded-sm border border-mc-border bg-mc-bg-tertiary px-2 flex items-center justify-center gap-1.5 text-xs cursor-help">
                <span className="text-mc-accent-purple font-semibold">{tasksInQueue}</span>
                <span className="text-mc-text-secondary">queued</span>
                <div className="hidden group-hover:block absolute top-full mt-1 left-0 right-0 md:left-auto md:right-auto md:w-64 z-40 p-2 rounded-lg border border-mc-border bg-mc-bg shadow-lg">
                  <div className="text-[11px] uppercase tracking-wider text-mc-text-secondary mb-1.5">Tasks in queue</div>
                  <QueuedTasksTooltip tasks={tasks} />
                </div>
              </div>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 md:gap-4 min-w-0">
            <div className="hidden sm:flex items-center gap-2">
              <Zap className="w-5 h-5 text-mc-accent-cyan" />
              <span className="font-semibold text-mc-text uppercase tracking-wider text-sm">Mission Control</span>
            </div>

            {workspace ? (
              <div className="flex items-center gap-2 min-w-0">
                <Link href="/" className="hidden sm:flex items-center gap-1 text-mc-text-secondary hover:text-mc-accent transition-colors">
                  <ChevronLeft className="w-4 h-4" />
                  <LayoutGrid className="w-4 h-4" />
                </Link>
                <span className="hidden sm:block text-mc-text-secondary">/</span>
                <div className="flex items-center gap-2 px-2 md:px-3 py-1 bg-mc-bg-tertiary rounded-sm min-w-0">
                  <span className="text-base md:text-lg">{workspace.icon}</span>
                  <span className="font-medium truncate text-sm md:text-base">{workspace.name}</span>
                </div>
              </div>
            ) : (
              <Link href="/" className="flex items-center gap-2 px-3 py-1 bg-mc-bg-tertiary rounded-sm hover:bg-mc-bg transition-colors">
                <LayoutGrid className="w-4 h-4" />
                <span className="text-sm">All Workspaces</span>
              </Link>
            )}
          </div>

          {workspace && (
            <div className="hidden lg:flex items-center gap-8">
              <div className="relative group text-center cursor-help">
                <div className="text-2xl font-bold text-mc-accent-cyan">{activeAgents}</div>
                <div className="text-xs text-mc-text-secondary uppercase">Agents Active</div>
                <div className="hidden group-hover:block absolute top-full mt-1 left-1/2 -translate-x-1/2 w-64 z-40 p-2 rounded-lg border border-mc-border bg-mc-bg shadow-lg text-left">
                  <div className="text-[11px] uppercase tracking-wider text-mc-text-secondary mb-1.5">Agents active</div>
                  <ActiveAgentsTooltip activeAgents={workingAgentsList} activeSubAgents={activeSubAgents} />
                </div>
              </div>
              <div className="relative group text-center cursor-help">
                <div className="text-2xl font-bold text-mc-accent-purple">{tasksInQueue}</div>
                <div className="text-xs text-mc-text-secondary uppercase">Tasks in Queue</div>
                <div className="hidden group-hover:block absolute top-full mt-1 left-1/2 -translate-x-1/2 w-64 z-40 p-2 rounded-lg border border-mc-border bg-mc-bg shadow-lg text-left">
                  <div className="text-[11px] uppercase tracking-wider text-mc-text-secondary mb-1.5">Tasks in queue</div>
                  <QueuedTasksTooltip tasks={tasks} />
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 md:gap-4">
            <span className="hidden md:block text-mc-text-secondary text-sm font-mono">{format(currentTime, 'HH:mm:ss')}</span>
            <div
              className={`flex items-center gap-2 px-2 md:px-3 py-1 rounded border text-xs md:text-sm font-medium ${
                isOnline
                  ? 'bg-mc-accent-green/20 border-mc-accent-green text-mc-accent-green'
                  : 'bg-mc-accent-red/20 border-mc-accent-red text-mc-accent-red'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-mc-accent-green animate-pulse' : 'bg-mc-accent-red'}`} />
              {isOnline ? 'ONLINE' : 'OFFLINE'}
            </div>
            <Link href="/roadmap" className="min-h-11 min-w-11 p-2 hover:bg-mc-bg-tertiary rounded-sm text-mc-text-secondary" title="Roadmap">
              <GanttChart className="w-5 h-5" />
            </Link>
            <Link href="/initiatives" className="min-h-11 min-w-11 p-2 hover:bg-mc-bg-tertiary rounded-sm text-mc-text-secondary" title="Initiatives">
              <ListTree className="w-5 h-5" />
            </Link>
            <Link href="/pm" className="min-h-11 min-w-11 p-2 hover:bg-mc-bg-tertiary rounded-sm text-mc-text-secondary" title="PM agent">
              <Bot className="w-5 h-5" />
            </Link>
            <Link href="/autopilot" className="min-h-11 min-w-11 p-2 hover:bg-mc-bg-tertiary rounded-sm text-mc-text-secondary" title="Autopilot">
              <Rocket className="w-5 h-5" />
            </Link>
            <button onClick={() => router.push('/settings')} className="min-h-11 min-w-11 p-2 hover:bg-mc-bg-tertiary rounded-sm text-mc-text-secondary" title="Settings">
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </>
      )}
    </header>
  );
}
