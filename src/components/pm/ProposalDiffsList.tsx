/**
 * Structured renderer for the `proposed_changes` array on a PM
 * proposal card. Used by both the inline /pm chat card and the
 * standalone /pm/proposals/[id] detail page so the rendering stays
 * consistent across surfaces.
 *
 * The previous flat one-liner (`· create_child_initiative` × 8) hid
 * everything an operator actually needs to triage a decompose
 * proposal — title, complexity, dependency graph. This component
 * surfaces those for the create kinds (`create_child_initiative`,
 * `create_task_under_initiative`) and falls back to the existing
 * terse text summary for other diff kinds.
 *
 * Kept presentation-only: no fetching, no state. Caller passes the
 * `proposed_changes` array; we render. That keeps it equally usable
 * inside an SSR page, a chat card, or a future preview component.
 */

import * as React from 'react';

export interface PmDiff {
  kind: string;
  initiative_id?: string;
  agent_id?: string;
  status?: string;
  target_start?: string;
  target_end?: string;
  start?: string;
  end?: string;
  reason?: string;
  status_check_md?: string;
  depends_on_initiative_id?: string;
  dependency_id?: string;
  parent_id?: string | null;
  child_ids_in_order?: string[];
  note?: string;
  // create_child_initiative + create_task_under_initiative payload fields
  parent_initiative_id?: string;
  title?: string;
  description?: string;
  child_kind?: 'epic' | 'story' | 'milestone' | 'theme';
  complexity?: 'S' | 'M' | 'L' | 'XL';
  depends_on_initiative_ids?: string[];
  /** Optional explicit placeholder id used by create_child_initiative
   *  diffs as a dep target alternative to the ordinal `$N`. */
  placeholder_id?: string;
  // create_task_under_initiative-only
  assigned_agent_id?: string | null;
  priority?: 'low' | 'normal' | 'high';
}

export const COMPLEXITY_BADGE: Record<NonNullable<PmDiff['complexity']>, string> = {
  S: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  M: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  L: 'bg-amber-500/15 text-amber-200 border-amber-500/30',
  XL: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
};

function shortId(id: string | null | undefined): string {
  if (!id) return '∅';
  return id.slice(0, 8);
}

/**
 * Format an initiative-id reference. `$0`-style placeholders (used by
 * create_*_initiative diffs to reference siblings created in the same
 * proposal) render verbatim so the dependency graph reads as
 * "$2 ← $0, $1" at a glance. Real ids get short-hashed.
 */
function formatInitiativeRef(ref: string | null | undefined): string {
  if (!ref) return '∅';
  if (/^\$\d+$/.test(ref)) return ref;
  return shortId(ref);
}

/**
 * Optional resolver mapping initiative ids to their human title. When
 * provided, the diff summary uses titles in place of short-hash ids
 * — much friendlier in the recents/activity surfaces. Missing ids
 * fall back to the short-hash representation so the renderer never
 * crashes on a stale or partial map.
 */
export type InitiativeTitleResolver = (id: string | null | undefined) => string | undefined;

function labelFor(id: string | null | undefined, resolver?: InitiativeTitleResolver): string {
  if (!id) return '∅';
  const t = resolver?.(id);
  return t && t.trim() ? t : shortId(id);
}

export function summarizeDiff(c: PmDiff, resolver?: InitiativeTitleResolver): string {
  switch (c.kind) {
    case 'shift_initiative_target':
      return `shift ${labelFor(c.initiative_id, resolver)}: ${c.target_start ?? '∅'} → ${c.target_end ?? '∅'}`;
    case 'add_availability':
      return `availability ${shortId(c.agent_id)}: ${c.start} – ${c.end}`;
    case 'set_initiative_status':
      return `${labelFor(c.initiative_id, resolver)} → ${c.status}`;
    case 'add_dependency':
      return `dep ${labelFor(c.initiative_id, resolver)} blocks on ${labelFor(c.depends_on_initiative_id, resolver)}`;
    case 'remove_dependency':
      return `remove dep ${shortId(c.dependency_id)}`;
    case 'reorder_initiatives':
      return `reorder under ${labelFor(c.parent_id ?? null, resolver) || 'root'} (${c.child_ids_in_order?.length ?? 0})`;
    case 'update_status_check':
      return `status_check ${labelFor(c.initiative_id, resolver)}`;
    default:
      return c.kind ?? '?';
  }
}

/**
 * Derive an implicit target initiative when the proposal has no
 * explicit `target_initiative_id` set. Returns the unique initiative
 * id referenced across every diff that carries one, or null when
 * the diffs touch multiple initiatives (or none).
 *
 * Used by the activity-list / recents-list rendering to show
 * "Smart Snappy" instead of "(no target)" for chat-driven proposals
 * that mutated exactly one initiative.
 */
