# Review-Stage Robustness — Validation

Validation skeleton for the [Review-Stage Robustness](../review-stage-robustness-spec.md) feature stack. Per the [long-unattended-feature-dev contract](../long-unattended-feature-dev.md), the operator reads `04-e2e-run-results.md` (verdict + evidence) instead of every intermediate diff.

## Read order

1. [`00-baseline-observations.md`](00-baseline-observations.md) — state of the dev DB + relevant rows before any slice lands.
2. [`01-pre-check-initialization.md`](01-pre-check-initialization.md) — destructive runbook to reach a known-good baseline before each test-plan run.
3. [`02-test-plan.md`](02-test-plan.md) — concrete RR-S* scenarios with setup / action / observation / capture path.
4. [`03-validation-criteria.md`](03-validation-criteria.md) — per-scenario gates + globals.
5. [`04-e2e-run-results.md`](04-e2e-run-results.md) — written during/after runs. Verdict (GREEN / YELLOW / BLOCKED / RED) + per-scenario evidence pointers.

## Conventions

- Real-agent dispatches use `spark-lb/agent` per [project_openclaw_model.md](../../memory/project_openclaw_model.md).
- Captures live at `/tmp/mc-validation/review-robust/<scenario_id>/`.
- Dev DB at `:4010` is fully separate from prod at `:4001` per [project_dev_prod_db_split.md](../../memory/project_dev_prod_db_split.md). Wipes are routine.
- HMR runaway: pre-check 01 confirms pending-brief queue is empty before any dispatch; restart cleanly between scenarios per [project_research_hmr_runaway.md](../../memory/project_research_hmr_runaway.md).
