# E2E run results — phase 2 schedules

Single document the operator reads to decide ship/no-ship. Filled in DURING and AFTER the run, not before.

## Verdict

> **TBD — fill in after running 02-test-plan.md against the stacked branches.**
>
> Format: `GREEN | YELLOW | BLOCKED | RED` + one paragraph summarizing what passed, what didn't, and any judgment calls.

## Per-scenario results

| ID | Verdict | Evidence | Notes |
|---|---|---|---|
| RP2.S1.1 | _pending_ | `/tmp/mc-validation/research-phase-2/RP2.S1.1/` | |
| RP2.S1.2 | _pending_ | … | |
| RP2.S1.3 | _pending_ | … | |
| RP2.S2.1 | _pending_ | … | real-agent run |
| RP2.S2.2 | _pending_ | … | failure-pause path |
| RP2.S2.3 | _pending_ | … | resume path |
| RP2.S3.1 | _pending_ | … | run-now |
| RP2.S3.2 | _pending_ | … | delete |
| RP2.S4.1 | _pending_ | … | Upcoming lane |
| RP2.S4.2 | _pending_ | … | topic detail |
| RP2.S4.3 | _pending_ | … | drawer create |
| RP2.S4.4 | _pending_ | … | delete confirm dialog |
| RP2.S5.1 | _pending_ | … | preflight: no researcher |
| RP2.S5.2 | _pending_ | … | preflight: no runner |
| RP2.S6.1 | _pending_ | … | eval scenario |

## Global gates

| Gate | Verdict | Notes |
|---|---|---|
| G1 — no unhandled SSE errors | _pending_ | |
| G2 — no migration errors | _pending_ | |
| G3 — tsc clean except baseline | _pending_ | List the pre-existing failures here verbatim. |
| G4 — no native confirm/alert | _pending_ | grep diff for `window.confirm` / `window.alert` |
| G5 — all transcripts captured | _pending_ | |

## Pre-existing failures observed

Per CLAUDE.md, list any pre-existing breakage that surfaced during the run so it's not silently absorbed:

- `src/lib/agents/pm-decompose.test.ts` — ts errors documented in 00-baseline. Confirm still present (don't fix in phase 2).
- _Add others as encountered._

## Judgment calls

If any of the §7 open questions in the build plan got answered during the run (e.g. "actually, default cadence should be Daily"), record the decision here so the next reviewer doesn't re-litigate it.

## Branch + commit pointers

```
build plan branch:    feat/research-phase-2/<final slice>
verdict captured at:  <git rev-parse HEAD>
build-plan doc:       specs/research-phase-2-schedules-build-plan.md
```
