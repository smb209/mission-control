'use client';

/**
 * Top-level roadmap shell (Phase 3).
 *
 * Owns:
 *   - Snapshot fetching from /api/roadmap.
 *   - Filter and zoom state (with localStorage persistence for zoom).
 *   - The drag-to-update-target-dates handler.
 *   - The optimistic mutation buffer (so dropped bars don't snap back
 *     before the server confirms).
 *
 * Layout: header → toolbar → split (rail | canvas).
 * The rail and canvas share a vertical scroll position so rows stay aligned.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Plus, RefreshCw, X, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { RoadmapRail } from './RoadmapRail';
import { RoadmapCanvas } from './RoadmapCanvas';
import { RoadmapToolbar } from './RoadmapToolbar';
import {
  PX_PER_DAY,
  defaultWindow,
  toIsoDay,
  dateToPx,
  type ZoomLevel,
} from '@/lib/roadmap/date-math';
import type { DriftEvent } from '@/lib/roadmap/drift';
import { useCurrentWorkspaceId } from '@/components/shell/workspace-context';

const ZOOM_KEY = 'roadmap.zoom';
const RAIL_WIDTH_KEY = 'roadmap.railWidth';
const RAIL_DEFAULT = 300;
const RAIL_MIN = 200;
const RAIL_MAX = 600;
const ROW_HEIGHT = 36;  // px — must match RoadmapRail row height

export type Kind = 'theme' | 'milestone' | 'epic' | 'story';
export type Status = 'planned' | 'in_progress' | 'at_risk' | 'blocked' | 'done' | 'cancelled';

export interface RoadmapInitiative {
  id: string;
  parent_initiative_id: string | null;
  product_id: string | null;
  kind: Kind;
  title: string;
  status: Status;
  owner_agent_id: string | null;
  owner_agent_name: string | null;
  complexity: 'S' | 'M' | 'L' | 'XL' | null;
  estimated_effort_hours: number | null;
  target_start: string | null;
  target_end: string | null;
  derived_start: string | null;
  derived_end: string | null;
  committed_end: string | null;
  status_check_md: string | null;
  sort_order: number;
  depth: number;
  task_counts: { draft: number; active: number; done: number; total: number };
}

export interface RoadmapDependency {
  id: string;
  initiative_id: string;
  depends_on_initiative_id: string;
  kind: string;
  note: string | null;
}

export interface RoadmapTask {
  id: string;
  initiative_id: string;
  title: string;
  status: string;
  assigned_agent_id: string | null;
}

export interface RoadmapSnapshot {
  initiatives: RoadmapInitiative[];
  dependencies: RoadmapDependency[];
  tasks: RoadmapTask[];
  workspace_id: string;
  product_id: string | null;
  truncated: boolean;
}

export interface RoadmapFilters {
  product_id: string | null;
  owner_agent_id: string | null;
  kinds: Set<Kind>;
  statuses: Set<Status>;
}

interface RecomputeResult {
  initiatives_updated: number;
  status_flips: number;
  drifts: DriftEvent[];
  cycle?: string[];
  warnings?: string[];
}

interface RecomputeBanner {
  result: RecomputeResult;
  expanded: boolean;
}

const ALL_KINDS: Kind[] = ['theme', 'milestone', 'epic', 'story'];
const ALL_STATUSES: Status[] = ['planned', 'in_progress', 'at_risk', 'blocked', 'done', 'cancelled'];

function readZoom(): ZoomLevel {
  if (typeof window === 'undefined') return 'month';
  const v = window.localStorage.getItem(ZOOM_KEY);
  if (v === 'week' || v === 'month' || v === 'quarter') return v;
  return 'month';
}

function writeZoom(z: ZoomLevel) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ZOOM_KEY, z);
  } catch {
    // localStorage can be disabled (private mode); ignore.
  }
}

function readRailWidth(): number {
  if (typeof window === 'undefined') return RAIL_DEFAULT;
  const raw = window.localStorage.getItem(RAIL_WIDTH_KEY);
  if (!raw) return RAIL_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return RAIL_DEFAULT;
  return Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(n)));
}

function writeRailWidth(w: number) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RAIL_WIDTH_KEY, String(w));
  } catch {
    // ignore.
  }
}

export function RoadmapTimeline() {
  const workspaceId = useCurrentWorkspaceId();
  const [snapshot, setSnapshot] = useState<RoadmapSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoomState] = useState<ZoomLevel>('month');
  const [railWidth, setRailWidthState] = useState<number>(RAIL_DEFAULT);
  const [filters, setFilters] = useState<RoadmapFilters>({
    product_id: null,
    owner_agent_id: null,
    kinds: new Set(ALL_KINDS),
    statuses: new Set(ALL_STATUSES),
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeBanner, setRecomputeBanner] = useState<RecomputeBanner | null>(null);
  const [recomputeError, setRecomputeError] = useState<string | null>(null);
  const [flashedId, setFlashedId] = useState<string | null>(null);

  // Read persisted prefs on mount.
  useEffect(() => {
    setZoomState(readZoom());
    setRailWidthState(readRailWidth());
  }, []);

  const setZoom = useCallback((z: ZoomLevel) => {
    setZoomState(z);
    writeZoom(z);
  }, []);

  const setRailWidth = useCallback((w: number) => {
    const clamped = Math.max(RAIL_MIN, Math.min(RAIL_MAX, Math.round(w)));
    setRailWidthState(clamped);
    writeRailWidth(clamped);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const params = new URLSearchParams();
      params.set('workspace_id', workspaceId);
      if (filters.product_id) params.set('product_id', filters.product_id);
      if (filters.owner_agent_id) params.set('owner_agent_id', filters.owner_agent_id);
      const r = await fetch(`/api/roadmap?${params.toString()}`);
      if (!r.ok) throw new Error(`Failed to load roadmap (${r.status})`);
      const snap: RoadmapSnapshot = await r.json();
      setSnapshot(snap);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load roadmap');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, filters.product_id, filters.owner_agent_id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const recompute = useCallback(async () => {
    setRecomputing(true);
    setRecomputeError(null);
    try {
      const r = await fetch('/api/roadmap/recompute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspaceId }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `Recompute failed (${r.status})`);
      }
      const result = (await r.json()) as RecomputeResult;
      setRecomputeBanner({ result, expanded: false });
      await refresh();
    } catch (e) {
      setRecomputeError(e instanceof Error ? e.message : 'Recompute failed');
      setRecomputeBanner(null);
    } finally {
      setRecomputing(false);
    }
  }, [workspaceId, refresh]);

  // Auto-dismiss the "no changes" variant after 3s. Sticky variant stays.
  useEffect(() => {
    if (!recomputeBanner) return;
    const { initiatives_updated, status_flips, drifts } = recomputeBanner.result;
    const noop = initiatives_updated === 0 && status_flips === 0 && drifts.length === 0;
    if (!noop) return;
    const t = setTimeout(() => setRecomputeBanner(null), 3000);
    return () => clearTimeout(t);
  }, [recomputeBanner]);

  // Apply client-side kind+status filters and collapse logic to the snapshot.
  const visibleInitiatives = useMemo(() => {
    if (!snapshot) return [] as RoadmapInitiative[];
    const byId = new Map(snapshot.initiatives.map(i => [i.id, i]));
    // Determine if any ancestor is collapsed.
    function ancestorCollapsed(i: RoadmapInitiative): boolean {
      let cur = i.parent_initiative_id ? byId.get(i.parent_initiative_id) : undefined;
      while (cur) {
        if (collapsed.has(cur.id)) return true;
        cur = cur.parent_initiative_id ? byId.get(cur.parent_initiative_id) : undefined;
      }
      return false;
    }
    return snapshot.initiatives.filter(i => {
      if (!filters.kinds.has(i.kind)) return false;
      if (!filters.statuses.has(i.status)) return false;
      if (ancestorCollapsed(i)) return false;
      return true;
    });
  }, [snapshot, filters.kinds, filters.statuses, collapsed]);

  const visibleIds = useMemo(
    () => new Set(visibleInitiatives.map(i => i.id)),
    [visibleInitiatives],
  );

  // Derive a sensible default render window from all dates in scope. We
  // include target_*, derived_*, and committed_end so milestones with only
  // a committed date still get a slot in the canvas.
  const window_ = useMemo(() => {
    const dates: Array<string | null | undefined> = [];
    for (const i of visibleInitiatives) {
      dates.push(i.target_start, i.target_end, i.derived_start, i.derived_end, i.committed_end);
    }
    return defaultWindow(dates, new Date());
  }, [visibleInitiatives]);

  const pxPerDay = PX_PER_DAY[zoom];

  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Optimistic patch buffer: while a drag is in flight we mutate the
  // local snapshot so the bar stays put. On success we keep it; on error
  // we refetch. Keyed by initiative id.
  const applyLocalDateChange = useCallback(
    (id: string, target_start: string | null, target_end: string | null) => {
      setSnapshot(s => {
        if (!s) return s;
        return {
          ...s,
          initiatives: s.initiatives.map(i =>
            i.id === id ? { ...i, target_start, target_end } : i,
          ),
        };
      });
    },
    [],
  );

  const updateInitiativeDates = useCallback(
    async (id: string, start: string | null, end: string | null) => {
      // Snapshot the previous values so we can revert.
      const prev = snapshot?.initiatives.find(i => i.id === id);
      if (!prev) return;
      applyLocalDateChange(id, start, end);
      try {
        const r = await fetch(`/api/initiatives/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target_start: start, target_end: end }),
        });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error || `PATCH failed (${r.status})`);
        }
      } catch (e) {
        console.error('Failed to update initiative dates:', e);
        // Revert on failure.
        applyLocalDateChange(id, prev.target_start, prev.target_end);
        setError(e instanceof Error ? e.message : 'Failed to update dates');
      }
    },
    [snapshot, applyLocalDateChange],
  );

  // Wired refs so the rail and canvas share a vertical scroll. We listen on
  // the scroll containers and mirror scrollTop both ways.
  const railScrollRef = useRef<HTMLDivElement>(null);
  const canvasScrollRef = useRef<HTMLDivElement>(null);
  const syncingScroll = useRef(false);
  const onRailScroll = () => {
    if (syncingScroll.current) return;
    syncingScroll.current = true;
    if (canvasScrollRef.current && railScrollRef.current) {
      canvasScrollRef.current.scrollTop = railScrollRef.current.scrollTop;
    }
    syncingScroll.current = false;
  };
  const onCanvasScroll = () => {
    if (syncingScroll.current) return;
    syncingScroll.current = true;
    if (railScrollRef.current && canvasScrollRef.current) {
      railScrollRef.current.scrollTop = canvasScrollRef.current.scrollTop;
    }
    syncingScroll.current = false;
  };

  // Read window_ + pxPerDay via a ref so scrollToToday is stable across
  // renders (window_ is a fresh object every render via useMemo, which
  // would otherwise invalidate the useCallback every frame).
  const scrollCtxRef = useRef({ windowStart: window_.start, pxPerDay });
  scrollCtxRef.current = { windowStart: window_.start, pxPerDay };

  // Position today's x ~⅓ from the left edge of the visible canvas.
  // Direct scrollLeft assignment (not scrollTo({behavior:'smooth'})) so
  // the call is idempotent across re-renders and never gets cancelled
  // by an animation frame.
  const scrollToToday = useCallback(() => {
    const el = canvasScrollRef.current;
    if (!el) return;
    const { windowStart, pxPerDay: ppd } = scrollCtxRef.current;
    const todayX = dateToPx(new Date(), windowStart, ppd);
    const target = Math.max(
      0,
      Math.min(el.scrollWidth - el.clientWidth, todayX - el.clientWidth / 3),
    );
    el.scrollLeft = target;
  }, []);

  // Auto-center only on initial snapshot arrival and explicit zoom changes —
  // not on every render. Use a key derived from snapshot identity + zoom.
  const lastAutoCenterKey = useRef<string | null>(null);
  useEffect(() => {
    if (!snapshot) return;
    const key = `${snapshot.workspace_id}:${snapshot.initiatives.length}:${zoom}`;
    if (lastAutoCenterKey.current === key) return;
    lastAutoCenterKey.current = key;
    // setTimeout, not requestAnimationFrame — RAF was unreliably starved
    // in the test harness when snapshot identity churned across renders.
    // The 50ms delay also gives the canvas time to measure scrollWidth
    // after a zoom-change layout.
    setTimeout(() => scrollToToday(), 50);
  }, [snapshot, zoom, scrollToToday]);

  const scrollByWeek = useCallback((direction: 1 | -1) => {
    const el = canvasScrollRef.current;
    if (!el) return;
    const { pxPerDay: ppd } = scrollCtxRef.current;
    const next = el.scrollLeft + direction * 7 * ppd;
    el.scrollLeft = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, next));
  }, []);

  // Scroll a row into vertical view + flash it briefly.
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollToInitiative = useCallback((id: string) => {
    const idx = visibleInitiatives.findIndex(i => i.id === id);
    if (idx < 0) return;
    const el = canvasScrollRef.current;
    if (!el) return;
    const targetTop = Math.max(
      0,
      idx * ROW_HEIGHT - el.clientHeight / 2 + ROW_HEIGHT / 2,
    );
    el.scrollTop = Math.min(el.scrollHeight - el.clientHeight, targetTop);
    setFlashedId(id);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashedId(null), 1500);
  }, [visibleInitiatives]);

  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  const truncatedNote = snapshot?.truncated
    ? `Showing first ${snapshot.initiatives.length} of a larger workspace; refine filters for the full set.`
    : null;

  const initiativesById = useMemo(
    () => new Map((snapshot?.initiatives ?? []).map(i => [i.id, i])),
    [snapshot],
  );

  return (
    <div className="min-h-screen bg-mc-bg flex flex-col">
      <header className="px-6 py-4 flex items-center justify-between border-b border-mc-border bg-mc-bg-secondary">
        <div>
          <h1 className="text-xl font-semibold text-mc-text">Roadmap</h1>
          <p className="text-xs text-mc-text-secondary">
            Timeline view · {visibleInitiatives.length} initiative{visibleInitiatives.length === 1 ? '' : 's'} ·
            today {toIsoDay(new Date())}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={recompute}
            disabled={recomputing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-mc-border text-mc-text-secondary hover:text-mc-text text-sm disabled:opacity-60"
            title="Run the derivation engine: refresh derived_start/end and at_risk flags"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${recomputing ? 'animate-spin' : ''}`} />
            {recomputing ? 'Recomputing…' : 'Recompute now'}
          </button>
        </div>
      </header>

      {recomputeError && (
        <div className="mx-4 mt-2 p-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-xs flex items-start justify-between gap-2">
          <span>{recomputeError}</span>
          <button
            onClick={() => setRecomputeError(null)}
            className="text-red-300/70 hover:text-red-300"
            aria-label="Dismiss error"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {recomputeBanner && (
        <RecomputeBannerView
          banner={recomputeBanner}
          onToggleExpanded={() =>
            setRecomputeBanner(b => (b ? { ...b, expanded: !b.expanded } : b))
          }
          onDismiss={() => setRecomputeBanner(null)}
          onJumpToInitiative={scrollToInitiative}
          initiativesById={initiativesById}
        />
      )}

      <RoadmapToolbar
        filters={filters}
        setFilters={setFilters}
        zoom={zoom}
        setZoom={setZoom}
        snapshot={snapshot}
        onScrollWeek={scrollByWeek}
        onScrollToToday={scrollToToday}
      />

      {error && (
        <div className="m-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
          {error}
        </div>
      )}
      {truncatedNote && (
        <div className="mx-4 mt-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs">
          {truncatedNote}
        </div>
      )}

      <main className="flex-1 flex min-h-0 overflow-hidden">
        {loading ? (
          <p className="m-6 text-mc-text-secondary">Loading roadmap…</p>
        ) : visibleInitiatives.length === 0 ? (
          <div className="m-auto text-center max-w-md">
            <p className="text-mc-text-secondary mb-3">
              No initiatives match the current filters.
            </p>
            <Link
              href="/initiatives"
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-mc-accent text-white hover:bg-mc-accent/90 text-sm"
            >
              <Plus className="w-4 h-4" /> Create initiative
            </Link>
          </div>
        ) : (
          <>
            <RoadmapRail
              initiatives={visibleInitiatives}
              width={railWidth}
              minWidth={RAIL_MIN}
              maxWidth={RAIL_MAX}
              onResize={setRailWidth}
              rowHeight={ROW_HEIGHT}
              collapsed={collapsed}
              onToggleCollapsed={toggleCollapsed}
              snapshot={snapshot}
              scrollRef={railScrollRef}
              onScroll={onRailScroll}
              flashedId={flashedId}
            />
            <RoadmapCanvas
              initiatives={visibleInitiatives}
              visibleIds={visibleIds}
              dependencies={snapshot?.dependencies ?? []}
              tasks={snapshot?.tasks ?? []}
              windowStart={window_.start}
              windowEnd={window_.end}
              pxPerDay={pxPerDay}
              zoom={zoom}
              rowHeight={ROW_HEIGHT}
              onUpdateDates={updateInitiativeDates}
              scrollRef={canvasScrollRef}
              onScroll={onCanvasScroll}
              onScrollWeek={scrollByWeek}
              onScrollToToday={scrollToToday}
            />
          </>
        )}
      </main>
    </div>
  );
}

function driftLabel(d: DriftEvent): { label: string; isDrift: boolean } {
  switch (d.kind) {
    case 'milestone_at_risk':
      return { label: `committed_end overrun by ${d.days_over}d`, isDrift: true };
    case 'slippage':
      return { label: `target_end slipped by ${d.days_over}d`, isDrift: false };
    case 'cycle_detected':
      return { label: `cycle (${d.initiative_ids.length} nodes)`, isDrift: false };
    case 'no_effort_signal':
      return { label: `no effort signal`, isDrift: false };
  }
}

function RecomputeBannerView({
  banner,
  onToggleExpanded,
  onDismiss,
  onJumpToInitiative,
  initiativesById,
}: {
  banner: RecomputeBanner;
  onToggleExpanded: () => void;
  onDismiss: () => void;
  onJumpToInitiative: (id: string) => void;
  initiativesById: Map<string, RoadmapInitiative>;
}) {
  const { initiatives_updated, status_flips, drifts } = banner.result;
  const noop = initiatives_updated === 0 && status_flips === 0 && drifts.length === 0;

  // Flatten drifts to a per-initiative row list. cycle_detected becomes one
  // synthetic row per node.
  const rows = useMemo(() => {
    const out: Array<{ id: string; title: string; label: string; isDrift: boolean }> = [];
    for (const d of drifts) {
      const { label, isDrift } = driftLabel(d);
      if (d.kind === 'cycle_detected') {
        for (const id of d.initiative_ids) {
          out.push({
            id,
            title: initiativesById.get(id)?.title ?? id,
            label,
            isDrift,
          });
        }
      } else {
        out.push({
          id: d.initiative_id,
          title: initiativesById.get(d.initiative_id)?.title ?? d.initiative_id,
          label,
          isDrift,
        });
      }
    }
    return out;
  }, [drifts, initiativesById]);

  const summary = noop
    ? 'No changes'
    : `${initiatives_updated} updated · ${status_flips} status flip${status_flips === 1 ? '' : 's'} · ${drifts.length} drift${drifts.length === 1 ? '' : 's'}`;

  return (
    <div
      className={`mx-4 mt-2 rounded-lg border text-xs ${
        noop
          ? 'bg-mc-bg-secondary border-mc-border text-mc-text-secondary'
          : 'bg-mc-accent/10 border-mc-accent/30 text-mc-accent'
      }`}
    >
      <div className="flex items-center gap-2 p-2">
        {!noop && rows.length > 0 ? (
          <button
            onClick={onToggleExpanded}
            className="text-mc-accent hover:text-mc-accent/80"
            aria-label={banner.expanded ? 'Collapse' : 'Expand'}
          >
            {banner.expanded ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
          </button>
        ) : (
          <span className="w-3.5 h-3.5" />
        )}
        <span className="flex-1">{summary}</span>
        <button
          onClick={onDismiss}
          className="text-mc-text-secondary hover:text-mc-text"
          aria-label="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {!noop && banner.expanded && rows.length > 0 && (
        <ul className="border-t border-mc-accent/20 max-h-48 overflow-y-auto">
          {rows.map((row, i) => (
            <li key={`${row.id}-${i}`}>
              <button
                onClick={() => onJumpToInitiative(row.id)}
                className="w-full text-left flex items-center gap-2 px-3 py-1.5 hover:bg-mc-accent/10 text-mc-text"
                title={`Jump to ${row.title}`}
              >
                {row.isDrift && (
                  <span
                    className="inline-flex items-center gap-1 px-1 py-0.5 rounded border border-red-500/40 bg-red-500/10 text-red-300 text-[10px]"
                    title="Schedule debt: derived_end > committed_end"
                  >
                    <AlertTriangle className="w-3 h-3" />
                    drift
                  </span>
                )}
                <span className="truncate flex-1">{row.title}</span>
                <span className="text-[10px] text-mc-text-secondary shrink-0">{row.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
