'use client';

/**
 * Left rail: indented initiative list with collapse/expand, kind icon,
 * title link, status pill, and task-count badge.
 *
 * Visual contract: each row is exactly `rowHeight` px tall so the canvas
 * can index by row with index*rowHeight without re-measuring.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, Square, Diamond, ListTree, Circle, AlertTriangle } from 'lucide-react';
import type { Kind, RoadmapInitiative, RoadmapSnapshot, Status } from './RoadmapTimeline';
import { daysBetween } from '@/lib/roadmap/date-math';

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
  minWidth,
  maxWidth,
  onResize,
  rowHeight,
  collapsed,
  onToggleCollapsed,
  snapshot,
  scrollRef,
  onScroll,
  flashedId,
}: {
  initiatives: RoadmapInitiative[];
  width: number;
  minWidth: number;
  maxWidth: number;
  onResize: (width: number) => void;
  rowHeight: number;
  collapsed: Set<string>;
  onToggleCollapsed: (id: string) => void;
  snapshot: RoadmapSnapshot | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  flashedId: string | null;
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

  const [dragging, setDragging] = useState(false);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragState.current = { startX: e.clientX, startWidth: width };
    setDragging(true);
  }, [width]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return;
    const dx = e.clientX - dragState.current.startX;
    const next = Math.max(minWidth, Math.min(maxWidth, dragState.current.startWidth + dx));
    onResize(next);
  }, [onResize, minWidth, maxWidth]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // capture may already be lost
    }
    dragState.current = null;
    setDragging(false);
  }, []);

  // Disable text selection while dragging — prevents the cursor flicker
  // when the pointer leaves the handle.
  useEffect(() => {
    if (!dragging) return;
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      document.body.style.userSelect = prev;
      document.body.style.cursor = '';
    };
  }, [dragging]);

  return (
    <aside
      className="border-r border-mc-border bg-mc-bg flex min-h-0 relative"
      style={{ width, minWidth: width }}
    >
      <div className="flex flex-col flex-1 min-w-0">
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
            const isFlashed = flashedId === i.id;
            return (
              <div
                key={i.id}
                className={`flex items-center gap-1.5 px-2 border-b border-mc-border/40 transition-colors ${
                  isFlashed ? 'bg-mc-accent/20' : ''
                }`}
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
                <Icon className={`w-3.5 h-3.5 shrink-0 ${KIND_COLOR[i.kind]}`} />
                <Link
                  href={`/initiatives/${i.id}`}
                  className="text-sm text-mc-text hover:text-mc-accent truncate flex-1 min-w-0"
                >
                  {i.title}
                </Link>
                {/* Drift indicator: milestone whose derived_end overruns
                    committed_end. Hover shows the gap in days. */}
                {i.kind === 'milestone' && i.committed_end && i.derived_end && i.derived_end > i.committed_end && (
                  <span
                    className="text-amber-400 shrink-0"
                    title={`Schedule debt: ${daysBetween(i.committed_end, i.derived_end)}d past committed_end (${i.committed_end} → ${i.derived_end})`}
                  >
                    <AlertTriangle className="w-3.5 h-3.5" />
                  </span>
                )}
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${STATUS_PILL[i.status]}`}
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
                    className="text-[10px] text-mc-text-secondary shrink-0"
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
      </div>

      {/* Resize handle on the right edge. Wider hit target than the visual
          line for easier grabbing; centered 4-px line shows on hover/drag. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize initiative column"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="absolute top-0 right-0 h-full w-2 cursor-col-resize group"
        style={{ touchAction: 'none' }}
      >
        <div
          className={`absolute right-0 top-0 h-full w-px transition-colors ${
            dragging ? 'bg-mc-accent w-0.5' : 'group-hover:bg-mc-accent/60'
          }`}
        />
      </div>
    </aside>
  );
}