export function inferTargetInitiativeId(diffs: PmDiff[]): string | null {
  const ids = new Set<string>();
  for (const d of diffs) {
    if (typeof d.initiative_id === 'string' && d.initiative_id.length > 0) {
      ids.add(d.initiative_id);
    }
  }
  if (ids.size === 1) return [...ids][0];
  return null;
}

/**
 * Kind chip — colored uppercase badge that says, at a glance, what
 * kind of change this row represents. Replaces the previous mix of
 * leading-bullet / "status_check X" / arrow forms with one consistent
 * column the operator can scan vertically.
 */
const KIND_CHIP: Record<string, { label: string; cls: string } | undefined> = {
  create_epic: {
    label: 'NEW EPIC',
    cls: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-200',
  },
  create_story: {
    label: 'NEW STORY',
    cls: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-200',
  },
  create_initiative: {
    label: 'NEW',
    cls: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-200',
  },
  create_task_under_initiative: {
    label: 'NEW TASK',
    cls: 'border-violet-500/30 bg-violet-500/15 text-violet-200',
  },
  set_initiative_status: {
    label: 'STATUS',
    cls: 'border-sky-500/30 bg-sky-500/15 text-sky-200',
  },
  update_status_check: {
    label: 'STATUS CHECK',
    cls: 'border-indigo-500/30 bg-indigo-500/15 text-indigo-200',
  },
  shift_initiative_target: {
    label: 'TARGET',
    cls: 'border-amber-500/30 bg-amber-500/15 text-amber-200',
  },
  add_dependency: {
    label: 'DEP +',
    cls: 'border-cyan-500/30 bg-cyan-500/15 text-cyan-200',
  },
  remove_dependency: {
    label: 'DEP −',
    cls: 'border-rose-500/30 bg-rose-500/15 text-rose-200',
  },
  reorder_initiatives: {
    label: 'REORDER',
    cls: 'border-stone-500/30 bg-stone-500/15 text-stone-200',
  },
  add_availability: {
    label: 'AVAIL',
    cls: 'border-amber-500/30 bg-amber-500/15 text-amber-200',
  },
  set_task_status: {
    label: 'TASK',
    cls: 'border-violet-500/30 bg-violet-500/15 text-violet-200',
  },
};

function KindChip({ kind }: { kind: string }) {
  const def = KIND_CHIP[kind] ?? {
    label: kind.toUpperCase(),
    cls: 'border-mc-border bg-mc-bg-tertiary text-mc-text-secondary',
  };
  return (
    <span
      className={`shrink-0 px-1.5 py-0.5 rounded-sm border text-[10px] font-mono uppercase tracking-wide ${def.cls}`}
    >
      {def.label}
    </span>
  );
}

/** Tight one-line preview of `status_check_md` content. Strips
 *  markdown leaders the same way the audit-note preview does, then
 *  caps at 60 chars. */
function statusCheckPreview(md: string | undefined | null): string {
  if (!md) return '';
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const stripped = line
      .replace(/^#+\s+/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+\.\s+/, '')
      .replace(/^>\s+/, '')
      .trim();
    if (!stripped) continue;
    return stripped.length > 60 ? `${stripped.slice(0, 59)}…` : stripped;
  }
  return '';
}

interface DiffRowProps {
  diff: PmDiff;
  /** Position in `proposed_changes` (used to render `$N` placeholder). */
  index: number;
  /** When true, render the `$N` placeholder before the chip — only
   *  meaningful when another diff in the same proposal references it. */
  showPlaceholder?: boolean;
  resolveInitiativeTitle?: InitiativeTitleResolver;
}

/**
 * Single-row renderer.
 *
 * Layout (left-to-right):
 *   [optional $N] [KIND chip] [optional 2nd chip e.g. complexity]
 *   <entity-or-title>  [— change-detail]  [→ arrow target / deps]
 *
 * The kind chip is the operator's primary cue; the rest of the row
 * is "what entity is touched + what specifically changes".
 */
