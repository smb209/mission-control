# Research Area — Validation Suite

Real-agent end-to-end validation for the Research Area phase 1 build (see [`../research-area-build-plan.md`](../research-area-build-plan.md)).

Follows the [long-unattended-feature-dev](../long-unattended-feature-dev.md) workflow.

## Files

| File | Purpose |
|---|---|
| [`00-baseline-observations.md`](00-baseline-observations.md) | Pre-slice-1 dev environment snapshot |
| [`01-pre-check-initialization.md`](01-pre-check-initialization.md) | Destructive runbook to reach known-good baseline before each test-plan run |
| [`02-test-plan.md`](02-test-plan.md) | Concrete real-agent dispatch scenarios |
| [`03-validation-criteria.md`](03-validation-criteria.md) | Pass/fail gates per scenario + globals |
| [`04-e2e-run-results.md`](04-e2e-run-results.md) | Verdict + evidence (written during/after runs) |

## How to use

1. **Before any code lands:** `00-baseline-observations.md` is captured (read-only, no DB writes). Done as part of the build-plan PR.
2. **Per validation milestone** (after slice 4 lands; after slice 5 lands; after any later phase):
   - Run `01-pre-check-initialization.md` end-to-end. Halt-on-failure.
   - Execute `02-test-plan.md` scenario by scenario. Capture transcripts to `/tmp/mc-validation/research/<scenario_id>/`.
   - Score against `03-validation-criteria.md`.
   - Write findings into `04-e2e-run-results.md` (append a new dated section per milestone).
3. **The operator reads `04-e2e-run-results.md`** to decide whether to merge the stack.

## Conventions

- All real-agent dispatches use `spark-lb/agent` (per `project_openclaw_model.md`).
- Scenario IDs are prefixed `R<n>.<m>` (R = Research).
- Every scenario captures input + output transcripts under `/tmp/mc-validation/research/<scenario_id>/`.
- Each scenario has a ~5-minute time budget; full plan ≤ 60 minutes wall clock.
