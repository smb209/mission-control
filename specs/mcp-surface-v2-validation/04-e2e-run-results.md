# 04 — E2E run results

_Filled in during/after the validation run. Operator reads this to decide "ship the stack."_

## Verdict

**TBD** — populated after PR 6 lands and validation runs.

## Summary paragraph

_(one paragraph: what passed, what didn't, any surprises)_

## Per-scenario results

| Scenario | Verdict | Notes / evidence pointer |
|---|---|---|
| V1 — PM endpoint surface | TBD | `/tmp/mc-validation/mcp-surface-v2/V1/` |
| V2 — Default endpoint regression | TBD | `/tmp/mc-validation/mcp-surface-v2/V2/` |
| V3 — `_shared` propagation | TBD | `/tmp/mc-validation/mcp-surface-v2/V3/` |
| V4 — Coordinator `update_subtask` | TBD | `/tmp/mc-validation/mcp-surface-v2/V4/` |
| V5 — Worker `update_note` | TBD | `/tmp/mc-validation/mcp-surface-v2/V5/` |
| V6 — PM `propose_changes` | TBD | `/tmp/mc-validation/mcp-surface-v2/V6/` |

## Global gates

| Gate | Verdict | Notes |
|---|---|---|
| GG1 `yarn test` | TBD | |
| GG2 `yarn mcp:smoke` | TBD | |
| GG3 dev server clean | TBD | |
| GG4 apply-mc-servers idempotent | TBD | |
| GG5 sync-named-agents idempotent | TBD | |

## Pre-existing test failures (carried in)

Captured at branch-cut (commit base = `b3ee394`):

| Test | File | Reason |
|---|---|---|
| `schedule-runner: produces a brief and advances run_count` | `src/lib/research/eval/schedule-runner.test.ts:23` | Flake in `runBriefInternal` orchestrator — `markComplete: agent_run … not found`. Unrelated to MCP surface work. Track as separate follow-up. |

722 tests total, 721 pass, 1 fail. Treat as carried-forward; don't gate this stack on it.

## Issues found

_(per-PR issues that surfaced during validation; whether fixed in-stack or filed for follow-up)_

## Token-savings measurement

| Endpoint | Tool count | Approx token cost |
|---|---|---|
| `/api/mcp` (default, post-stack) | TBD | TBD |
| `/api/mcp/pm` | TBD | TBD |
| `/api/mcp/crud` | TBD | TBD |
| Savings vs baseline (PM dispatch) | — | TBD |

## Sign-off

_Operator review here._
