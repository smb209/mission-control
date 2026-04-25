'use client';

/**
 * Left rail: indented initiative list with collapse/expand, kind icon,
 * title link, status pill, and task-count badge.
 *
 * Visual contract: each row is exactly `rowHeight` px tall so the canvas
 * can index by row with index*rowHeight without re-measuring.
 */

import type { RefObject } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, Square, Diamond, ListTree, Circle } from 'lucide-react';
import type { Kind, RoadmapInitiative, RoadmapSnapshot, Status } from './RoadmapTimeline';

const KIND_ICON: Record<Kind, React.ComponentType<{ className?: string }>> = {
  theme: Square,
  milestone: Diamond,
  epic: ListTree,
  story: Circle,
};

const KIND_COLOR: Record<Kind, string> = {
  theme: 'text-purple-300',
  milestone: 'text-amber-300',
  epic: 'text-blue-300',
  story: 'text-emerald-300',
};

export const STATUS_PILL: Record<Status, string> = {
  planned: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
  in_progress: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
  at_risk: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  blocked: 'bg-red-500/20 text-red-300 border-red-500/40',
  done: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  cancelled: 'bg-mc-bg text-mc-text-secondary border-mc-border',
};

export function RoadmapRail({
  initiatives,
  width,
  rowHeight,
  collapsed,
  onToggleCollapsed,
  snapshot,
  scrollRef,
  onScroll,
}: {
  initiatives: RoadmapInitiative[];
  width: number;
  rowHeight: number;
  collapsed: Set<string>;
  onToggleCollapsed: (id: string) => void;
  snapshot: RoadmapSnapshot | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
}) {
  // Map id → has-children. Use the *full* snapshot (not the filtered set) so
  // a parent that's been hidden by filter/collapse but has children doesn't
  // lose its caret if it's still visible.
  const hasChildren = new Map<string, boolean>();
  for (const i of snapshot?.initiatives ?? []) {
    if (i.parent_initiative_id) {
      hasChildren.set(i.parent_initiative_id, true);
    }
  }

  return (
    <aside
      className="border-r border-mc-border bg-mc-bg flex flex-col min-h-0"
      style={{ width, minWidth: width }}
    >
      {/* Spacer matching the timeline axis row */}
      <div className="h-12 border-b border-mc-border bg-mc-bg-secondary flex items-center px-3 text-[11px] uppercase tracking-wide text-mc-text-secondary">
        Initiative
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="overflow-y-auto overflow-x-hidden flex-1"
      >
        {initiatives.map(i => {
          const Icon = KIND_ICON[i.kind];
          const expanded = !collapsed.has(i.id);
          const showCaret = !!hasChildren.get(i.id);
          const counts = i.task_counts;
          return (
            <div
              key={i.id}
              className="flex items-center gap-1.5 px-2 border-b border-mc-border/40"
              style={{ height: rowHeight, paddingLeft: 8 + i.depth * 14 }}
              title={i.title}
            >
              {showCaret ? (
                <button
                  onClick={() => onToggleCollapsed(i.id)}
                  className="p-0.5 rounded hover:bg-mc-bg-secondary text-mc-text-secondary"
                  title={expanded ? 'Collapse' : 'Expand'}
                >
                  {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                </button>
              ) : (
                <span className="w-4" />
              )}
              <Icon className={`w-3.5 h-3.5 ${KIND_COLOR[i.kind]}`} />
              <Link
                href={`/initiatives/${i.id}`}
                className="text-sm text-mc-text hover:text-mc-accent truncate flex-1 min-w-0"
              >
                {i.title}
              </Link>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_PILL[i.status]}`}
                title={i.status}
              >
                {i.status === 'in_progress'
                  ? 'wip'
                  : i.status === 'at_risk'
                    ? 'risk'
                    : i.status.slice(0, 4)}
              </span>
              {counts.total > 0 && (
                <span
                  className="text-[10px] text-mc-text-secondary"
                  title={`${counts.total} tasks: ${counts.draft} draft, ${counts.active} active, ${counts.done} done`}
                >
                  {counts.total}
                  {counts.draft > 0 && <span className="text-slate-400">·{counts.draft}d</span>}
                  {counts.active > 0 && <span className="text-blue-400">·{counts.active}a</span>}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
