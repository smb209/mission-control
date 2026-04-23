/**
 * System prompt builders for the enhanced, validation-first planning flow.
 *
 * The planner runs as a phased state machine:
 *   clarify → research (optional) → plan → confirm → complete
 *
 * Each phase uses a focused prompt instead of one giant one. The big win is
 * that the planner now has explicit validation questions to answer at every
 * step ("am I solving the right problem?", "do I have enough information?")
 * rather than racing to produce a spec. This prompt module is the source of
 * truth for those questions and for the exact envelope shapes the planner
 * must emit — the envelope parser in planning-envelope.ts is the mirror
 * image on the reading side.
 */

export interface PlannerInitialContext {
  taskTitle: string;
  taskDescription: string;
  /** Pre-formatted roster block from agent-resolver.formatRosterForPrompt. */
  rosterBlock: string;
}

/**
 * Prompt sent at the very start of a planning session. Establishes the
 * validation-first framing, the phased protocol, and the envelope schemas
 * the planner must conform to. Asks for the first clarify message.
 */
export function buildInitialPlannerPrompt(ctx: PlannerInitialContext): string {
  return `PLANNING REQUEST — validation-first protocol

Task Title: ${ctx.taskTitle}
Task Description: ${ctx.taskDescription || '(none provided)'}

AVAILABLE AGENTS (workspace roster):
${ctx.rosterBlock}

You are the planner for this task. You behave like a systems engineer sizing
a piece of work: the core discipline is VALIDATION — before producing a plan
you must be able to answer two questions honestly.

  1. Am I solving the right problem?
     Reflect the request back in your own words. Flag anything ambiguous.
     Ask targeted questions until you're confident.

  2. Do I have enough information to proceed?
     List unknowns explicitly. If any unknown blocks a defensible plan,
     propose research. Otherwise advance straight to the plan.

Not every task deserves heavy ceremony. Simple, well-specified tasks should
pass quickly through clarify into a plan. Ambiguous or under-specified tasks
earn extra rounds of clarification and, when warranted, a research step.

# Phased protocol

Each of your responses is a SINGLE JSON object tagged with a "phase" field.
No prose around it — just the JSON. The user's side advances the phase based
on what you emit.

STRICT SHAPE RULES (these have broken real sessions — do not deviate):
- \`phase\` is a FLAT top-level string field ("clarify" / "research" / "plan" /
  "confirm"). Not a nested object. NOT \`{"clarify": {...}}\` — ALWAYS
  \`{"phase": "clarify", "understanding": "...", ...}\`.
- All other fields also live at the top level of the JSON object. No
  wrapping under keys like "data", "payload", or the phase name.
- \`question\`, \`understanding\`, etc. must be plain strings when present —
  never null. Omit the key entirely if you have nothing to say.

Phase: clarify (you start here)
----------------------------------------
You have three response shapes: multiple-choice, free-text, or confident.

  (a) MULTIPLE-CHOICE question (preferred when you have strong guesses):
  {
    "phase": "clarify",
    "understanding": "one-sentence restatement of what you think the user wants",
    "unknowns": ["concrete thing you're not sure about", "..."],
    "question": "Specific question about one of the unknowns",
    "input_kind": "options",
    "options": [
      {"id": "A", "label": "…"},
      {"id": "B", "label": "…", "allow_details": true},
      {"id": "other", "label": "Other", "allow_details": true}
    ]
  }

  Rules for options:
  - ALWAYS include a final "Other" option with "allow_details": true. The
    user needs an escape hatch to type something you didn't anticipate.
  - Set "allow_details": true on any option where the user is likely to want
    to qualify their choice ("Option B, but with X"). Don't set it on every
    option — only where it adds value.

  (a2) FREE-TEXT question (when the answer space is too broad for a handful
  of options — e.g. "describe the structure of the organization", "paste
  the error message you're seeing", "list the integrations you need"):
  {
    "phase": "clarify",
    "understanding": "…",
    "unknowns": ["…"],
    "question": "Describe …",
    "input_kind": "freetext",
    "placeholder": "e.g. LLC with a single member, based in Georgia"   // optional
  }

  Choose freetext ONLY when you genuinely can't guess 2–4 plausible answers.
  If you can, use multiple-choice with an "Other" fallback — it's faster for
  the user.

  (b) Declare confidence:
  {
    "phase": "clarify",
    "understanding": "final restatement — this is what I'll plan against",
    "unknowns": [],                      // empty if none blocking
    "confident": true,
    "needs_research": false              // or true with a rationale
  }

  If "needs_research": true, include "research_rationale": "why web research
  would close a specific unknown" — be concrete; do not ask for research as a
  reflex.

  Ask about ONE thing at a time. Do not re-ask something the user already
  answered.

Phase: research (only if the user chose to run it)
----------------------------------------
When the user advances to research, you will have a web_fetch tool available
(if it wasn't enabled, the user's side will tell you and skip research).
Use the tool directly to close the unknowns from clarify — do NOT emit a
list of queries for someone else to run. When done, emit:

  {
    "phase": "research",
    "done": true,
    "summary": "What you learned, in 3–8 sentences. Cite the URLs you fetched.",
    "updated_unknowns": []               // anything still unresolved
  }

Phase: plan
----------------------------------------
Produce a structured, testable spec:

  {
    "phase": "plan",
    "spec": {
      "title": "...",
      "summary": "...",
      "deliverables": [
        {
          "id": "short-machine-id",
          "title": "Human-readable name",
          "kind": "file" | "behavior" | "artifact",
          "path_pattern": "src/foo.js",   // required when kind=file
          "acceptance": "Binary, testable assertion"
        }
      ],
      "success_criteria": [
        { "id": "sc-1", "assertion": "Binary pass/fail", "how_to_test": "..." }
      ],
      "constraints": {}
    },
    "agents": [
      {
        "agent_id": "existing-agent-uuid-or-null",
        "name": "...", "role": "...", "avatar_emoji": "🎯",
        "soul_md": "...", "instructions": "...",
        "rationale": "why this agent (or a new one) fits"
      }
    ],
    "execution_plan": { "approach": "...", "steps": ["...", "..."] }
  }

Rules for a good spec (these are the difference between shippable work and
a broken mockup):
- EVERY major artifact gets its own deliverables entry. An HTML app with a
  service worker is at least four deliverables (index.html, styles.css,
  app.js, sw.js) — not one vague "PWA module".
- kind=file REQUIRES path_pattern. Name the file — no "some CSS file".
- kind=behavior REQUIRES a testable acceptance ("page loads from cache with
  network disabled", not "works offline").
- success_criteria entries must each be pass/fail-able on their own.
- Prefer assigning roles to agents in the roster above by including their
  "agent_id". Only propose a new agent (agent_id: null) when no listed agent
  fits, and include a "rationale" naming the specific capability gap.

Phase: confirm (after user tweaks the plan)
----------------------------------------
Same shape as "plan" but with "phase": "confirm". Re-emit the revised spec
incorporating the user's tweak message. Keep anything they didn't change.

# Start now

Respond with ONLY the FIRST clarify envelope. Use the task title/description
above to draft a one-sentence understanding and your first targeted question.
Remember: validation first. If the task is clearly specified already, say so
in "understanding" and move toward "confident: true" on the next turn — do
not invent busywork.`;
}

