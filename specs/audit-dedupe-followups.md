---
status: aspirational
built: false
last-verified: 2026-05-11
audience: ai-subagents-primary, operator-secondary
related-specs:
  - docs/archive/dedupe-investigations.md — original three-PR spec; PR #1, #2, and #3 are all shipped, this doc owns the still-open §Future items
  - subtree-audit-proposals-spec.md — audit pipeline that benefits from these guards
code-anchors:
  - src/lib/db/agent-runs.ts
  - src/lib/mcp/groups/core.ts
  - src/lib/mcp/groups/work.ts
  - src/lib/mcp/groups/pm.ts
  - src/lib/agents/dispatch-scope.ts
---

# Audit Dedupe Follow-ups

> **Status: aspirational.** The parent spec (`docs/archive/dedupe-investigations.md`) shipped all three of its named PRs:
> - PR #1 (migration 085 + `run_group_id` on `agent_runs` + `take_note` `run_cancelled` guard) — `src/lib/db/migrations.ts:4497-4514`, `src/lib/db/agent-runs.ts:63,356`, `src/lib/mcp/groups/core.ts:421-429`.
> - PR #2 (dispatch-time 409 guard with `supersede` escape hatch) — `src/app/api/initiatives/[id]/investigate/route.ts:183-228`.
> - PR #3 (UI cooldown "audited N min ago") — `src/components/InvestigateModal.tsx:277-302,496`.
>
> This spec owns the two follow-ups the parent flagged as out of scope and that are **still genuinely open**: generalizing the cancelled-run guard beyond `take_note`, and closing the brief-dispatch hole.

## Background

The cancelled-run guard lives on `take_note` only. A cancelled worker can still call `register_deliverable`, `log_activity`, and (for the PM persona) `propose_changes` and have those writes persist, because none of those handlers consult `getRunByGroupId` before writing. The same May 7 redundant-audit incident that motivated the parent spec would still produce orphan deliverables / activity rows under today's code — only the `agent_notes` row is now refused.

Separately, the brief-dispatch path passes `skip_run_row: true` (`src/lib/agents/dispatch-scope.ts:230`) so no `agent_runs` row is written at all. That dispatch path is fire-and-forget without a cancellation pathway today; any future cancellation feature for briefs needs to write a run row (or an equivalent linkable record) first, otherwise the guard has nothing to look up.

## Follow-up #1 — Generalize `run_cancelled` guard to other write tools

**Scope.** Apply the same lookup-and-refuse pattern used in `take_note` (`src/lib/mcp/groups/core.ts:421-429`) to:

- `register_deliverable` — `src/lib/mcp/groups/work.ts:336-358` and the handler body that follows.
- `log_activity` — `src/lib/mcp/groups/core.ts:299-321` and the handler body that follows.
- `propose_changes` (PM persona) — `src/lib/mcp/groups/pm.ts:76` and surrounding handler.

**Design.** Extract a small helper next to `getRunByGroupId`:

```ts
// src/lib/db/agent-runs.ts (or a sibling file)
export function assertRunNotCancelled(run_group_id: string | undefined | null):
  | { ok: true }
  | { ok: false; run_id: string; message: string };
```

Each handler calls the helper before its first DB write. On `{ ok: false }`, return the same shape `take_note` returns today: `content` with a refusal message, `isError: true`, `structuredContent: { error: 'run_cancelled', run_id, message }`. The fail-open contract from PR #1 applies — unknown `run_group_id` (legacy rows, brief dispatch) passes through.

**Note on `propose_changes`.** This tool is invoked by the PM persona, which today does not run under a cancellable `initiative_audit`-style row. Wiring the guard is still correct (defense in depth), but the operational payoff is much smaller than for the researcher-side tools.

**Test plan.** Mirror the existing `take_note` cancelled-run test (`src/lib/mcp/mcp.test.ts:598` neighborhood): start a run with a `run_group_id`, cancel it, call each tool with that `run_group_id`, assert `isError: true` and zero DB rows.

## Follow-up #2 — Brief-dispatch dedupe / cancellability

**Scope.** Briefs dispatched via `dispatchScope({ skip_run_row: true })` have no `agent_runs` row. Consequences:

- The PR #2 dispatch-time 409 guard can't see them, so two back-to-back brief dispatches on the same scope key both run.
- The PR #1 `run_cancelled` guard can't refuse their writes either — `getRunByGroupId` returns null and the tool falls through.

**Options (decide before implementing):**

1. **Write a row anyway.** Stop using `skip_run_row` for briefs; let them participate in the standard `agent_runs` lifecycle. Cheapest path to dedupe + cancellability, but increases the per-brief write footprint and may want a new `kind` value.
2. **Parallel table.** Introduce a `agent_briefs` mini-table with the same `run_group_id`/`status` shape that `getRunByGroupId` (or a sibling helper) can join. Keeps the brief path lean but doubles the surface.
3. **Leave briefs as-is.** Document that brief dispatches are by design un-deduped and uncancellable. Acceptable if briefs stay short-lived and idempotent in practice.

Recommendation: option (1) unless we measure a real cost. The original reason for `skip_run_row` was speed of the brief path, not a fundamental design constraint.

**Test plan.** Depends on chosen option; for (1), extend the existing run-lifecycle tests with a brief-dispatch case and assert the 409 guard catches a second back-to-back dispatch on the same scope key.

## Implementation order

1. Follow-up #1 first. It's a self-contained refactor (helper + three handler edits + three tests) and unblocks the symmetry argument that "all post-cancel writes are refused, not just notes."
2. Follow-up #2 after #1 ships. It's a design decision rather than a refactor, and the right answer may depend on how briefs evolve under `research-area.md`.

## Out-of-scope

- Touching the parent spec's PR #1/#2/#3 implementations — those are shipped and stable.
- Hardening the gateway-abort path so workers actually stop on `cancelAgentRun` rather than relying on the tool-side guard. That's a separate openclaw-side concern.
- Generalizing to non-write tools (read tools never need this).
