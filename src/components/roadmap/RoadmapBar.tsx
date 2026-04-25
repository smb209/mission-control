'use client';

/**
 * One initiative row's bars: solid (target window), outlined (derived window),
 * milestone diamond, and (cosmetic) task chips.
 *
 * Drag-to-update is handled here. Three handles per solid bar:
 *   - body: drag to shift both target_start and target_end equally
 *   - left edge: drag to resize target_start
 *   - right edge: drag to resize target_end
 *
 * The component is positioned at the row's Y coordinate via a parent
 * `transform: translateY(...)`. We use absolute positioning + transform
 * (translate3d) for the bar X to keep drag re-renders cheap.
 */

import { useEffect, useRef, useState } from 'react';
import {
  addDays,
  dateToPx,
  rangeWidthPx,
  toIsoDay,
  toUtcDay,
  type ZoomLevel,
} from '@/lib/roadmap/date-math';
import type { Kind, RoadmapInitiative, RoadmapTask, Status } from './RoadmapTimeline';

const STATUS_BAR: Record<Status, { fill: string; stroke: string }> = {
  planned: { fill: 'fill-slate-500/40', stroke: 'stroke-slate-300' },
  in_progress: { fill: 'fill-blue-500/60', stroke: 'stroke-blue-300' },
  at_risk: { fill: 'fill-amber-500/60', stroke: 'stroke-amber-300' },
  blocked: { fill: 'fill-red-500/60', stroke: 'stroke-red-300' },
  done: { fill: 'fill-emerald-500/60', stroke: 'stroke-emerald-300' },
  cancelled: { fill: 'fill-slate-700/40', stroke: 'stroke-slate-500' },
};

// Tint by kind: subtle saturation difference so a milestone bar reads
// differently from an epic at a glance even at the same status.
const KIND_TINT: Record<Kind, number> = {
  theme: 0.7,
  milestone: 1.0,
  epic: 0.85,
  story: 0.7,
};

const BAR_HEIGHT = 18;
const DIAMOND_SIZE = 12;
const EDGE_HANDLE = 6;

type DragState =
  | { mode: 'shift'; startX: number; origStart: string; origEnd: string }
  | { mode: 'resize-start'; startX: number; origStart: string; end: string }
  | { mode: 'resize-end'; startX: number; start: string; origEnd: string }
  | null;