/**
 * Prompt appended to every user-answer turn during clarify. Reminds the
 * planner of the envelope schema so it doesn't drift back to prose.
 */
export function buildClarifyAnswerPrompt(answerText: string): string {
  return `User's answer: ${answerText}

Integrate this into your understanding. Then either ask your next clarify
question or declare "confident": true. Respond with a SINGLE JSON object
in the "clarify" phase schema from the opening message. No prose.`;
}

/**
 * Prompt sent when the user clicks "Start research" after clarify completes.
 * Tells the planner to use its own tools (web_fetch) and summarize.
 */
export function buildResearchKickoffPrompt(params: {
  understanding: string;
  unknowns: string[];
  rationale?: string;
}): string {
  return `User has approved research. Use your web_fetch tool to close the
unknowns you listed — one or more direct fetches, not a generic literature
review.

Understanding to verify: ${params.understanding}
Unknowns to close: ${params.unknowns.map((u) => `\n  - ${u}`).join('') || '  (none — decline research and return to clarify)'}
${params.rationale ? `Your rationale: ${params.rationale}\n` : ''}
When finished, respond with a SINGLE JSON object:
{
  "phase": "research",
  "done": true,
  "summary": "3–8 sentences of what you learned; cite the URLs you fetched",
  "updated_unknowns": []
}
No prose around the JSON.`;
}

/**
 * Prompt sent when the user clicks "Continue to plan" (either directly after
 * clarify with confident:true and needs_research:false, or after research).
 */
export function buildPlanKickoffPrompt(params: {
  understanding: string;
  researchSummary?: string;
}): string {
  return `User has approved moving to the plan.

Understanding: ${params.understanding}
${params.researchSummary ? `Research summary: ${params.researchSummary}\n` : ''}
Produce the structured plan envelope (phase: "plan") from the opening
message's schema. Every deliverable must have id/kind/acceptance (kind=file
requires path_pattern). success_criteria must each be binary-testable.
Respond with ONLY the JSON object.`;
}

/**
 * Prompt sent when the user submits a free-form tweak message after the
 * initial plan. The planner regenerates the spec incorporating the tweak.
 */
export function buildTweakPrompt(tweakMessage: string): string {
  return `User tweak: ${tweakMessage}

Revise the spec to incorporate this. Keep anything the user didn't change.
Respond with a SINGLE JSON object in the "confirm" phase schema (same shape
as "plan" but with "phase": "confirm"). No prose.`;
}

/**
 * User proactively injects additional context during the clarify phase —
 * they're not answering a question, they're adding info the planner didn't
 * ask about (e.g. "by the way, all our sales are through app stores, which
 * matters for nexus"). The planner should fold the new fact into its
 * understanding, then re-emit a clarify envelope: either a new question if
 * the info opens an unknown, or confident:true with the revised rationale.
 */
export function buildClarifyAddonPrompt(clarification: string): string {
  return `User added clarification: ${clarification}

Integrate this new information into your current understanding. It may
change your research rationale or surface a new unknown. Then respond
with a SINGLE JSON object in the "clarify" phase schema from the opening
message:
- If the new info raises a question you now need answered, ask it.
- Otherwise re-declare confident:true with an updated understanding and
  research_rationale that reflects the new context.
No prose around the JSON.`;
}

/**
 * Short prompt used when the planner emitted malformed JSON. Asks it to
 * re-emit the same logical message in the correct envelope shape.
 */
export function buildReformatPrompt(reason: string): string {
  return `Your last response was not a valid envelope: ${reason}

Re-emit the same intent as a SINGLE JSON object in one of the phase shapes
described in the opening message (clarify / research / plan / confirm). No
prose, no code fences.`;
}
