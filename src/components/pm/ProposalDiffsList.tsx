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

export function summarizeDiff(c: PmDiff): string {
  switch (c.kind) {
    case 'shift_initiative_target':
      return `shift ${shortId(c.initiative_id)}: ${c.target_start ?? '∅'} → ${c.target_end ?? '∅'}`;
    case 'add_availability':
      return `availability ${shortId(c.agent_id)}: ${c.start} – ${c.end}`;
    case 'set_initiative_status':
      return `${shortId(c.initiative_id)} → ${c.status}`;
    case 'add_dependency':
      return `dep ${shortId(c.initiative_id)} blocks on ${shortId(c.depends_on_initiative_id)}`;
    case 'remove_dependency':
      return `remove dep ${shortId(c.dependency_id)}`;
    case 'reorder_initiatives':
      return `reorder under ${shortId(c.parent_id ?? null) || 'root'} (${c.child_ids_in_order?.length ?? 0})`;
    case 'update_status_check':
      return `status_check ${shortId(c.initiative_id)}`;
    default:
      return c.kind ?? '?';
  }
}

/**
 * Single-row renderer. `index` is the position in the proposal's
 * `proposed_changes` array — for create kinds it doubles as the `$N`
 * placeholder id agents use to reference this row from a sibling's
 * `depends_on_initiative_ids`.
 */
export function DiffRow({ diff, index }: { diff: PmDiff; index: number }) {
  if (diff.kind === 'create_child_initiative' || diff.kind === 'create_task_under_initiative') {
    const complexity = diff.complexity;
    const deps = diff.depends_on_initiative_ids ?? [];
    const isTask = diff.kind === 'create_task_under_initiative';
    return (
      <div className="flex items-baseline gap-2 text-xs leading-relaxed">
        <span className="font-mono text-mc-text-secondary/60 shrink-0 w-6 text-right">${index}</span>
        {complexity && (
          <span
            className={`shrink-0 px-1.5 py-0.5 rounded-sm border text-[10px] font-mono ${COMPLEXITY_BADGE[complexity]}`}
            title={`complexity: ${complexity}`}
          >
            {complexity}
          </span>
        )}
        {isTask && (
          <span className="shrink-0 px-1.5 py-0.5 rounded-sm border border-violet-500/30 bg-violet-500/15 text-violet-200 text-[10px] font-mono uppercase tracking-wide">
            task
          </span>
        )}
        <span className="text-mc-text">{diff.title || <em className="text-mc-text-secondary">(untitled)</em>}</span>
        {deps.length > 0 && (
          <span className="text-mc-text-secondary/70 font-mono shrink-0 ml-auto">
            ← {deps.map(formatInitiativeRef).join(', ')}
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="font-mono text-xs text-mc-text-secondary">
      · {summarizeDiff(diff)}
    </div>
  );
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
}

export function ProposalDiffsList({
  diffs,
  showAll = false,
  previewCap = DEFAULT_PREVIEW_CAP,
  className = 'px-3 pb-3 space-y-1',
}: ProposalDiffsListProps) {
  if (diffs.length === 0) return null;
  const cap = showAll ? diffs.length : previewCap;
  const visible = diffs.slice(0, cap);
  const overflow = diffs.length - visible.length;
  return (
    <div className={className}>
      {visible.map((c, idx) => (
        <DiffRow key={idx} diff={c} index={idx} />
      ))}
      {overflow > 0 && (
        <div className="font-mono text-xs text-mc-text-secondary">
          …and {overflow} more
        </div>
      )}
    </div>
  );
}
