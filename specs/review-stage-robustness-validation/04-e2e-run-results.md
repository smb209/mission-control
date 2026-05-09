# 04 · End-to-End Run Results

Written during/after the validation run against the stack tip. The single document the operator reads to decide "ship it."

## Verdict

**Status:** _PENDING_ (scaffolding only; no run yet)

Will be set to one of: GREEN / YELLOW / BLOCKED / RED.

## Summary

_(One paragraph after the run: what was exercised, what passed, what didn't. Specific row counts and key evidence.)_

## Per-scenario results

| Scenario | Slice | Result | Evidence |
|---|---|---|---|
| RR-S1 — Dispatch refused on missing reviewer | 0 | _PENDING_ | _path_ |
| RR-S2 — Full roster passes | 0 | _PENDING_ | _path_ |
| RR-S3 — Self-review block + auto-pick | 1 | _PENDING_ | _path_ |
| RR-S4 — Subtask evidence gate | 2 | _PENDING_ | _path_ |
| RR-S5 — Full incident replay | 3 | _PENDING_ | _path_ |
| RR-S6 — Review SLA auto-bounce | 4 | _PENDING_ | _path_ |

## Pre-existing test failures

_(Listed here per CLAUDE.md so they're not silently masked. File + reason each.)_

## Backfill audit (Slice 4)

_(Output of `scripts/audit-review-stalls.ts` before `MC_REVIEW_AUTOBOUNCE` is flipped on. Counts of `review`-status tasks with no reviewer / no evidence.)_

## Open issues surfaced during the run

_(Anything noticed in passing — not part of the gate set, but worth flagging for follow-up.)_

## Sign-off

_Operator review_: ___
_Date_: ___
