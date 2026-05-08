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
 * kind of change this row represents. The `tooltip` field gives the
 * operator a one-line explainer on hover so non-obvious kinds (STATUS
 * CHECK, REORDER, DEP+/-) don't require chasing docs.
 */
const KIND_CHIP: Record<
  string,
  { label: string; cls: string; tooltip: string } | undefined
> = {
  create_epic: {
    label: 'NEW EPIC',
    cls: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-200',
    tooltip: 'Creates a brand-new epic-kind initiative under the named parent.',
  },
  create_story: {
    label: 'NEW STORY',
    cls: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-200',
    tooltip: 'Creates a brand-new story-kind initiative under the named parent.',
  },
  create_initiative: {
    label: 'NEW',
    cls: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-200',
    tooltip: 'Creates a brand-new initiative under the named parent.',
  },
  create_task_under_initiative: {
    label: 'NEW TASK',
    cls: 'border-violet-500/30 bg-violet-500/15 text-violet-200',
    tooltip:
      'Creates a brand-new task attached to the named initiative. Lands as a draft for the operator to dispatch.',
  },
  set_initiative_status: {
    label: 'STATUS',
    cls: 'border-sky-500/30 bg-sky-500/15 text-sky-200',
    tooltip:
      "Updates an existing initiative's status (e.g. planned → in_progress). PM-proposed updates can't flip to done/cancelled — those are operator-only.",
  },
  update_status_check: {
    label: 'STATUS CHECK',
    cls: 'border-indigo-500/30 bg-indigo-500/15 text-indigo-200',
    tooltip:
      "Rewrites an existing initiative's status_check_md (the freeform markdown shown on the initiative page summarizing status / linked PRs / waiting-on / demo plan). Hover the body for the proposed new content.",
  },
  shift_initiative_target: {
    label: 'TARGET',
    cls: 'border-amber-500/30 bg-amber-500/15 text-amber-200',
    tooltip:
      "Updates an existing initiative's target_start / target_end window. Used when the operator says \"slip the launch by a week\".",
  },
  add_dependency: {
    label: 'DEP +',
    cls: 'border-cyan-500/30 bg-cyan-500/15 text-cyan-200',
    tooltip:
      'Adds a dependency edge — A blocks on B. The schedule derivation engine respects these when computing derived dates.',
  },
  remove_dependency: {
    label: 'DEP −',
    cls: 'border-rose-500/30 bg-rose-500/15 text-rose-200',
    tooltip:
      'Removes an existing dependency edge by id. Inverse of DEP +.',
  },
  reorder_initiatives: {
    label: 'REORDER',
    cls: 'border-stone-500/30 bg-stone-500/15 text-stone-200',
    tooltip:
      'Re-orders sibling initiatives under a shared parent (sort_order column). Cosmetic — affects only display order, not scheduling.',
  },
  add_availability: {
    label: 'AVAIL',
    cls: 'border-amber-500/30 bg-amber-500/15 text-amber-200',
    tooltip:
      'Records that an agent is unavailable in a date window — vacation, PTO, on-call rotation. The schedule engine treats their velocity as 0 in that window.',
  },
  set_task_status: {
    label: 'TASK',
    cls: 'border-violet-500/30 bg-violet-500/15 text-violet-200',
    tooltip:
      "Updates an existing task's status. PM uses this only as the inverse of NEW TASK — task creation is the operator-driven path.",
  },
};