export function RoadmapBar({
  initiative,
  tasks,
  windowStart,
  pxPerDay,
  rowHeight,
  zoom,
  onUpdateDates,
}: {
  initiative: RoadmapInitiative;
  tasks: RoadmapTask[];
  windowStart: Date;
  pxPerDay: number;
  rowHeight: number;
  zoom: ZoomLevel;
  onUpdateDates: (id: string, start: string | null, end: string | null) => void;
}) {
  // Local override during drag — ISO day strings.
  const [override, setOverride] = useState<{ start: string; end: string } | null>(null);
  const dragState = useRef<DragState>(null);

  const start = override?.start ?? initiative.target_start;
  const end = override?.end ?? initiative.target_end;
  const tint = KIND_TINT[initiative.kind];

  // ── pointer drag plumbing ───────────────────────────────────────
  useEffect(() => {
    function onMove(e: PointerEvent) {
      const ds = dragState.current;
      if (!ds) return;
      const dx = e.clientX - ds.startX;
      const dDays = Math.round(dx / pxPerDay);
      if (ds.mode === 'shift') {
        const ns = toIsoDay(addDays(ds.origStart, dDays));
        const ne = toIsoDay(addDays(ds.origEnd, dDays));
        setOverride({ start: ns, end: ne });
      } else if (ds.mode === 'resize-start') {
        const ns = toIsoDay(addDays(ds.origStart, dDays));
        // Don't let start cross past end.
        if (toUtcDay(ns) <= toUtcDay(ds.end)) {
          setOverride({ start: ns, end: ds.end });
        }
      } else {
        const ne = toIsoDay(addDays(ds.origEnd, dDays));
        if (toUtcDay(ne) >= toUtcDay(ds.start)) {
          setOverride({ start: ds.start, end: ne });
        }
      }
    }
    function onUp() {
      const ds = dragState.current;
      if (!ds) return;
      dragState.current = null;
      // Commit if the override differs from the current value.
      if (override) {
        const orig = { start: initiative.target_start, end: initiative.target_end };
        if (override.start !== orig.start || override.end !== orig.end) {
          onUpdateDates(initiative.id, override.start, override.end);
        }
      }
      setOverride(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    }
    if (dragState.current) {
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      return () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
    }
  });

  function startDrag(mode: NonNullable<DragState>['mode'], e: React.PointerEvent) {
    if (!start || !end) return;
    e.preventDefault();
    e.stopPropagation();
    if (mode === 'shift') {
      dragState.current = { mode, startX: e.clientX, origStart: start, origEnd: end };
    } else if (mode === 'resize-start') {
      dragState.current = { mode, startX: e.clientX, origStart: start, end };
    } else {
      dragState.current = { mode, startX: e.clientX, start, origEnd: end };
    }
    // Force a re-render so the useEffect attaches its listeners.
    setOverride(o => o ?? { start: start!, end: end! });
  }

  // ── geometry ────────────────────────────────────────────────────
  const yMid = rowHeight / 2;

  // Solid (target) bar
  let solidEl: React.ReactNode = null;
  if (start && end) {
    const x = dateToPx(start, windowStart, pxPerDay);
    const w = rangeWidthPx(start, end, pxPerDay);
    const colors = STATUS_BAR[initiative.status];
    solidEl = (
      <g
        style={{
          opacity: tint,
          cursor: 'grab',
        }}
      >
        {/* Body: shift on drag */}
        <rect
          x={x}
          y={yMid - BAR_HEIGHT / 2}
          width={w}
          height={BAR_HEIGHT}
          rx={3}
          ry={3}
          className={`${colors.fill} ${colors.stroke}`}
          strokeWidth={1.5}
          onPointerDown={e => startDrag('shift', e)}
        />
        {/* Left edge handle */}
        <rect
          x={x}
          y={yMid - BAR_HEIGHT / 2}
          width={EDGE_HANDLE}
          height={BAR_HEIGHT}
          fill="transparent"
          style={{ cursor: 'ew-resize' }}
          onPointerDown={e => startDrag('resize-start', e)}
        />
        {/* Right edge handle */}
        <rect
          x={x + w - EDGE_HANDLE}
          y={yMid - BAR_HEIGHT / 2}
          width={EDGE_HANDLE}
          height={BAR_HEIGHT}
          fill="transparent"
          style={{ cursor: 'ew-resize' }}
          onPointerDown={e => startDrag('resize-end', e)}
        />
      </g>
    );
  }

  // Outlined (derived) bar — Phase 4 will populate; in Phase 3 mostly null.
  let outlineEl: React.ReactNode = null;
  if (initiative.derived_start && initiative.derived_end) {
    const x = dateToPx(initiative.derived_start, windowStart, pxPerDay);
    const w = rangeWidthPx(initiative.derived_start, initiative.derived_end, pxPerDay);
    outlineEl = (
      <rect
        x={x}
        y={yMid - BAR_HEIGHT / 2 - 2}
        width={w}
        height={BAR_HEIGHT + 4}
        rx={3}
        ry={3}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeDasharray="3 3"
        className="text-mc-text-secondary"
      />
    );
  }

  // Milestone diamond at committed_end (rendered for milestone kind).
  let diamondEl: React.ReactNode = null;
  if (initiative.kind === 'milestone' && initiative.committed_end) {
    const cx = dateToPx(initiative.committed_end, windowStart, pxPerDay);
    diamondEl = (
      <polygon
        points={`${cx},${yMid - DIAMOND_SIZE / 2} ${cx + DIAMOND_SIZE / 2},${yMid} ${cx},${yMid + DIAMOND_SIZE / 2} ${cx - DIAMOND_SIZE / 2},${yMid}`}
        className="fill-amber-400 stroke-amber-200"
        strokeWidth={1.5}
      />
    );
  }

  // Task chips: cosmetic only (don't carry per-day positions). Anchor to
  // the right end of the solid bar; if no bar, anchor to the left edge of
  // the row.
  const chipAnchor =
    start && end
      ? dateToPx(end, windowStart, pxPerDay) + rangeWidthPx(end, end, pxPerDay) / 2
      : 0;
  const chipsEl = tasks.length > 0 && (
    <g transform={`translate(${chipAnchor + 4}, ${yMid - 6})`}>
      {tasks.slice(0, 5).map((t, idx) => (
        <TaskChip key={t.id} task={t} x={idx * 14} />
      ))}
    </g>
  );

  // "no schedule" indicator if neither target nor committed dates: a small
  // ghosted pill at the left of the row.
  let noScheduleEl: React.ReactNode = null;
  if (!start && !end && !initiative.committed_end && !initiative.derived_start) {
    noScheduleEl = (
      <g transform={`translate(0, ${yMid})`}>
        <rect
          x={2}
          y={-7}
          width={70}
          height={14}
          rx={7}
          ry={7}
          className="fill-mc-bg stroke-mc-border"
          strokeDasharray="2 2"
        />
        <text x={36} y={3} textAnchor="middle" className="fill-mc-text-secondary" fontSize={10}>
          no schedule
        </text>
      </g>
    );
  }

  // `zoom` is in the signature for future tick alignment but currently unused.
  void zoom;

  return (
    <g>
      {outlineEl}
      {solidEl}
      {diamondEl}
      {chipsEl}
      {noScheduleEl}
    </g>
  );
}

function TaskChip({ task, x }: { task: RoadmapTask; x: number }) {
  const filled =
    task.status !== 'draft' && task.status !== 'done' && task.status !== 'cancelled';
  const done = task.status === 'done';
  return (
    <g transform={`translate(${x}, 0)`} style={{ pointerEvents: 'none' }}>
      <circle
        cx={5}
        cy={5}
        r={5}
        className={
          done
            ? 'fill-emerald-500/70 stroke-emerald-300'
            : filled
              ? 'fill-blue-500/70 stroke-blue-300'
              : 'fill-transparent stroke-slate-400'
        }
        strokeWidth={1}
        strokeDasharray={task.status === 'draft' ? '2 1' : undefined}
      >
        <title>{`${task.title} · ${task.status}`}</title>
      </circle>
      {done && (
        <path
          d="M 2.5 5 L 4.5 7 L 7.5 3.5"
          className="stroke-emerald-100"
          fill="none"
          strokeWidth={1.2}
          strokeLinecap="round"
        />
      )}
    </g>
  );
}
