'use client';

/**
 * Thin top bar that sits above the main panel inside the unified shell.
 * Picks up the bits of the legacy Header that aren't navigation:
 *   - online/offline pill
 *   - active-agents count (tooltip)
 *   - tasks-in-queue count (tooltip)
 *   - settings cog (also in left nav, fine to duplicate as quick access)
 *
 * Mobile: a hamburger button toggles the left-nav drawer.
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Menu, Settings as SettingsIcon } from 'lucide-react';
import { useMissionControl } from '@/lib/store';
import type { Agent, Task, TaskStatus } from '@/lib/types';

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

interface AppTopBarProps {
  onToggleNav: () => void;
}

export function AppTopBar({ onToggleNav }: AppTopBarProps) {
  const { agents, tasks, isOnline } = useMissionControl();
  const [activeSubAgents, setActiveSubAgents] = useState(0);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/openclaw/sessions?session_type=subagent&status=active');
        if (res.ok) {
          const sessions = await res.json();
          setActiveSubAgents(Array.isArray(sessions) ? sessions.length : 0);
        }
      } catch { /* ignore — count just stays 0 */ }
    };
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, []);

  const workingAgents = agents.filter(a => a.status === 'working');
  const activeAgents = workingAgents.length;
  const queuedTasks = tasks.filter(
    t => t.status !== 'done' && t.status !== 'review' && t.status !== 'cancelled',
  );
  const tasksInQueue = queuedTasks.length;

  return (
    <header className="h-12 flex items-center gap-3 px-3 md:px-4 border-b border-mc-border bg-mc-bg-secondary shrink-0">
      <button
        type="button"
        aria-label="Open navigation"
        onClick={onToggleNav}
        className="md:hidden p-1.5 rounded hover:bg-mc-bg-tertiary text-mc-text-secondary"
      >
        <Menu className="w-5 h-5" />
      </button>

      <div className="flex-1" />

      <div
        className={`flex items-center gap-2 px-2 py-1 rounded border text-xs font-medium ${
          isOnline
            ? 'bg-mc-accent-green/20 border-mc-accent-green text-mc-accent-green'
            : 'bg-mc-accent-red/20 border-mc-accent-red text-mc-accent-red'
        }`}
        title={isOnline ? 'Mission Control online' : 'Mission Control offline'}
      >
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            isOnline ? 'bg-mc-accent-green animate-pulse' : 'bg-mc-accent-red'
          }`}
        />
        <span className="hidden sm:inline">{isOnline ? 'ONLINE' : 'OFFLINE'}</span>
      </div>

      <CountChip
        label="active"
        value={activeAgents}
        valueClass="text-mc-accent-cyan"
        title="Agents active"
      >
        <ActiveAgentsTooltip activeAgents={workingAgents} activeSubAgents={activeSubAgents} />
      </CountChip>

      <CountChip
        label="queued"
        value={tasksInQueue}
        valueClass="text-mc-accent-purple"
        title="Tasks in queue"
      >
        <QueuedTasksTooltip tasks={queuedTasks} />
      </CountChip>

      <Link
        href="/settings"
        className="p-1.5 rounded hover:bg-mc-bg-tertiary text-mc-text-secondary"
        title="Settings"
      >
        <SettingsIcon className="w-5 h-5" />
      </Link>
    </header>
  );
}

function CountChip({
  label,
  value,
  valueClass,
  title,
  children,
}: {
  label: string;
  value: number;
  valueClass: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="relative group hidden sm:flex items-center gap-1.5 px-2 h-8 rounded-sm border border-mc-border bg-mc-bg-tertiary text-xs cursor-help"
      tabIndex={0}
    >
      <span className={`font-semibold ${valueClass}`}>{value}</span>
      <span className="text-mc-text-secondary">{label}</span>
      <div className="hidden group-hover:block group-focus-within:block absolute top-full mt-1 right-0 w-64 z-40 p-2 rounded-lg border border-mc-border bg-mc-bg shadow-lg text-left">
        <div className="text-[11px] uppercase tracking-wider text-mc-text-secondary mb-1.5">
          {title}
        </div>
        {children}
      </div>
    </div>
  );
}

function ActiveAgentsTooltip({
  activeAgents,
  activeSubAgents,
}: {
  activeAgents: Agent[];
  activeSubAgents: number;
}) {
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
  if (tasks.length === 0) {
    return <span className="text-mc-text-secondary">No tasks in queue.</span>;
  }
  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
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
        <span className="font-mono">{tasks.length}</span>
      </div>
    </div>
  );
}
