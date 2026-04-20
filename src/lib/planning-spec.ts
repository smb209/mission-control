import type { SpecDeliverable, SpecSuccessCriterion } from '@/lib/types';

/**
 * Normalized planning spec used by the dispatcher, evidence gate, and UI.
 * The planner's raw JSON blob (stored in tasks.planning_spec) may be in one
 * of two shapes, both of which this helper resolves to a single structure.
 */
export interface NormalizedPlanningSpec {
  title?: string;
  summary?: string;
  deliverables: SpecDeliverable[];
  success_criteria: SpecSuccessCriterion[];
  constraints?: Record<string, unknown>;
  /** True when at least one of the structured fields (deliverables with `id`
   *  and `acceptance`, or success_criteria with `assertion`) was present in
   *  the raw spec. False for legacy string[] specs — the evidence gate only
   *  reconciles when this is true. */
  isStructured: boolean;
}

function slugify(s: string, index: number): string {
  const base = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base ? base : `item-${index}`;
}

/**
 * Parse tasks.planning_spec (which may be a string or an already-parsed
 * object) and coerce both old and new shapes to NormalizedPlanningSpec.
 *
 * Old shape (pre-structured):
 *   { title, summary, deliverables: string[], success_criteria: string[], constraints }
 *
 * New shape:
 *   { title, summary,
 *     deliverables: [{id, title, kind, path_pattern?, acceptance}],
 *     success_criteria: [{id, assertion, how_to_test}],
 *     constraints }
 *
 * Mixed shapes (objects missing optional fields) are tolerated — missing
 * ids are derived from the title.
 */
export function parsePlanningSpec(raw: unknown): NormalizedPlanningSpec | null {
  if (!raw) return null;

  let obj: Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  } else {
    return null;
  }

  const deliverablesRaw = Array.isArray(obj.deliverables) ? obj.deliverables : [];
  const criteriaRaw = Array.isArray(obj.success_criteria) ? obj.success_criteria : [];

  let structuredSeen = false;

  const deliverables: SpecDeliverable[] = deliverablesRaw.map((entry, idx): SpecDeliverable => {
    if (typeof entry === 'string') {
      return {
        id: slugify(entry, idx),
        title: entry,
        kind: 'artifact',
        acceptance: entry,
      };
    }
    const rec = entry as Record<string, unknown>;
    const id = typeof rec.id === 'string' && rec.id.length > 0
      ? rec.id
      : slugify(typeof rec.title === 'string' ? rec.title : '', idx);
    const title = typeof rec.title === 'string' ? rec.title : id;
    const rawKind = typeof rec.kind === 'string' ? rec.kind : 'artifact';
    const kind = (rawKind === 'file' || rawKind === 'behavior' || rawKind === 'artifact')
      ? rawKind
      : 'artifact';
    const path_pattern = typeof rec.path_pattern === 'string' ? rec.path_pattern : undefined;
    const acceptance = typeof rec.acceptance === 'string' && rec.acceptance.length > 0
      ? rec.acceptance
      : title;
    if (typeof rec.id === 'string' && typeof rec.acceptance === 'string') {
      structuredSeen = true;
    }
    return { id, title, kind, path_pattern, acceptance };
  });

  const success_criteria: SpecSuccessCriterion[] = criteriaRaw.map((entry, idx): SpecSuccessCriterion => {
    if (typeof entry === 'string') {
      return {
        id: `sc-${idx + 1}`,
        assertion: entry,
        how_to_test: '(not specified)',
      };
    }
    const rec = entry as Record<string, unknown>;
    const id = typeof rec.id === 'string' && rec.id.length > 0 ? rec.id : `sc-${idx + 1}`;
    const assertion = typeof rec.assertion === 'string' ? rec.assertion : String(entry);
    const how_to_test = typeof rec.how_to_test === 'string' ? rec.how_to_test : '(not specified)';
    if (typeof rec.id === 'string' && typeof rec.assertion === 'string') {
      structuredSeen = true;
    }
    return { id, assertion, how_to_test };
  });

  return {
    title: typeof obj.title === 'string' ? obj.title : undefined,
    summary: typeof obj.summary === 'string' ? obj.summary : undefined,
    deliverables,
    success_criteria,
    constraints: typeof obj.constraints === 'object' && obj.constraints !== null
      ? (obj.constraints as Record<string, unknown>)
      : undefined,
    isStructured: structuredSeen,
  };
}
