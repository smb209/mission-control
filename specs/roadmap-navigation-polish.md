---
name: Roadmap navigation polish
description: Small, focused fixes to the roadmap timeline — header cleanup, resizable rail, recompute UX, week-view centering, horizontal scroll affordances
status: draft
---

# Roadmap navigation polish

Status: draft · Owner: smb209 · Date: 2026-05-09

The roadmap page (`/roadmap`) ships the timeline shell + derivation engine, but day-to-day navigation has rough edges. This spec captures five small, mostly independent fixes. None of them touch the data model or the recompute engine — just the UI shell in `src/components/roadmap/`.

## Problems

1. **Recompute has no clear next step.** Clicking "Recompute now" flashes a banner (`"Recomputed: N updated, K flipped, D drifts"`) and silently refreshes. The drifts and flips aren't actionable from the banner — you can't see *which* initiatives changed.
2. **Header has redundant nav.** "Initiative tree" and "Workspaces" links in the page header duplicate the left sidebar.
3. **Initiative column is fixed-width.** `RAIL_WIDTH = 300` is a hardcoded const; long titles truncate aggressively and the user can't widen the column to read them.
4. **Week view opens scrolled to the past.** The canvas always opens at `windowStart`. On Week zoom (32 px/day) today is thousands of pixels in, so the user lands on empty whitespace.
5. **No horizontal scroll affordance.** The calendar scrolls horizontally but there are no buttons, no keyboard shortcut, and no obvious scrollbar — discoverability is poor.

## Non-goals

- No changes to the derivation engine, drift detection, or `/api/roadmap/recompute` payload.
- No changes to the bar-drag-to-update-dates flow.
- No new filter dimensions; toolbar stays as-is.
- No mobile/touch redesign — desktop only.

## Changes

### 1. Recompute result UX

**File:** `src/components/roadmap/RoadmapTimeline.tsx`

- When the recompute response returns `initiatives_updated === 0 && status_flips === 0 && drifts.length === 0`, show a muted "No changes" banner that auto-dismisses after ~3s.
- When there *are* changes, the banner becomes expandable: a chevron toggles a list of the affected initiatives (id + title + which field changed: `target_*`, `derived_*`, `committed_end`, status). Clicking a row scrolls the rail/canvas to that initiative and flashes the row briefly.
- Drifts (where `committed_end < derived_end`) get a distinct red badge in the expanded list — they're the cases the user most wants to act on.
- Banner stays sticky until the user dismisses (X button) or runs another recompute.

The recompute API already returns `drifts: unknown[]`; tighten that type in the response handler so the UI can render id + delta. If the current API doesn't return enough detail, *do not extend the API in this PR* — just render what we have and file a follow-up.

### 2. Header cleanup

**File:** `src/components/roadmap/RoadmapTimeline.tsx`

- Remove the `<Link href="/initiatives">Initiative tree</Link>` and `<Link href="/">Workspaces</Link>` buttons from the header (lines ~326–337).
- Keep "Recompute now". Move it to the right edge.

### 3. Resizable initiative column

**Files:** `RoadmapTimeline.tsx`, `RoadmapRail.tsx`

- Promote `RAIL_WIDTH` from a const to state in `RoadmapTimeline`. Default 300, clamp 200–600.
- Persist to `localStorage` under `roadmap.railWidth`, mirroring the existing `roadmap.zoom` pattern.
- Add a 4-px-wide drag handle on the rail's right edge. On `mousedown`, capture pointer; on `mousemove`, set width = clamp(startWidth + dx, 200, 600); on `mouseup`, persist.
- Cursor: `col-resize` on hover; show a thin accent-colored line while dragging.
- Rail row content (title, kind icon, status dot) should reflow gracefully — increase the max title width as the column widens rather than just leaving extra whitespace.

### 4. Week view auto-centers on today

**File:** `RoadmapTimeline.tsx` (or `RoadmapCanvas.tsx`, wherever scroll lives)

- After the snapshot loads and on every zoom change, set `canvasScrollRef.current.scrollLeft` so that today's x-coordinate sits ~⅓ from the left edge of the visible canvas.
- Compute today's offset as `daysBetween(windowStart, today) * pxPerDay - viewportWidth / 3`, clamped to `[0, scrollWidth - clientWidth]`.
- This applies to all three zoom levels but is most visible on Week.

Optional follow-up (not in this spec): tighten `defaultWindow` for Week zoom so we don't render a year of empty canvas when only one initiative has a far-future `committed_end`.

### 5. Horizontal scroll affordances

**Files:** `RoadmapToolbar.tsx`, `RoadmapCanvas.tsx`

- Add three buttons to the toolbar (next to the zoom group): `◀ week`, `Today`, `▶ week`.
  - Left/right shift `scrollLeft` by `7 * pxPerDay` (one week regardless of zoom — feels consistent across zooms).
  - "Today" runs the same auto-center logic from change #4.
- Add a keyboard listener on the canvas: `←` / `→` shift by one week, `Home` jumps to today. Only active when the canvas (or its scroll container) has focus or hover.
- Shift+wheel → horizontal scroll (browsers don't always do this for inner scrollers).

## File-level checklist

| File | Changes |
|---|---|
| `src/components/roadmap/RoadmapTimeline.tsx` | Header cleanup; rail width state + persistence; recompute banner refactor; auto-center scroll |
| `src/components/roadmap/RoadmapRail.tsx` | Accept dynamic width; render drag handle; reflow row content |
| `src/components/roadmap/RoadmapCanvas.tsx` | Keyboard + wheel handlers for horizontal scroll; expose imperative `scrollToToday` |
| `src/components/roadmap/RoadmapToolbar.tsx` | ◀ / Today / ▶ buttons |

## Test plan

- **Manual via preview** (`preview_start`, navigate to `/roadmap`):
  - Header no longer shows "Initiative tree" / "Workspaces".
  - Drag the column edge — width changes smoothly, persists across reload, clamps at 200/600.
  - Click "Recompute now" with no real changes → "No changes" banner, auto-dismisses.
  - Click "Recompute now" after editing dates upstream → expandable banner lists changed initiatives; clicking a row scrolls it into view and flashes.
  - Switch to Week zoom → today is ~⅓ from the left, not stuck at the far past.
  - Click ◀ / ▶ → canvas scrolls one week per click; "Today" recenters; arrow keys do the same when canvas is focused; shift+wheel scrolls horizontally.
- **No new unit tests required** — these are pure UI changes against existing data. If `RoadmapCanvas` gains an imperative scroll method, a small smoke test covering "scrollToToday positions today within viewport" is nice-to-have but not required.

## Out of scope / follow-ups

- Tightening `defaultWindow` per-zoom (a separate, more invasive change).
- Surfacing drift detail (delta in days, owner, parent) — depends on whether the recompute API payload is rich enough.
- Mobile touch handles for column resize.
- Persisting horizontal scroll position across reloads.

## Rollout

Single PR is fine — all five changes are small and touch the same handful of files. Ship as `feat(roadmap): nav polish` against `main`.
