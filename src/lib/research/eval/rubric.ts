/**
 * Pure rubric scoring for brief outputs.
 *
 * Phase 1 ships structural + length axes only — these are cheap,
 * deterministic, and catch the most common failure modes (no
 * citations, dropped structure, runaway length, empty body).
 *
 * Factual-accuracy axis arrives in phase 2 once we have ground-
 * truth fixtures and an LLM-judge worth the round-trip.
 *
 * Each axis returns a score in [0, 1] plus a one-line rationale.
 * Aggregate = mean of axes (equal weights for now; promote to
 * configurable weights only when we have data showing it matters).
 */

import type { BriefCitation } from '@/lib/db/briefs';

export interface RubricInput {
  result_md: string | null;
  citations: BriefCitation[];
  /** When set, fail the run regardless of output quality. */
  error_md?: string | null;
}

export interface AxisScore {
  /** 0 = worst, 1 = best. NaN reserved for "not applicable" (e.g.
   *  axis can't be evaluated because the brief failed). */
  score: number;
  rationale: string;
}

export interface RubricResult {
  axes: {
    completion: AxisScore;
    citations: AxisScore;
    structure: AxisScore;
    length: AxisScore;
  };
  /** Mean of finite axis scores. Range [0, 1]. */
  aggregate: number;
}

/** Length window. Outside the window the score linearly decays toward
 *  zero, capped at 0 below MIN/2 or above MAX*2. */
const LENGTH_MIN_WORDS = 200;
const LENGTH_MAX_WORDS = 2000;

const STRUCTURE_HEADINGS_LOWER = [
  // Researcher SOUL.md mandates this output shape:
  'summary',
  'findings',
  'gaps',
  'next steps',
];

function scoreCompletion(input: RubricInput): AxisScore {
  if (input.error_md) {
    return { score: 0, rationale: `brief failed: ${input.error_md.slice(0, 80)}` };
  }
  if (!input.result_md || input.result_md.trim().length === 0) {
    return { score: 0, rationale: 'no result body' };
  }
  return { score: 1, rationale: 'result body present' };
}

function scoreCitations(input: RubricInput): AxisScore {
  const count = input.citations.length;
  if (count === 0) {
    return { score: 0, rationale: 'no citations parsed from output' };
  }
  if (count >= 3) {
    return { score: 1, rationale: `${count} citations` };
  }
  return { score: count / 3, rationale: `${count} citation${count === 1 ? '' : 's'} (3 = full credit)` };
}

function scoreStructure(input: RubricInput): AxisScore {
  if (!input.result_md) return { score: 0, rationale: 'no body to score' };
  const lower = input.result_md.toLowerCase();
  const hits = STRUCTURE_HEADINGS_LOWER.filter(h => lower.includes(h));
  const score = hits.length / STRUCTURE_HEADINGS_LOWER.length;
  return {
    score,
    rationale: `${hits.length} of ${STRUCTURE_HEADINGS_LOWER.length} expected sections present (${hits.join(', ') || 'none'})`,
  };
}

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function scoreLength(input: RubricInput): AxisScore {
  if (!input.result_md) return { score: 0, rationale: 'empty body' };
  const words = countWords(input.result_md);
  if (words >= LENGTH_MIN_WORDS && words <= LENGTH_MAX_WORDS) {
    return { score: 1, rationale: `${words} words (in target window ${LENGTH_MIN_WORDS}–${LENGTH_MAX_WORDS})` };
  }
  if (words < LENGTH_MIN_WORDS) {
    // Linear ramp from 0 (at MIN/2) to 1 (at MIN).
    const floor = LENGTH_MIN_WORDS / 2;
    const ratio = Math.max(0, (words - floor) / (LENGTH_MIN_WORDS - floor));
    return { score: ratio, rationale: `${words} words (under target ${LENGTH_MIN_WORDS})` };
  }
  // words > MAX. Linear decay from 1 (at MAX) to 0 (at MAX*2).
  const ceiling = LENGTH_MAX_WORDS * 2;
  const ratio = Math.max(0, (ceiling - words) / (ceiling - LENGTH_MAX_WORDS));
  return { score: ratio, rationale: `${words} words (over target ${LENGTH_MAX_WORDS})` };
}

export function scoreRubric(input: RubricInput): RubricResult {
  const axes = {
    completion: scoreCompletion(input),
    citations: scoreCitations(input),
    structure: scoreStructure(input),
    length: scoreLength(input),
  };
  const finite = Object.values(axes).map(a => a.score).filter(s => Number.isFinite(s));
  const aggregate = finite.length > 0 ? finite.reduce((a, b) => a + b, 0) / finite.length : 0;
  return { axes, aggregate };
}
