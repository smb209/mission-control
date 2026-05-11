# Initiative Research Loop — Validation

Per [docs/reference/long-unattended-feature-dev.md](../long-unattended-feature-dev.md). Run order:

1. [00-baseline-observations.md](00-baseline-observations.md) — captured before any slice merges.
2. [01-pre-check-initialization.md](01-pre-check-initialization.md) — destructive runbook to reach known-good baseline before each test-plan execution.
3. [02-test-plan.md](02-test-plan.md) — the 7 scenarios.
4. [03-validation-criteria.md](03-validation-criteria.md) — pass/fail gates.
5. [04-e2e-run-results.md](04-e2e-run-results.md) — verdict + evidence; written during/after the run.

All real-agent dispatches use `spark-lb/agent` per `project_openclaw_model.md` memory. Capture path for transcripts: `/tmp/mc-validation/research-loop/<scenario_id>/`.

**HMR runaway guard** (per `project_research_hmr_runaway.md`): pre-check 01 verifies the pending-brief queue is empty and the dev server has been cleanly restarted since the last dispatch-code edit. Abort-if-not.
