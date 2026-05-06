/**
 * Pure helpers for the Investigate flow. Extracted from
 * InvestigateModal/InitiativeDetailView so they can be unit-tested
 * without spinning up a React renderer (the project doesn't ship
 * React component tests today — only `.test.ts` Node suites).
 */

import type { AgentNoteRecord } from '@/hooks/useAgentNotes';

/**
 * Count notes that qualify as "prior audit findings" for this
 * initiative — kind='observation', audience='pm', importance=2.
 *
 * Mirrors the criteria the investigate route uses when build_on mode
 * fetches priors via listNotes(initiative_id, audience:'pm',
 * min_importance:2). The audit prompt template only consumes
 * observations at or above importance 2, so this is the right
 * predicate to gate the "Build on prior audit" radio.
 */
export function countPriorAudits(notes: AgentNoteRecord[]): number {
  let n = 0;
  for (const note of notes) {
    if (note.kind !== 'observation') continue;
    if (note.audience !== 'pm') continue;
    if (note.importance < 2) continue;
    if (note.archived_at) continue;
    n += 1;
  }
  return n;
}

/**
 * Build the JSON body for POST /api/initiatives/:id/investigate. Kept
 * separate from the modal so the contract is easy to assert.
 */
export interface InvestigateRequestBody {
  mode: 'narrow';
  reaudit: 'fresh' | 'build_on';
  guidance?: string;
}
export function buildInvestigateBody(opts: {
  reaudit: 'fresh' | 'build_on';
  guidance: string;
}): InvestigateRequestBody {
  const trimmed = opts.guidance.trim();
  return {
    mode: 'narrow',
    reaudit: opts.reaudit,
    ...(trimmed ? { guidance: trimmed } : {}),
  };
}
