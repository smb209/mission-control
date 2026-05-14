/**
 * ConvoyDiffPreview — shared renderer for `create_convoy_under_initiative`
 * diffs (PM convoy mandate slice 4).
 *
 * Used by the three decompose surfaces (DecomposeWithPmModal,
 * DecomposeStoryToTasksModal, PlanWithPmPanel) and the proposal detail
 * page so the operator-approves-the-DAG UX is consistent everywhere.
 *
 * V1 rendering per docs/proposals/pm-convoy-mandate.md "UX surface":
 *
 *   Parent acceptance criteria
 *     · <AC 1>
 *     · <AC 2>
 *
 *   Slices (N total, topological order)
 *     ┌─ <slice_id> · <role> · ~<duration>min · <N> deliverables
 *     │  <slice text>
 *     │  depends on: [—] or [a, b]
 *     │  Acceptance criteria: <N>
 *     └─
 *
 * Topological order is computed via Kahn's algorithm here (cheap — slice
 * count is bounded to 12 by the zod schema). We don't re-validate peer
 * resolution; that's a server-side concern. If the DAG has a cycle we
 * fall back to declaration order so the operator still sees the slices.
 *
 * Two display modes:
 *   - `compact` (default): one-line slice summary; full content folds
 *     behind a "More" toggle per row.
 *   - `expanded`: every slice fully expanded — used on the detail page
 *     where vertical real-estate is plentiful.
 *
 * Presentation-only. No fetching, no mutations.
 */

'use client';

import * as React from 'react';
import { ChevronDown, ChevronRight, Check } from 'lucide-react';

export interface ConvoyDeliverable {
  title: string;
  kind: 'file' | 'note' | 'report';
}

export interface ConvoySliceInput {
  id: string;
  role?: string;
  peer_agent_id?: string;
  peer_gateway_id?: string;
  slice: string;
  message: string;
  expected_deliverables: ConvoyDeliverable[];
  acceptance_criteria: string[];
  expected_duration_minutes: number;
  checkin_interval_minutes?: number;
  depends_on?: string[];
  required_evidence_gates?: string[];
}

export interface ConvoyDiff {
  kind: 'create_convoy_under_initiative';
  initiative_id: string;
  parent_acceptance_criteria: string[];
  slices: ConvoySliceInput[];
}

/**
 * Cheap Kahn's topo sort over the slice DAG. If a cycle is detected the
 * stuck slices get appended in declaration order so nothing disappears
 * from the rendered list. Server validation will reject the diff on
 * accept anyway.
 */
function topoOrderSlices(slices: ConvoySliceInput[]): ConvoySliceInput[] {
  const byId = new Map<string, ConvoySliceInput>();
  for (const s of slices) byId.set(s.id, s);
  const inDegree = new Map<string, number>();
  const outEdges = new Map<string, string[]>();
  for (const s of slices) {
    inDegree.set(s.id, (s.depends_on ?? []).filter((d) => byId.has(d)).length);
    for (const dep of s.depends_on ?? []) {
      if (!byId.has(dep)) continue;
      const arr = outEdges.get(dep) ?? [];
      arr.push(s.id);
      outEdges.set(dep, arr);
    }
  }
  const ready: string[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) ready.push(id);
  const ordered: ConvoySliceInput[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    const s = byId.get(id);
    if (s) ordered.push(s);
    for (const next of outEdges.get(id) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, d);
      if (d === 0) ready.push(next);
    }
  }
  if (ordered.length < slices.length) {
    // Cycle or orphans — append the rest in declaration order.
    const seen = new Set(ordered.map((s) => s.id));
    for (const s of slices) if (!seen.has(s.id)) ordered.push(s);
  }
  return ordered;
}

function peerLabel(s: ConvoySliceInput): string {
  if (s.role) return s.role;
  if (s.peer_agent_id) return s.peer_agent_id.slice(0, 8);
  if (s.peer_gateway_id) return s.peer_gateway_id;
  return '∅';
}

