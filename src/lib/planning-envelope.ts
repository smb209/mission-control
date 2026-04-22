/**
 * Phase-aware planning envelope parser.
 *
 * The enhanced planner emits JSON envelopes tagged with a `phase` field so
 * the backend can drive a validation-first state machine:
 *   clarify → research (optional) → plan → confirm → complete
 *
 * This module:
 *   1. Parses loose LLM output via extractJSON (reusing existing helper).
 *   2. Classifies the envelope by phase + shape.
 *   3. Surfaces a normalized union type the route handlers branch on.
 *
 * Legacy envelopes (no `phase` field) are still understood — an old-style
 * `{ question, options }` maps to `phase: 'clarify'` with no understanding,
 * and an old-style `{ status: "complete", spec, agents }` maps to
 * `phase: 'plan'` so the confirm-step gate still applies to in-flight tasks
 * upgraded mid-flow.
 */

import { extractJSON } from './planning-utils';
import type { SpecDeliverable, SpecSuccessCriterion } from './types';

export type PlanningPhase = 'clarify' | 'research' | 'plan' | 'confirm' | 'complete';

export interface PlanningQuestionOption {
  id: string;
  label: string;
  /** When true, selecting this option reveals a free-text clarifier input so
   *  the user can add detail alongside the choice. Used for "Other / specify"
   *  and for "Option B + add nuance" patterns. */
  allow_details?: boolean;
}

/**
 * Clarify: planner has restated its understanding and is asking the user.
 *
 * Two answer shapes:
 *   - `input_kind: 'options'` (default) — multiple choice. Individual options
 *     may set `allow_details: true` to reveal a clarifier text input when
 *     selected. "Other" is a conventional example.
 *   - `input_kind: 'freetext'` — no options; the user types a free-form
 *     answer. Used for inherently open questions like "describe the structure
 *     of the organization".
 */
export interface ClarifyQuestionEnvelope {
  kind: 'clarify_question';
  understanding: string;
  unknowns: string[];
  question: string;
  input_kind: 'options' | 'freetext';
  /** Non-empty when input_kind='options'; ignored otherwise. */
  options: PlanningQuestionOption[];
  /** Optional placeholder shown in the free-text input (when input_kind is
   *  'freetext' or an option with allow_details=true is selected). */
  placeholder?: string;
}

/** Clarify: planner is confident it understands; decides whether research is needed. */
export interface ClarifyDoneEnvelope {
  kind: 'clarify_done';
  understanding: string;
  unknowns: string[];
  confident: true;
  needs_research: boolean;
  research_rationale?: string;
}

/** Research: planner has finished its own web_fetch calls and is summarizing. */
export interface ResearchDoneEnvelope {
  kind: 'research_done';
  summary: string;
  updated_unknowns: string[];
}

/**
 * Plan / Confirm: planner has produced a structured spec. Same shape is used
 * for initial plan emission and post-tweak regeneration — the phase column on
 * the task tells the caller which it is.
 */
export interface PlanEnvelope {
  kind: 'plan';
  spec: {
    title: string;
    summary: string;
    deliverables: Array<SpecDeliverable | string>;
    success_criteria: Array<SpecSuccessCriterion | string>;
    constraints?: Record<string, unknown>;
  };
  agents: Array<{
    name: string;
    role: string;
    avatar_emoji?: string;
    soul_md?: string;
    instructions?: string;
    agent_id?: string | null;
    rationale?: string;
  }>;
  execution_plan?: Record<string, unknown>;
}

export type PlanningEnvelope =
  | ClarifyQuestionEnvelope
  | ClarifyDoneEnvelope
  | ResearchDoneEnvelope
  | PlanEnvelope;

export interface ParseEnvelopeResult {
  envelope: PlanningEnvelope | null;
  /** Raw parsed JSON, returned even when classification fails, so callers can
   *  decide whether to display it in a parse-error banner or ask the planner
   *  to reformat. */
  raw: Record<string, unknown> | null;
  /** Populated when classification fails — a short reason for logging / UI. */
  reason?: string;
}

/**
 * Parse and classify a planner assistant message.
 *
 * Returns { envelope: null, raw, reason } when the text either didn't parse
 * as JSON or parsed but doesn't match any known envelope shape. Callers:
 *   - If raw is null → unrecoverable garbage; surface parse error.
 *   - If raw is present but envelope is null → ask planner to reformat
 *     using the reason as guidance.
 */
