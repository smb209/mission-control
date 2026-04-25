'use client';

/**
 * Dependency arrows overlay — drawn behind the bars in its own SVG layer.
 *
 * Conventions:
 *   - An edge from A → B means "B depends on A". Render an arrow from
 *     A's right edge (its target_end) to B's left edge (its target_start).
 *   - We curve via a simple cubic Bézier with horizontal handles.
 *   - Edges where either endpoint is filtered out are skipped (or could
 *     be rendered dimmed pointing off-canvas — kept simple in v1).
 *   - Edges where either initiative has no target_start/target_end are
 *     skipped — there's nothing to anchor to.
 */

import {
  dateToPx,
  rangeWidthPx,
} from '@/lib/roadmap/date-math';
import type { RoadmapDependency, RoadmapInitiative } from './RoadmapTimeline';

export function RoadmapDependencies({
  dependencies,
  initiatives,
  visibleIds,
  windowStart,
  pxPerDay,
  rowHeight,
  width,
  height,
}: {
  dependencies: RoadmapDependency[];
  initiatives: RoadmapInitiative[];
  visibleIds: Set<string>;
  windowStart: Date;
  pxPerDay: number;
  rowHeight: number;
  width: number;
  height: number;
}) {
  // Position lookup: id → row index in the visible list.
  const idx = new Map<string, number>();
  initiatives.forEach((i, k) => idx.set(i.id, k));

  return (
    <svg
      width={width}
      height={height}
      style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
    >
      <defs>
        <marker
          id="roadmap-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,0 L8,4 L0,8 z" className="fill-mc-text-secondary" />
        </marker>
      </defs>
      {dependencies.map(dep => {
        // dep.depends_on_initiative_id (source) → dep.initiative_id (target)
        const src = initiatives.find(i => i.id === dep.depends_on_initiative_id);
        const tgt = initiatives.find(i => i.id === dep.initiative_id);
        if (!src || !tgt) return null;
        if (!visibleIds.has(src.id) || !visibleIds.has(tgt.id)) return null;
        if (!src.target_end || !tgt.target_start) return null;

        const srcRow = idx.get(src.id);
        const tgtRow = idx.get(tgt.id);
        if (srcRow == null || tgtRow == null) return null;

        const x1 = dateToPx(src.target_end, windowStart, pxPerDay)
          + rangeWidthPx(src.target_end, src.target_end, pxPerDay);
        const y1 = srcRow * rowHeight + rowHeight / 2;
        const x2 = dateToPx(tgt.target_start, windowStart, pxPerDay);
        const y2 = tgtRow * rowHeight + rowHeight / 2;

        // Cubic with horizontal control points proportional to the gap.
        const dx = Math.max(20, Math.abs(x2 - x1) / 2);
        const path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

        return (
          <path
            key={dep.id}
            d={path}
            stroke="currentColor"
            className="text-mc-text-secondary/60"
            strokeWidth={1.2}
            fill="none"
            markerEnd="url(#roadmap-arrow)"
          />
        );
      })}
    </svg>
  );
}