function SliceRow({
  slice,
  index,
  defaultExpanded,
}: {
  slice: ConvoySliceInput;
  index: number;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const deps = slice.depends_on ?? [];
  const evidenceGates = slice.required_evidence_gates ?? [];
  return (
    <li className="rounded border border-mc-border bg-mc-bg p-3 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-sm border border-mc-border bg-mc-bg-tertiary text-mc-text-secondary shrink-0">
          {index + 1}
        </span>
        <span className="font-mono text-xs text-mc-text shrink-0" title="Slice symbolic id">
          {slice.id}
        </span>
        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-sm border border-violet-500/30 bg-violet-500/15 text-violet-200 shrink-0">
          {peerLabel(slice)}
        </span>
        <span className="text-[11px] text-mc-text-secondary shrink-0">
          ~{slice.expected_duration_minutes}min
        </span>
        <span className="text-[11px] text-mc-text-secondary shrink-0">
          {slice.expected_deliverables.length} deliverable{slice.expected_deliverables.length === 1 ? '' : 's'}
        </span>
        <span className="text-[11px] text-mc-text-secondary shrink-0">
          {slice.acceptance_criteria.length} AC{slice.acceptance_criteria.length === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide slice details' : 'Show slice details'}
          className="ml-auto shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-mc-text-secondary hover:text-mc-text hover:bg-mc-bg-secondary"
        >
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          {expanded ? 'Less' : 'More'}
        </button>
      </div>
      <div className="text-sm text-mc-text">{slice.slice}</div>
      <div className="text-[11px] text-mc-text-secondary">
        depends on:{' '}
        {deps.length === 0 ? (
          <span className="italic">—</span>
        ) : (
          <span className="font-mono">{deps.join(', ')}</span>
        )}
      </div>
      {expanded && (
        <div className="mt-2 pt-2 border-t border-mc-border/40 space-y-2">
          {slice.message && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-mc-text-secondary/70 mb-1">
                Message
              </div>
              <p className="text-xs text-mc-text whitespace-pre-wrap leading-relaxed">
                {slice.message}
              </p>
            </div>
          )}
          {slice.expected_deliverables.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-mc-text-secondary/70 mb-1">
                Expected deliverables
              </div>
              <ul className="space-y-0.5">
                {slice.expected_deliverables.map((d, i) => (
                  <li key={i} className="text-xs text-mc-text">
                    <span className="font-mono text-[10px] text-mc-text-secondary mr-1.5">[{d.kind}]</span>
                    {d.title}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {slice.acceptance_criteria.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-mc-text-secondary/70 mb-1">
                Acceptance criteria
              </div>
              <ul className="space-y-0.5">
                {slice.acceptance_criteria.map((ac, i) => (
                  <li key={i} className="text-xs text-mc-text flex items-start gap-1.5">
                    <Check className="w-3 h-3 mt-0.5 shrink-0 text-emerald-400" />
                    <span>{ac}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {evidenceGates.length > 0 && (
            <div className="text-[11px] text-mc-text-secondary">
              <span className="text-[10px] uppercase tracking-wide text-mc-text-secondary/70 mr-2">
                Evidence gates
              </span>
              <span className="font-mono">{evidenceGates.join(', ')}</span>
            </div>
          )}
          {typeof slice.checkin_interval_minutes === 'number' && (
            <div className="text-[11px] text-mc-text-secondary">
              Check-in every {slice.checkin_interval_minutes} min
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export interface ConvoyDiffPreviewProps {
  diff: ConvoyDiff;
  /**
   * When true, every slice renders fully expanded (detail-page mode).
   * When false (default), slices are one-line summaries until the
   * operator clicks "More" per row (modal mode).
   */
  expanded?: boolean;
  className?: string;
}

export function ConvoyDiffPreview({ diff, expanded = false, className }: ConvoyDiffPreviewProps) {
  const ordered = React.useMemo(() => topoOrderSlices(diff.slices), [diff.slices]);
  return (
    <div className={className ?? 'space-y-4'}>
      <section>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-mc-text-secondary mb-2">
          Parent acceptance criteria ({diff.parent_acceptance_criteria.length})
        </h4>
        <ul className="space-y-1 rounded border border-mc-border bg-mc-bg p-3">
          {diff.parent_acceptance_criteria.map((ac, i) => (
            <li key={i} className="text-xs text-mc-text flex items-start gap-1.5">
              <Check className="w-3 h-3 mt-0.5 shrink-0 text-emerald-400" />
              <span>{ac}</span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-mc-text-secondary mb-2">
          Slices ({ordered.length} total, topological order)
        </h4>
        <ul className="space-y-2">
          {ordered.map((slice, i) => (
            <SliceRow
              key={slice.id}
              slice={slice}
              index={i}
              defaultExpanded={expanded}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * Narrowing helper — caller passes the proposal's `proposed_changes`
 * array (or any superset of diff shapes) and gets back the (possibly
 * empty) list of convoy diffs. Input is typed as `unknown[]` so
 * callers don't have to wrestle with a unified diff union — the
 * runtime checks below ensure each returned entry is a well-formed
 * ConvoyDiff.
 */
export function pickConvoyDiffs(diffs: ReadonlyArray<unknown>): ConvoyDiff[] {
  const out: ConvoyDiff[] = [];
  for (const d of diffs) {
    if (!d || typeof d !== 'object') continue;
    const rec = d as Record<string, unknown>;
    if (rec.kind !== 'create_convoy_under_initiative') continue;
    if (!Array.isArray(rec.slices)) continue;
    if (!Array.isArray(rec.parent_acceptance_criteria)) continue;
    out.push(d as unknown as ConvoyDiff);
  }
  return out;
}

export default ConvoyDiffPreview;
