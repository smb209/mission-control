/**
 * Apply the embedded `<!--pm-plan-suggestions ...-->` JSON inside a
 * plan_initiative proposal's impact_md to a chosen target initiative.
 *
 * Why this exists: plan_initiative proposals are dispatched as advisory
 * (proposed_changes = []) because at dispatch time the system doesn't
 * know which initiative — if any — the operator wants the suggestions
 * applied to. The structured suggestions live in an HTML comment in the
 * impact_md. When the operator picks a target (either via the chat
 * Accept picker or via the inline detail-page panel), this helper does
 * the actual write — atomically, per-initiative.
 */
import { v4 as uuidv4 } from 'uuid';
import { getDb, queryOne, run } from '@/lib/db';

// Re-export from the client-safe module so server callers can keep
// importing parser/stripper from this file without changing.
export {
  parseSuggestionsFromImpactMd,
  stripSuggestionsSidecar,
  type PlanInitiativeSuggestionsBlob,
} from './planSuggestionsSidecar';
import type { PlanInitiativeSuggestionsBlob } from './planSuggestionsSidecar';

export interface ApplyPlanResult {
  fields_updated: number;
  dependencies_created: number;
  dependencies_skipped: number; // duplicates / self-edges
  initiative_title: string;
}

/**
 * Apply a plan_initiative suggestions blob to a real initiative in a
 * single transaction:
 *   - UPDATE the initiative with any provided field suggestions
 *   - INSERT each suggested dependency (skipping self-edges and dupes)
 *
 * Throws if the initiative isn't found. Per-dependency errors that
 * aren't fatal (FK violations, duplicate edges) are silently counted as
 * `dependencies_skipped` rather than aborting the whole apply, so the
 * field updates still land.
 */
export function applyPlanInitiativeSuggestions(
  initiativeId: string,
  suggestions: PlanInitiativeSuggestionsBlob,
): ApplyPlanResult {
  const initiative = queryOne<{ id: string; title: string }>(
    'SELECT id, title FROM initiatives WHERE id = ?',
    [initiativeId],
  );
  if (!initiative) {
    throw new Error(`Initiative ${initiativeId} not found`);
  }

  // Build the UPDATE column-by-column so empty suggestions don't
  // overwrite existing values.
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, val: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(val);
  };
  if (suggestions.refined_description) push('description', suggestions.refined_description);
  if (suggestions.complexity) push('complexity', suggestions.complexity);
  if (suggestions.target_start) push('target_start', suggestions.target_start);
  if (suggestions.target_end) push('target_end', suggestions.target_end);
  if (suggestions.status_check_md) push('status_check_md', suggestions.status_check_md);
  if (suggestions.owner_agent_id) push('owner_agent_id', suggestions.owner_agent_id);

  const db = getDb();
  let fieldsUpdated = 0;
  let depsCreated = 0;
  let depsSkipped = 0;

  const tx = db.transaction(() => {
    if (sets.length > 0) {
      sets.push("updated_at = datetime('now')");
      run(
        `UPDATE initiatives SET ${sets.join(', ')} WHERE id = ?`,
        [...vals, initiativeId],
      );
      fieldsUpdated = sets.length - 1; // -1 for the auto-updated_at
    }

    for (const dep of suggestions.dependencies ?? []) {
      // Sanity guards: never link an initiative to itself, and never
      // crash on a stale id the PM might have made up.
      if (!dep.depends_on_initiative_id || dep.depends_on_initiative_id === initiativeId) {
        depsSkipped++;
        continue;
      }
      const target = queryOne<{ id: string }>(
        'SELECT id FROM initiatives WHERE id = ?',
        [dep.depends_on_initiative_id],
      );
      if (!target) {
        depsSkipped++;
        continue;
      }
      try {
        run(
          `INSERT INTO initiative_dependencies (id, initiative_id, depends_on_initiative_id, kind, note)
           VALUES (?, ?, ?, ?, ?)`,
          [
            uuidv4(),
            initiativeId,
            dep.depends_on_initiative_id,
            dep.kind ?? 'finish_to_start',
            dep.note ?? null,
          ],
        );
        depsCreated++;
      } catch {
        // UNIQUE(initiative_id, depends_on_initiative_id) collision —
        // this edge already exists. Treat as a skip rather than an error
        // so re-applying a proposal stays idempotent.
        depsSkipped++;
      }
    }
  });
  tx();

  return {
    fields_updated: fieldsUpdated,
    dependencies_created: depsCreated,
    dependencies_skipped: depsSkipped,
    initiative_title: initiative.title,
  };
}
