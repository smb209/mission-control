/**
 * Shared trigger-kind → badge mapping for PM proposal cards.
 *
 * Both /pm (inline chat card) and /pm/proposals/[id] (standalone
 * detail page) render proposal cards with a colored pill identifying
 * the trigger_kind. They used to keep parallel copies of this map,
 * which drifted: the inline card's map was missing entries for
 * plan_initiative / decompose_initiative / notes_intake, so those
 * proposals rendered as blue "manual" until the bug was caught.
 *
 * Keep all consumers reading from this single source.
 */

export interface TriggerBadge {
  label: string;
  cls: string;
}

export const TRIGGER_BADGE: Record<string, TriggerBadge> = {
  manual: {
    label: 'manual',
    cls: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  },
  scheduled_drift_scan: {
    label: 'scheduled',
    cls: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  },
  disruption_event: {
    label: 'disruption',
    cls: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  },
  status_check_investigation: {
    label: 'status check',
    cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
  },
  plan_initiative: {
    label: 'plan',
    cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  },
  decompose_initiative: {
    label: 'decompose',
    cls: 'bg-pink-500/15 text-pink-300 border-pink-500/30',
  },
  notes_intake: {
    label: 'notes',
    cls: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30',
  },
};

/**
 * Look up a badge for a trigger_kind, falling back to the 'manual'
 * style (with the actual kind as the label so unknown kinds are
 * visible rather than masquerading as manual).
 */
export function triggerBadgeFor(kind: string): TriggerBadge {
  return TRIGGER_BADGE[kind] ?? { label: kind || 'unknown', cls: TRIGGER_BADGE.manual.cls };
}
