'use client';

/**
 * Top-of-page filters and zoom controls for the roadmap.
 *
 * Filters are kept dumb here — state lives in RoadmapTimeline; this just
 * renders inputs and toggles via setFilters. Product/owner pickers source
 * their options from the loaded snapshot so we don't make extra requests.
 */

import { useMemo } from 'react';
import { Layers, Filter } from 'lucide-react';
import type { ZoomLevel } from '@/lib/roadmap/date-math';
import type {
  Kind,
  RoadmapFilters,
  RoadmapSnapshot,
  Status,
} from './RoadmapTimeline';

const KIND_LABEL: Record<Kind, string> = {
  theme: 'Theme',
  milestone: 'Milestone',
  epic: 'Epic',
  story: 'Story',
};

const STATUS_LABEL: Record<Status, string> = {
  planned: 'Planned',
  in_progress: 'In progress',
  at_risk: 'At risk',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

export function RoadmapToolbar({
  filters,
  setFilters,
  zoom,
  setZoom,
  snapshot,
}: {
  filters: RoadmapFilters;
  setFilters: (next: RoadmapFilters) => void;
  zoom: ZoomLevel;
  setZoom: (z: ZoomLevel) => void;
  snapshot: RoadmapSnapshot | null;
}) {
  const productOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of snapshot?.initiatives ?? []) {
      if (i.product_id) set.add(i.product_id);
    }
    return Array.from(set).sort();
  }, [snapshot]);

  const ownerOptions = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const i of snapshot?.initiatives ?? []) {
      if (i.owner_agent_id) map.set(i.owner_agent_id, i.owner_agent_name);
    }
    return Array.from(map.entries()).sort((a, b) => (a[1] ?? '').localeCompare(b[1] ?? ''));
  }, [snapshot]);

  const toggleKind = (k: Kind) => {
    const next = new Set(filters.kinds);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setFilters({ ...filters, kinds: next });
  };

  const toggleStatus = (s: Status) => {
    const next = new Set(filters.statuses);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setFilters({ ...filters, statuses: next });
  };

  return (
    <div className="px-4 py-2 flex flex-wrap items-center gap-2 border-b border-mc-border bg-mc-bg-secondary">
      <div className="flex items-center gap-1 mr-2 text-xs text-mc-text-secondary">
        <Filter className="w-3.5 h-3.5" /> Filters
      </div>

      {/* Product */}
      <select
        value={filters.product_id ?? ''}
        onChange={e => setFilters({ ...filters, product_id: e.target.value || null })}
        className="px-2 py-1 rounded bg-mc-bg border border-mc-border text-xs"
      >
        <option value="">All products</option>
        {productOptions.map(p => (
          <option key={p} value={p}>
            {p.slice(0, 8)}…
          </option>
        ))}
      </select>

      {/* Owner */}
      <select
        value={filters.owner_agent_id ?? ''}
        onChange={e => setFilters({ ...filters, owner_agent_id: e.target.value || null })}
        className="px-2 py-1 rounded bg-mc-bg border border-mc-border text-xs"
      >
        <option value="">All owners</option>
        {ownerOptions.map(([id, name]) => (
          <option key={id} value={id}>
            {name ?? id.slice(0, 8)}
          </option>
        ))}
      </select>

      {/* Kinds — checkboxes */}
      <div className="flex items-center gap-1 ml-2">
        {(Object.keys(KIND_LABEL) as Kind[]).map(k => (
          <label
            key={k}
            className={`px-2 py-0.5 rounded border text-xs cursor-pointer ${
              filters.kinds.has(k)
                ? 'border-mc-accent/60 bg-mc-accent/10 text-mc-text'
                : 'border-mc-border text-mc-text-secondary'
            }`}
          >
            <input
              type="checkbox"
              className="hidden"
              checked={filters.kinds.has(k)}
              onChange={() => toggleKind(k)}
            />
            {KIND_LABEL[k]}
          </label>
        ))}
      </div>

      {/* Statuses */}
      <div className="flex items-center gap-1">
        {(Object.keys(STATUS_LABEL) as Status[]).map(s => (
          <label
            key={s}
            className={`px-2 py-0.5 rounded border text-xs cursor-pointer ${
              filters.statuses.has(s)
                ? 'border-mc-accent/60 bg-mc-accent/10 text-mc-text'
                : 'border-mc-border text-mc-text-secondary'
            }`}
          >
            <input
              type="checkbox"
              className="hidden"
              checked={filters.statuses.has(s)}
              onChange={() => toggleStatus(s)}
            />
            {STATUS_LABEL[s]}
          </label>
        ))}
      </div>

      {/* Zoom */}
      <div className="ml-auto flex items-center gap-1">
        <Layers className="w-3.5 h-3.5 text-mc-text-secondary" />
        {(['week', 'month', 'quarter'] as const).map(z => (
          <button
            key={z}
            onClick={() => setZoom(z)}
            className={`px-2 py-1 rounded text-xs border ${
              zoom === z
                ? 'border-mc-accent bg-mc-accent/20 text-mc-text'
                : 'border-mc-border text-mc-text-secondary hover:text-mc-text'
            }`}
            title={`Zoom: ${z}`}
          >
            {z[0].toUpperCase() + z.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}
