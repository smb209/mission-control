'use client';

/**
 * Right-hand timeline canvas. Owns the time axis, the today line, the
 * per-row bars, and the dependency overlay. Lays out absolutely so the
 * bar SVG and the dependency SVG can stack.
 *
 * The "canvas" is one big horizontally-scrolling div. Bar SVGs are sized
 * to the same total width so the time axis, bars, and arrows align.
 */

import { useMemo, type RefObject } from 'react';
import {
  axisTicks,
  daysBetween,
  dateToPx,
  formatTick,
  type ZoomLevel,
} from '@/lib/roadmap/date-math';
import { RoadmapBar } from './RoadmapBar';
import { RoadmapDependencies } from './RoadmapDependencies';
import type {
  RoadmapDependency,
  RoadmapInitiative,
  RoadmapTask,
} from './RoadmapTimeline';

export function RoadmapCanvas({
  initiatives,
  visibleIds,
  dependencies,
  tasks,
  windowStart,
  windowEnd,
  pxPerDay,
  zoom,
  rowHeight,
  onUpdateDates,
  scrollRef,
  onScroll,
}: {
  initiatives: RoadmapInitiative[];
  visibleIds: Set<string>;
  dependencies: RoadmapDependency[];
  tasks: RoadmapTask[];
  windowStart: Date;
  windowEnd: Date;
  pxPerDay: number;
  zoom: ZoomLevel;
  rowHeight: number;
  onUpdateDates: (id: string, start: string | null, end: string | null) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
}) {
  // Width = days in window * pxPerDay.
  const totalDays = daysBetween(windowStart, windowEnd) + 1;
  const totalWidth = Math.max(640, totalDays * pxPerDay);
  const totalHeight = initiatives.length * rowHeight;

  const ticks = useMemo(
    () => axisTicks(windowStart, windowEnd, zoom),
    [windowStart, windowEnd, zoom],
  );

  // Today line position. May be off-canvas; that's fine — the overflow:hidden
  // on the wrapper clips it cleanly.
  const todayX = dateToPx(new Date(), windowStart, pxPerDay);

  const tasksByInit = useMemo(() => {
    const m = new Map<string, RoadmapTask[]>();
    for (const t of tasks) {
      const list = m.get(t.initiative_id) ?? [];
      list.push(t);
      m.set(t.initiative_id, list);
    }
    return m;
  }, [tasks]);

  return (
    <section className="flex-1 flex flex-col min-h-0 min-w-0">
      {/* Axis row — sticky at top, scrolls with the body horizontally. */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 overflow-auto bg-mc-bg"
      >
        <div style={{ width: totalWidth, position: 'relative' }}>
          {/* Axis */}
          <div
            className="sticky top-0 z-10 h-12 border-b border-mc-border bg-mc-bg-secondary"
            style={{ width: totalWidth }}
          >
            <svg width={totalWidth} height={48} style={{ display: 'block' }}>
              {ticks.map((t, i) => {
                const x = dateToPx(t, windowStart, pxPerDay);
                // Ticks placed at-or-before windowStart keep the leftmost
                // edge labelled even on short ranges (e.g. a Quarter-zoom
                // view that spans <90 days). Clamp the visible label to
                // x=4 so it doesn't render in negative space.
                const labelX = Math.max(x + 4, 4);
                const lineVisible = x >= 0;
                return (
                  <g key={i}>
                    {lineVisible && (
                      <line
                        x1={x}
                        x2={x}
                        y1={0}
                        y2={48}
                        stroke="currentColor"
                        className="text-mc-border"
                      />
                    )}
                    <text
                      x={labelX}
                      y={30}
                      className="fill-mc-text-secondary"
                      fontSize={11}
                    >
                      {formatTick(t, zoom)}
                    </text>
                  </g>
                );
              })}
              {/* Today line label */}
              {todayX >= 0 && todayX <= totalWidth && (
                <g>
                  <line
                    x1={todayX}
                    x2={todayX}
                    y1={0}
                    y2={48}
                    stroke="currentColor"
                    className="text-mc-accent"
                    strokeWidth={1.5}
                  />
                  <text
                    x={todayX + 4}
                    y={14}
                    className="fill-mc-accent"
                    fontSize={10}
                    fontWeight={600}
                  >
                    today
                  </text>
                </g>
              )}
            </svg>
          </div>

          {/* Body: row gridlines + dependency arrows + bars */}
          <div
            style={{ position: 'relative', width: totalWidth, height: totalHeight }}
          >
            {/* Row backgrounds + horizontal separators */}
            <svg
              width={totalWidth}
              height={totalHeight}
              style={{ position: 'absolute', top: 0, left: 0 }}
            >
              {initiatives.map((_, i) => (
                <line
                  key={i}
                  x1={0}
                  x2={totalWidth}
                  y1={(i + 1) * rowHeight}
                  y2={(i + 1) * rowHeight}
                  stroke="currentColor"
                  className="text-mc-border/40"
                />
              ))}
              {/* Tick gridlines */}
              {ticks.map((t, i) => {
                const x = dateToPx(t, windowStart, pxPerDay);
                return (
                  <line
                    key={`tg-${i}`}
                    x1={x}
                    x2={x}
                    y1={0}
                    y2={totalHeight}
                    stroke="currentColor"
                    className="text-mc-border/30"
                  />
                );
              })}
              {/* Today line through the body */}
              {todayX >= 0 && todayX <= totalWidth && (
                <line
                  x1={todayX}
                  x2={todayX}
                  y1={0}
                  y2={totalHeight}
                  stroke="currentColor"
                  className="text-mc-accent/50"
                  strokeWidth={1}
                />
              )}
            </svg>

            {/* Dependency arrows */}
            <RoadmapDependencies
              dependencies={dependencies}
              initiatives={initiatives}
              visibleIds={visibleIds}
              windowStart={windowStart}
              pxPerDay={pxPerDay}
              rowHeight={rowHeight}
              width={totalWidth}
              height={totalHeight}
            />

            {/* Bar layer: one SVG per row keeps the drag handler local. */}
            {initiatives.map((init, i) => (
              <svg
                key={init.id}
                width={totalWidth}
                height={rowHeight}
                style={{
                  position: 'absolute',
                  top: i * rowHeight,
                  left: 0,
                  display: 'block',
                  // pointerEvents 'none' would break drag — we want this
                  // layer to receive events but the dependency layer above
                  // is already pointerEvents:none.
                }}
              >
                <RoadmapBar
                  initiative={init}
                  tasks={tasksByInit.get(init.id) ?? []}
                  windowStart={windowStart}
                  pxPerDay={pxPerDay}
                  rowHeight={rowHeight}
                  zoom={zoom}
                  onUpdateDates={onUpdateDates}
                />
              </svg>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
