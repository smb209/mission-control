# Roadmap timeline (Phase 3)

Lightweight Gantt-style timeline for the planning layer. SVG + CSS grid only — no external Gantt library. See `specs/roadmap-and-pm-spec.md` §12.2 and §14 for the full design.

## Component layout

```
RoadmapTimeline               ── shell, owns snapshot + filters + drag handler
├── RoadmapToolbar            ── filters (product/owner/kind/status) + zoom switch
├── RoadmapRail               ── left column: indented initiative tree
└── RoadmapCanvas             ── right column: SVG time canvas
    ├── RoadmapDependencies   ── overlay: arrows between bars
    └── RoadmapBar            ── per-row: solid + outlined bars, diamond, chips
```

Pure date math sits in `src/lib/roadmap/date-math.ts`. The aggregated read endpoint lives at `src/app/api/roadmap/route.ts`, with the helper in `src/lib/db/roadmap.ts`.

## What's covered by tests

| Surface | File | Status |
|---|---|---|
| Date math (px↔date round-trip, snap-to-day, range clipping, axis ticks, window overlap) | `src/lib/roadmap/date-math.test.ts` | 28 tests, all passing |
| Snapshot helper (depth, task_counts, deps, filters by kind/status/product/from-to, owner join, empty workspace) | `src/lib/db/roadmap.test.ts` | 10 tests, all passing |

## What's manual-test-only

The repo doesn't currently have a Vitest/RTL setup or a Playwright runner wired into the test script. Rather than introducing one for Phase 3 alone, the following surfaces are manual-test gates:

1. **Drag-to-update target dates.** Body-drag, left-edge resize, right-edge resize, with optimistic UI and revert-on-error. Verified manually against the dev server. Phase 4 should consider adding a Playwright smoke that loads `/roadmap` with a seeded fixture, drags a bar 7 days, and asserts on the resulting PATCH.
2. **Status colour rendering.** All six initiative statuses produce distinct bar fills/strokes. Pure mapping in `RoadmapBar.tsx :: STATUS_BAR`.
3. **Empty-state UI.** When zero initiatives match the filters, a "Create initiative" CTA links to `/initiatives`.
4. **Dependency arrows.** Edges between bars when both endpoints are visible and have target dates; skipped otherwise.
5. **Today line and axis ticks.** Visual.
6. **Zoom persistence.** Picking a zoom level writes to `localStorage["roadmap.zoom"]` and survives reload.

Verifying #2–#6 by eye on `http://localhost:4001/roadmap` is fine for v1.

## Phase 4 hand-off

Phase 4 fills `derived_*` columns. The bar component already renders the dashed outline when those values are present, so no UI changes are needed once the derivation engine ships — the slippage gap will appear on its own.
