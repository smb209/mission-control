# 04 — E2E run results

> Written during/after the validation run. Single document the operator reads to decide "ship it."

## Verdict

_pending — to be filled in after the run_

One of: **GREEN** / **YELLOW** / **BLOCKED** / **RED** (per `03-validation-criteria.md`).

One-paragraph summary: what passed, what failed, and what the operator should do next.

## Per-scenario results

| ID | Scenario | Result | Evidence |
|---|---|---|---|
| R-S1 | Suggest scoped to initiative | _pending_ | `/tmp/mc-validation/research-loop/R-S1/` |
| R-S2 | Auto-note on completion | _pending_ | `R-S2/` |
| R-S3 | Rerun replace | _pending_ | `R-S3/` |
| R-S4 | Decompose context loads auto-note | _pending_ | `R-S4/` |
| R-S5 | `read_brief` discoverability | _pending_ | `R-S5/` |
| R-S6 | Full UI loop | _pending_ | `R-S6/` |
| R-S7 | Proposal references research | _pending_ | `R-S7/` |

## Global gates

| ID | Gate | Result | Note |
|---|---|---|---|
| GG.1 | per-PR test slices green | _pending_ | |
| GG.2 | `yarn mcp:smoke` | _pending_ | |
| GG.3 | typecheck / build | _pending_ | |
| GG.4 | no new error log entries | _pending_ | |
| GG.5 | queue empty at end | _pending_ | |
| GG.6 | ≤ 1 dispatch per scenario | _pending_ | |
| GG.7 | pre-existing failures listed | _pending_ | |

## Pre-existing test failures (if any)

_To be filled in from `yarn test` baseline. File + reason. Per CLAUDE.md, listed not silenced._

## Anomalies / flakes

_Per scenario, any retries or unexpected observations._

## Next steps

_If GREEN: merge order per `feedback_stacked_pr_merges.md`._
_If YELLOW: itemized list of accepted defects + follow-up tickets._
_If RED/BLOCKED: what to fix before re-running._