function KindChip({ kind }: { kind: string }) {
  const def = KIND_CHIP[kind] ?? {
    label: kind.toUpperCase(),
    cls: 'border-mc-border bg-mc-bg-tertiary text-mc-text-secondary',
    tooltip: `Diff kind: ${kind}`,
  };
  return (
    <span
      className={`shrink-0 px-1.5 py-0.5 rounded-sm border text-[10px] font-mono uppercase tracking-wide cursor-help ${def.cls}`}
      title={def.tooltip}
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
 * Sub-card shell. All DiffRow renderings use this so every diff has
 * the same border + spacing and the operator can scan the proposal
 * vertically. `header` carries the kind chip + secondary chips +
 * (right-aligned) target/arrow; `body` carries the full entity name
 * + change details with no truncation.
 */
function DiffCard({
  header,
  body,
  rightAccent,
}: {
  header: React.ReactNode;
  body?: React.ReactNode;
  rightAccent?: React.ReactNode;
}) {
  return (
    <div className="rounded-sm border border-mc-border/60 bg-mc-bg/40 px-2 py-1.5 text-xs leading-relaxed">
      <div className="flex items-center gap-1.5 flex-wrap">
        {header}
        {rightAccent && <div className="ml-auto shrink-0">{rightAccent}</div>}
      </div>
      {body && (
        <div className="mt-1 text-mc-text break-words whitespace-normal">
          {body}
        </div>
      )}
    </div>
  );
}

/**
 * Single-diff renderer. Each diff renders as its own bordered sub-card
 * so rows have visible separation, the entity name + change details
 * never truncate, and every kind chip carries a hover-explainer
 * (see KIND_CHIP). Layout per card:
 *
 *   ┌────────────────────────────────────────────────┐
 *   │ [$N] [KIND] [secondary chips]      [→ target]  │   ← header
 *   │ <entity name + change content>                 │   ← body, wraps freely
 *   └────────────────────────────────────────────────┘
 *
 * The kind chip is the operator's primary cue.
 */
export function DiffRow({
  diff,
  index,
  showPlaceholder = false,
  resolveInitiativeTitle,
}: DiffRowProps) {
  const placeholderTag = showPlaceholder ? (
    <span
      className="font-mono text-[10px] text-mc-text-secondary/70 shrink-0 px-1 py-0.5 rounded-sm border border-mc-border bg-mc-bg-tertiary"
      title="Placeholder slot — referenced by another diff in this proposal"
    >
      ${index}
    </span>
  ) : null;

  const titleOrFallback = (title: string | undefined) =>
    title ? (
      <span>{title}</span>
    ) : (
      <em className="text-mc-text-secondary">(untitled)</em>
    );

  switch (diff.kind) {
    case 'create_child_initiative': {
      const parentLabel = labelFor(diff.parent_initiative_id, resolveInitiativeTitle);
      const childKind = diff.child_kind ?? 'initiative';
      const deps = diff.depends_on_initiative_ids ?? [];
      return (
        <DiffCard
          header={
            <>
              {placeholderTag}
              <KindChip kind={`create_${childKind}`} />
              {diff.complexity && (
                <span
                  className={`shrink-0 px-1.5 py-0.5 rounded-sm border text-[10px] font-mono cursor-help ${COMPLEXITY_BADGE[diff.complexity]}`}
                  title={`Complexity: ${diff.complexity} (rough effort sizing)`}
                >
                  {diff.complexity}
                </span>
              )}
              <span className="text-mc-text-secondary">
                under <span className="text-mc-text">{parentLabel}</span>
              </span>
            </>
          }
          rightAccent={
            deps.length > 0 ? (
              <span
                className="text-mc-text-secondary/70 font-mono"
                title="Dependencies — this initiative blocks on these"
              >
                ← {deps.map(formatInitiativeRef).join(', ')}
              </span>
            ) : null
          }
          body={titleOrFallback(diff.title)}
        />
      );
    }
    case 'create_task_under_initiative': {
      const targetLabel = diff.initiative_id?.startsWith('$')
        ? diff.initiative_id
        : labelFor(diff.initiative_id, resolveInitiativeTitle);
      return (
        <DiffCard
          header={
            <>
              {placeholderTag}
              <KindChip kind={diff.kind} />
              <span className="text-mc-text-secondary">
                under <span className="text-mc-text">{targetLabel}</span>
              </span>
            </>
          }
          body={titleOrFallback(diff.title)}
        />
      );
    }
    case 'set_initiative_status': {
      return (
        <DiffCard
          header={<KindChip kind={diff.kind} />}
          rightAccent={
            <span
              className="font-mono text-mc-text"
              title="New status this proposal will set"
            >
              → {diff.status}
            </span>
          }
          body={
            <span className="text-mc-text">
              {labelFor(diff.initiative_id, resolveInitiativeTitle)}
            </span>
          }
        />
      );
    }
    case 'update_status_check': {
      const preview = statusCheckPreview(diff.status_check_md);
      return (
        <DiffCard
          header={<KindChip kind={diff.kind} />}
          body={
            <>
              <span className="text-mc-text">
                {labelFor(diff.initiative_id, resolveInitiativeTitle)}
              </span>
              {preview && (
                <p
                  className="mt-0.5 text-mc-text-secondary/80 italic"
                  title={diff.status_check_md ?? undefined}
                >
                  “{preview}”
                </p>
              )}
            </>
          }
        />
      );
    }
    case 'shift_initiative_target': {
      return (
        <DiffCard
          header={<KindChip kind={diff.kind} />}
          rightAccent={
            <span
              className="font-mono text-mc-text"
              title="Proposed new target window"
            >
              → {diff.target_start ?? '∅'} → {diff.target_end ?? '∅'}
            </span>
          }
          body={
            <span className="text-mc-text">
              {labelFor(diff.initiative_id, resolveInitiativeTitle)}
            </span>
          }
        />
      );
    }
    case 'add_dependency': {
      return (
        <DiffCard
          header={<KindChip kind={diff.kind} />}
          body={
            <span>
              <span className="text-mc-text">
                {labelFor(diff.initiative_id, resolveInitiativeTitle)}
              </span>{' '}
              <span className="text-mc-text-secondary">blocks on</span>{' '}
              <span className="text-mc-text">
                {labelFor(diff.depends_on_initiative_id, resolveInitiativeTitle)}
              </span>
            </span>
          }
        />
      );
    }
    case 'remove_dependency': {
      return (
        <DiffCard
          header={<KindChip kind={diff.kind} />}
          body={
            <span className="font-mono text-mc-text-secondary">
              dependency {shortId(diff.dependency_id)}
            </span>
          }
        />
      );
    }
    case 'reorder_initiatives': {
      return (
        <DiffCard
          header={<KindChip kind={diff.kind} />}
          rightAccent={
            <span
              className="font-mono text-mc-text-secondary"
              title="Number of siblings being re-ordered"
            >
              {diff.child_ids_in_order?.length ?? 0} children
            </span>
          }
          body={
            <span className="text-mc-text-secondary">
              under{' '}
              <span className="text-mc-text">
                {labelFor(diff.parent_id ?? null, resolveInitiativeTitle) || 'root'}
              </span>
            </span>
          }
        />
      );
    }
    case 'add_availability': {
      return (
        <DiffCard
          header={<KindChip kind={diff.kind} />}
          rightAccent={
            <span
              className="font-mono text-mc-text"
              title="Window during which the agent is unavailable"
            >
              {diff.start} – {diff.end}
            </span>
          }
          body={
            <span className="font-mono text-mc-text">
              agent {shortId(diff.agent_id)}
            </span>
          }
        />
      );
    }
    default:
      return (
        <DiffCard
          header={<KindChip kind={diff.kind ?? 'unknown'} />}
          body={
            <span className="font-mono text-mc-text-secondary">
              {summarizeDiff(diff, resolveInitiativeTitle)}
            </span>
          }
        />
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
  className = 'px-3 pb-3 space-y-1.5',
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
