# Research Phase 2 — Validation

Validation directory for the recurring-briefs slice of `/research`.
Reflects the four-doc convention from
[docs/reference/long-unattended-feature-dev.md](../long-unattended-feature-dev.md).

## How to read

- **00-baseline-observations.md** — captured *before* any phase-2 slice lands. Used to diff DB + agent state after the run.
- **01-pre-check-initialization.md** — destructive runbook to reach a known-good baseline before each test-plan run.
- **02-test-plan.md** — concrete scenarios (RP2.S*) with setup/action/observation.
- **03-validation-criteria.md** — pass/fail gates per scenario + global gates.
- **04-e2e-run-results.md** — written during/after the run; operator reads this single doc to decide ship.

## How to run

```
# 1. Start from a clean dev DB
bash docs/archive/research-phase-2-validation/01-pre-check-initialization.md  # follow steps; halt on failure

# 2. Walk the test plan. Capture into /tmp/mc-validation/research-phase-2/<scenario_id>/
bash docs/archive/research-phase-2-validation/02-test-plan.md  # reference, not executable

# 3. Score against the criteria
$EDITOR docs/archive/research-phase-2-validation/03-validation-criteria.md

# 4. Write the verdict
$EDITOR docs/archive/research-phase-2-validation/04-e2e-run-results.md
```

All real-agent dispatches use `spark-lb/agent` per `project_openclaw_model.md`.
