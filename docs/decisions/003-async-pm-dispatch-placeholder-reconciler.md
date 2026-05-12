---
adr-number: 3
status: accepted
date: 2026-05-11
deciders: smb209
related-specs:
  - specs/audit-pipeline.md — consumes the placeholder/reconciler pattern
  - specs/pm-diff-conventions.md — describes proposed_changes JSON shape
related-adrs: []
code-anchors:
  - src/lib/db/pm-proposals.ts:777
  - src/lib/agents/pm-dispatch.ts:532
  - src/lib/types.ts:1032
---

# ADR-003: PM dispatch is async; persist a synth placeholder, reconcile on agent reply

## Context

The original PM dispatch path was synchronous: the user clicked
"propose changes", MC dispatched the PM agent, awaited the round-trip,
and rendered the resulting diff. With real-LLM dispatches taking
30–120s, the UI blocked for the whole window. The user couldn't
review, couldn't queue another request, and the route timed out under
typical Next.js / Vercel HTTP timeouts.

`docs/archive/pm-dispatch-async.md` is the shipped design doc;
`specs/audit-pipeline.md` reuses the same pattern for audit-driven PM
proposals.

## Decision

We persist a **synth placeholder** `pm_proposals` row immediately on
the user's request (`dispatch_state='synth_only'`), return its id, and
dispatch the agent in the background. When the agent calls
`propose_changes` the late-arrival reconciler
(`supersedeWithAgentProposal` in `src/lib/db/pm-proposals.ts`) marks
the synth row `superseded`, attaches the agent's row via
`parent_proposal_id`, inherits the placeholder's `trigger_text`, and
emits a `pm_proposal_replaced` SSE event so the UI swaps the row in
place.

## Consequences

- Positive: UI stays responsive; the placeholder is immediately
  visible and the user can navigate away.
- Positive: dispatch is decoupled from request lifetime — long agent
  runs don't risk HTTP / gateway timeouts.
- Positive: same pattern generalises to audit-pipeline and any future
  long-running proposal dispatch.
- Negative: a placeholder with 0 actionable changes becomes noise;
  `deleteProposal` exists as the cleanup path (caller verifies state
  first).
- Things to watch: SSE delivery is not guaranteed — clients that miss
  `pm_proposal_replaced` must fall back to refetching by
  `trigger_text` JSON keys (e.g. `initiative_id`).

## Code anchors

1. `src/lib/db/pm-proposals.ts:777` — `supersedeWithAgentProposal`
   (the reconciler).
2. `src/lib/agents/pm-dispatch.ts:532` — emits `pm_proposal_replaced`.
3. `src/lib/types.ts:1032` — SSE event type registry.