export function DiffRow({
  diff,
  index,
  showPlaceholder = false,
  resolveInitiativeTitle,
}: DiffRowProps) {
  const placeholderTag = showPlaceholder ? (
    <span
      className="font-mono text-mc-text-secondary/60 shrink-0 w-6 text-right"
      title="Placeholder slot — referenced by another diff in this proposal"
    >
      ${index}
    </span>
  ) : null;

  switch (diff.kind) {
    case 'create_child_initiative': {
      const parentLabel = labelFor(diff.parent_initiative_id, resolveInitiativeTitle);
      const childKind = diff.child_kind ?? 'initiative';
      const deps = diff.depends_on_initiative_ids ?? [];
      return (
        <div className="flex items-baseline gap-2 text-xs leading-relaxed">
          {placeholderTag}
          <KindChip kind={`create_${childKind}`} />
          {diff.complexity && (
            <span
              className={`shrink-0 px-1.5 py-0.5 rounded-sm border text-[10px] font-mono ${COMPLEXITY_BADGE[diff.complexity]}`}
              title={`complexity: ${diff.complexity}`}
            >
              {diff.complexity}
            </span>
          )}
          <span className="text-mc-text-secondary shrink-0">under</span>
          <span className="text-mc-text-secondary truncate max-w-[14ch]" title={parentLabel}>
            {parentLabel}
          </span>
          <span className="text-mc-text-secondary">—</span>
          <span className="text-mc-text">
            {diff.title || <em className="text-mc-text-secondary">(untitled)</em>}
          </span>
          {deps.length > 0 && (
            <span className="text-mc-text-secondary/70 font-mono shrink-0 ml-auto">
              ← {deps.map(formatInitiativeRef).join(', ')}
            </span>
          )}
        </div>
      );
    }
    case 'create_task_under_initiative': {
      const targetLabel = diff.initiative_id?.startsWith('$')
        ? diff.initiative_id
        : labelFor(diff.initiative_id, resolveInitiativeTitle);
      return (
        <div className="flex items-baseline gap-2 text-xs leading-relaxed">
          {placeholderTag}
          <KindChip kind={diff.kind} />
          <span className="text-mc-text-secondary shrink-0">under</span>
          <span className="text-mc-text-secondary truncate max-w-[14ch]" title={targetLabel}>
            {targetLabel}
          </span>
          <span className="text-mc-text-secondary">—</span>
          <span className="text-mc-text">
            {diff.title || <em className="text-mc-text-secondary">(untitled)</em>}
          </span>
        </div>
      );
    }
    case 'set_initiative_status': {
      return (
        <div className="flex items-baseline gap-2 text-xs leading-relaxed">
          <KindChip kind={diff.kind} />
          <span className="text-mc-text truncate" title={labelFor(diff.initiative_id, resolveInitiativeTitle)}>
            {labelFor(diff.initiative_id, resolveInitiativeTitle)}
          </span>
          <span className="text-mc-text-secondary">→</span>
          <span className="font-mono text-mc-text">{diff.status}</span>
        </div>
      );
    }
    case 'update_status_check': {
      const preview = statusCheckPreview(diff.status_check_md);
      return (
        <div className="flex items-baseline gap-2 text-xs leading-relaxed">
          <KindChip kind={diff.kind} />
          <span className="text-mc-text truncate" title={labelFor(diff.initiative_id, resolveInitiativeTitle)}>
            {labelFor(diff.initiative_id, resolveInitiativeTitle)}
          </span>
          {preview && (
            <>
              <span className="text-mc-text-secondary">—</span>
              <span className="text-mc-text-secondary/80 italic truncate" title={diff.status_check_md ?? undefined}>
                {preview}
              </span>
            </>
          )}
        </div>
      );
    }
    case 'shift_initiative_target': {
      return (
        <div className="flex items-baseline gap-2 text-xs leading-relaxed">
          <KindChip kind={diff.kind} />
          <span className="text-mc-text truncate" title={labelFor(diff.initiative_id, resolveInitiativeTitle)}>
            {labelFor(diff.initiative_id, resolveInitiativeTitle)}
          </span>
          <span className="text-mc-text-secondary">→</span>
          <span className="font-mono text-mc-text">
            {diff.target_start ?? '∅'} → {diff.target_end ?? '∅'}
          </span>
        </div>
      );
    }
    case 'add_dependency': {
      return (
        <div className="flex items-baseline gap-2 text-xs leading-relaxed">
          <KindChip kind={diff.kind} />
          <span className="text-mc-text truncate">
            {labelFor(diff.initiative_id, resolveInitiativeTitle)}
          </span>
          <span className="text-mc-text-secondary">blocks on</span>
          <span className="text-mc-text truncate">
            {labelFor(diff.depends_on_initiative_id, resolveInitiativeTitle)}
          </span>
        </div>
      );
    }
    case 'remove_dependency': {
      return (
        <div className="flex items-baseline gap-2 text-xs leading-relaxed">
          <KindChip kind={diff.kind} />
          <span className="font-mono text-mc-text">{shortId(diff.dependency_id)}</span>
        </div>
      );
    }
    case 'reorder_initiatives': {
      return (
        <div className="flex items-baseline gap-2 text-xs leading-relaxed">
          <KindChip kind={diff.kind} />
          <span className="text-mc-text-secondary">under</span>
          <span className="text-mc-text">
            {labelFor(diff.parent_id ?? null, resolveInitiativeTitle) || 'root'}
          </span>
          <span className="text-mc-text-secondary">
            ({diff.child_ids_in_order?.length ?? 0})
          </span>
        </div>
      );
    }
    case 'add_availability': {
      return (
        <div className="flex items-baseline gap-2 text-xs leading-relaxed">
          <KindChip kind={diff.kind} />
          <span className="font-mono text-mc-text">{shortId(diff.agent_id)}</span>
          <span className="text-mc-text-secondary">→</span>
          <span className="font-mono text-mc-text">
            {diff.start} – {diff.end}
          </span>
        </div>
      );
    }
    default:
      return (
        <div className="flex items-baseline gap-2 text-xs leading-relaxed">
          <KindChip kind={diff.kind ?? 'unknown'} />
          <span className="font-mono text-mc-text-secondary">
            {summarizeDiff(diff, resolveInitiativeTitle)}
          </span>
        </div>
      );
  }
}