export function parsePlanningEnvelope(text: string): ParseEnvelopeResult {
  const raw = extractJSON(text) as Record<string, unknown> | null;
  if (!raw) {
    return { envelope: null, raw: null, reason: 'No JSON object found in planner output.' };
  }

  const phase = typeof raw.phase === 'string' ? raw.phase : undefined;

  // --- Legacy shapes (no phase tag) -----------------------------------------
  // Old question shape: { question, options }
  if (!phase && typeof raw.question === 'string' && Array.isArray(raw.options)) {
    return {
      envelope: {
        kind: 'clarify_question',
        understanding: '',
        unknowns: [],
        question: raw.question,
        input_kind: 'options',
        options: normalizeOptions(raw.options),
      },
      raw,
    };
  }
  // Old completion shape: { status: 'complete', spec, agents }
  if (!phase && raw.status === 'complete' && isRecord(raw.spec)) {
    const plan = tryBuildPlan(raw);
    if (plan) return { envelope: plan, raw };
  }

  // --- Phased shapes --------------------------------------------------------
  if (phase === 'clarify') {
    const understanding = typeof raw.understanding === 'string' ? raw.understanding : '';
    const unknowns = Array.isArray(raw.unknowns)
      ? raw.unknowns.filter((u): u is string => typeof u === 'string')
      : [];
    const placeholder = typeof raw.placeholder === 'string' ? raw.placeholder : undefined;

    // New free-text clarify shape: { phase:'clarify', question, input_kind:'freetext' }
    if (raw.input_kind === 'freetext' && typeof raw.question === 'string') {
      return {
        envelope: {
          kind: 'clarify_question',
          understanding,
          unknowns,
          question: raw.question,
          input_kind: 'freetext',
          options: [],
          placeholder,
        },
        raw,
      };
    }

    if (typeof raw.question === 'string' && Array.isArray(raw.options)) {
      return {
        envelope: {
          kind: 'clarify_question',
          understanding,
          unknowns,
          question: raw.question,
          input_kind: 'options',
          options: normalizeOptions(raw.options),
          placeholder,
        },
        raw,
      };
    }

    if (raw.confident === true) {
      return {
        envelope: {
          kind: 'clarify_done',
          understanding,
          unknowns,
          confident: true,
          needs_research: raw.needs_research === true,
          research_rationale: typeof raw.research_rationale === 'string' ? raw.research_rationale : undefined,
        },
        raw,
      };
    }

    return { envelope: null, raw, reason: 'clarify envelope missing both a question and confident:true' };
  }

  if (phase === 'research') {
    if (raw.done === true && typeof raw.summary === 'string') {
      const updated_unknowns = Array.isArray(raw.updated_unknowns)
        ? raw.updated_unknowns.filter((u): u is string => typeof u === 'string')
        : [];
      return {
        envelope: { kind: 'research_done', summary: raw.summary, updated_unknowns },
        raw,
      };
    }
    return { envelope: null, raw, reason: 'research envelope must have done:true and a summary string' };
  }

  if (phase === 'plan' || phase === 'confirm') {
    const plan = tryBuildPlan(raw);
    if (plan) return { envelope: plan, raw };
    return { envelope: null, raw, reason: `${phase} envelope missing spec/agents` };
  }

  return { envelope: null, raw, reason: `Unknown phase: ${String(phase)}` };
}

function normalizeOptions(input: unknown[]): PlanningQuestionOption[] {
  const out: PlanningQuestionOption[] = [];
  for (const item of input) {
    if (isRecord(item) && typeof item.id === 'string' && typeof item.label === 'string') {
      const opt: PlanningQuestionOption = { id: item.id, label: item.label };
      // Treat a literal "Other" label as allow_details by default so the
      // legacy prompt shape keeps its free-text escape hatch working even
      // without the new flag.
      const isOtherByConvention =
        item.id === 'other' || item.label.toLowerCase() === 'other';
      if (item.allow_details === true || (isOtherByConvention && item.allow_details !== false)) {
        opt.allow_details = true;
      }
      out.push(opt);
    }
  }
  return out;
}

function tryBuildPlan(raw: Record<string, unknown>): PlanEnvelope | null {
  if (!isRecord(raw.spec)) return null;
  const spec = raw.spec;
  if (typeof spec.title !== 'string' || typeof spec.summary !== 'string') return null;

  const deliverables = Array.isArray(spec.deliverables) ? spec.deliverables : [];
  const success_criteria = Array.isArray(spec.success_criteria) ? spec.success_criteria : [];
  const agents = Array.isArray(raw.agents) ? raw.agents : [];

  return {
    kind: 'plan',
    spec: {
      title: spec.title,
      summary: spec.summary,
      deliverables: deliverables as Array<SpecDeliverable | string>,
      success_criteria: success_criteria as Array<SpecSuccessCriterion | string>,
      constraints: isRecord(spec.constraints) ? (spec.constraints as Record<string, unknown>) : undefined,
    },
    agents: agents.filter(isRecord).map((a) => {
      const rec = a as Record<string, unknown>;
      return {
        name: typeof rec.name === 'string' ? rec.name : 'Unnamed',
        role: typeof rec.role === 'string' ? rec.role : 'worker',
        avatar_emoji: typeof rec.avatar_emoji === 'string' ? rec.avatar_emoji : undefined,
        soul_md: typeof rec.soul_md === 'string' ? rec.soul_md : undefined,
        instructions: typeof rec.instructions === 'string' ? rec.instructions : undefined,
        agent_id: typeof rec.agent_id === 'string' ? rec.agent_id : rec.agent_id === null ? null : undefined,
        rationale: typeof rec.rationale === 'string' ? rec.rationale : undefined,
      };
    }),
    execution_plan: isRecord(raw.execution_plan) ? (raw.execution_plan as Record<string, unknown>) : undefined,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
