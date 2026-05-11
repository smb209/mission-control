---
adr-number: 8
status: accepted
date: 2026-05-11
deciders: smb209
related-specs:
  - docs/reference/research-area.md — research dispatch path that pioneered the opt-out
  - docs/reference/jobs-in-progress.md — consumer of the generalised envelope
related-adrs: []
code-anchors:
  - src/lib/db/migrations.ts:4316
  - src/lib/agents/dispatch-scope.ts:138
  - src/lib/research/run-brief.ts:455
---

# ADR-008: `agent_runs` is the general dispatch envelope; briefs opt out via `skip_run_row`

## Context

`agent_runs` originally tracked only research dispatches — its `kind`
column accepted a narrow enum and its other columns assumed research-
shaped attribution (scope, role). As we added more dispatch surfaces
(pm_chat, plan, decompose, initiative_audit, recurring, task_coord,
task_role), each one needed the same "what's running, who launched
it, when did it finish" envelope.

Migration 080 (`src/lib/db/migrations.ts:4316`) generalised the
table: it rebuilt `agent_runs` with the relaxed enum and added
scope / role / agent / parent attribution columns shared across
dispatch kinds.

Briefs are different: each brief gets its own `briefs` row that
already serves as the run envelope, and writing a duplicate
`agent_runs` row would double-count "active dispatches" in dashboards.

## Decision

`agent_runs` is the canonical dispatch envelope for every kind in the
relaxed enum: `pm_chat | plan | decompose | initiative_audit |
recurring | task_coord | task_role | research`. The shared
`dispatchScope()` helper writes the row on launch and updates it on
completion. Briefs explicitly opt out by passing `skip_run_row: true`
to `dispatchScope`, deferring entirely to the `briefs` table.

## Consequences

- Positive: dashboards and audits can query one table to see "every
  agent run in the system" without unioning N kind-specific tables.
- Positive: new dispatch kinds plug in by adding to the enum, not by
  building a parallel envelope.
- Negative: the opt-out is a foot-gun — a future dispatch surface
  that mistakenly sets `skip_run_row: true` will be invisible to the
  active-run dashboard. The flag should be reserved for cases (like
  briefs) that already have a primary envelope row elsewhere.
- Things to watch: if a third opt-out caller emerges, that's a signal
  to invert the API (default opt-out, explicit opt-in) or introduce
  a typed marker per dispatch kind.

## Code anchors

1. `src/lib/db/migrations.ts:4316` — migration 080 generalises
   `agent_runs.kind` and adds attribution columns.
2. `src/lib/agents/dispatch-scope.ts:138` — `DispatchScopeInput.skip_run_row`.
3. `src/lib/research/run-brief.ts:455` — the brief dispatch path
   passing `skip_run_row: true`.