/**
 * Pre-compute the set of placeholder ids (`$N`, custom placeholder_id)
 * referenced by other diffs in the same proposal. Only `create_*`
 * rows whose placeholder is actually used as a dep target or task
 * parent need to render `$N`; the rest are noise.
 */
function collectReferencedPlaceholders(diffs: PmDiff[]): Set<string> {
  const refs = new Set<string>();
  for (const d of diffs) {
    if (d.kind === 'create_task_under_initiative' && typeof d.initiative_id === 'string' && d.initiative_id.startsWith('$')) {
      refs.add(d.initiative_id);
    }
    if (d.kind === 'create_child_initiative') {
      for (const dep of d.depends_on_initiative_ids ?? []) {
        if (typeof dep === 'string' && dep.startsWith('$')) refs.add(dep);
      }
    }
  }
  return refs;
}

const DEFAULT_PREVIEW_CAP = 10;

interface ProposalDiffsListProps {
  diffs: PmDiff[];
  /** Show all diffs without the "and N more" fold. Used on the
   *  detail page where vertical real-estate is plentiful. */
  showAll?: boolean;
  /** Override the preview cap for the inline chat-card view. */
  previewCap?: number;
  /** Wrapping container className override. */
  className?: string;
  /** Optional id-to-title resolver. When provided, diff summaries
   *  use the human title (e.g. "Smart Snappy") in place of the short
   *  hash (e.g. "072d1c7d"). */
  resolveInitiativeTitle?: InitiativeTitleResolver;
  /**
   * Per-diff selection state. When provided, a checkbox is rendered
   * before each row and the parent owns the toggle. Default = no
   * checkboxes (the original always-render-everything behavior, used
   * by previews and read-only contexts).
   *
   * `disabledReason` (optional) renders the checkboxes greyed-out and
   * uses the string as a tooltip. Used when the proposal contains
   * cross-linked placeholder diffs (decompose flows) — partial accept
   * doesn't compose cleanly so we keep those all-or-nothing.
   */
  selection?: {
    selected: ReadonlySet<number>;
    onToggle: (idx: number) => void;
    disabledReason?: string;
  };
}

export function ProposalDiffsList({
  diffs,
  showAll = false,
  previewCap = DEFAULT_PREVIEW_CAP,
  className = 'px-3 pb-3 space-y-1',
  resolveInitiativeTitle,
  selection,
}: ProposalDiffsListProps) {
  if (diffs.length === 0) return null;
  const cap = showAll ? diffs.length : previewCap;
  const visible = diffs.slice(0, cap);
  const overflow = diffs.length - visible.length;
  // Only show `$N` next to diffs that another diff actually references.
  // Removes a column of noise on flat (non-decompose) proposals.
  const referenced = collectReferencedPlaceholders(diffs);
  return (
    <div className={className}>
      {visible.map((c, idx) => {
        const row = (
          <DiffRow
            diff={c}
            index={idx}
            showPlaceholder={
              (c.kind === 'create_child_initiative' ||
                c.kind === 'create_task_under_initiative') &&
              (referenced.has(`$${idx}`) ||
                (c.kind === 'create_child_initiative' &&
                  !!c.placeholder_id &&
                  referenced.has(c.placeholder_id)))
            }
            resolveInitiativeTitle={resolveInitiativeTitle}
          />
        );
        if (!selection) return <div key={idx}>{row}</div>;
        const checked = selection.selected.has(idx);
        const disabled = !!selection.disabledReason;
        return (
          <label
            key={idx}
            className={`flex items-start gap-2 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'} ${checked ? '' : 'opacity-50'}`}
            title={selection.disabledReason}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={() => selection.onToggle(idx)}
              className="mt-1 shrink-0 accent-mc-accent"
              aria-label={`Accept change ${idx + 1}`}
            />
            <span className="flex-1 min-w-0">{row}</span>
          </label>
        );
      })}
      {overflow > 0 && (
        <div className="font-mono text-xs text-mc-text-secondary">
          …and {overflow} more
        </div>
      )}
    </div>
  );
}
