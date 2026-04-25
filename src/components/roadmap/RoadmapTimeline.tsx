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
import { Plus, RefreshCw } from 'lucide-react';
import { RoadmapRail } from './RoadmapRail';
import { RoadmapCanvas } from './RoadmapCanvas';
import { RoadmapToolbar } from './RoadmapToolbar';
import {
  PX_PER_DAY,
  defaultWindow,
  toIsoDay,
  type ZoomLevel,
} from '@/lib/roadmap/date-math';

const WORKSPACE_ID = 'default';
const ZOOM_KEY = 'roadmap.zoom';
const RAIL_WIDTH = 300; // px
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

export function RoadmapTimeline() {
  const [snapshot, setSnapshot] = useState<RoadmapSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoomState] = useState<ZoomLevel>('month');
  const [filters, setFilters] = useState<RoadmapFilters>({
    product_id: null,
    owner_agent_id: null,
    kinds: new Set(ALL_KINDS),
    statuses: new Set(ALL_STATUSES),
  });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeMsg, setRecomputeMsg] = useState<string | null>(null);

  // Read zoom on mount only (client-only).
  useEffect(() => {
    setZoomState(readZoom());
  }, []);

  const setZoom = useCallback((z: ZoomLevel) => {
    setZoomState(z);
    writeZoom(z);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const params = new URLSearchParams();
      params.set('workspace_id', WORKSPACE_ID);
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
  }, [filters.product_id, filters.owner_agent_id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const recompute = useCallback(async () => {
    setRecomputing(true);
    setRecomputeMsg(null);
    try {
      const r = await fetch('/api/roadmap/recompute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: WORKSPACE_ID }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || `Recompute failed (${r.status})`);
      }
      const result = await r.json() as {
        initiatives_updated: number;
        status_flips: number;
        drifts: unknown[];
      };
      setRecomputeMsg(
        `Recomputed: ${result.initiatives_updated} updated, ${result.status_flips} flipped, ${result.drifts.length} drift${result.drifts.length === 1 ? '' : 's'}`,
      );
      await refresh();
    } catch (e) {
      setRecomputeMsg(e instanceof Error ? e.message : 'Recompute failed');
    } finally {
      setRecomputing(false);
    }
  }, [refresh]);

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

  const truncatedNote = snapshot?.truncated
    ? `Showing first ${snapshot.initiatives.length} of a larger workspace; refine filters for the full set.`
    : null;

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
          <Link
            href="/initiatives"
            className="px-3 py-1.5 rounded-lg border border-mc-border text-mc-text-secondary hover:text-mc-text text-sm"
          >
            Initiative tree
          </Link>
          <Link
            href="/"
            className="px-3 py-1.5 rounded-lg border border-mc-border text-mc-text-secondary hover:text-mc-text text-sm"
          >
            Workspaces
          </Link>
        </div>
      </header>
      {recomputeMsg && (
        <div className="mx-4 mt-2 p-2 rounded-lg bg-mc-accent/10 border border-mc-accent/30 text-mc-accent text-xs">
          {recomputeMsg}
        </div>
      )}

      <RoadmapToolbar
        filters={filters}
        setFilters={setFilters}
        zoom={zoom}
        setZoom={setZoom}
        snapshot={snapshot}
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
              width={RAIL_WIDTH}
              rowHeight={ROW_HEIGHT}
              collapsed={collapsed}
              onToggleCollapsed={toggleCollapsed}
              snapshot={snapshot}
              scrollRef={railScrollRef}
              onScroll={onRailScroll}
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
            />
          </>
        )}
      </main>
    </div>
  );
}
