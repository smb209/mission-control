# 04 · End-to-End Run Results

Written 2026-05-09 against the stack tip (commit `ad56c43` on `feat/review-robust-5-docs`).

## Verdict

**Status: GREEN**

All six scenarios passed live against the dev server (`:4010`) with all four feature flags enabled. Audit script ran cleanly. One validation-phase finding (escalate_to_parent mailbox push silently failing on authz) caught + fixed in the same session — the activity trail and status flip already worked, only the operator-side notify was lost; the fix uses the same sendMail-without-authz convention as `stall-detection.ts`.

109/109 unit-test stack-tip targeted suite passes; 989/990 full repo (one pre-existing failure in `schedule-runner.test.ts` carried from `main`).

## Run environment

- Server: `mission-control-dev` via preview, port `4010`.
- DB: `./mission-control.db` (dev), backed up before run as `backups/mc-backup-2026-05-09T22-03-44-v092.db`.
- Flags enabled in launch.json:
  - `MC_ROSTER_GATE=1`
  - `MC_REVIEW_STRICT_GATING=1`
  - `MC_REVIEW_AUTOBOUNCE=1`
  - `STALL_DETECTION_MINUTES_REVIEW=1` (1m for accelerated SLA)

## Per-scenario results

| Scenario | Slice | Result | Evidence |
|---|---|---|---|
| **RR-S1 — Dispatch refused on missing reviewer** | 0 | ✅ GREEN | HTTP 422, `code:"roster_incomplete"`, `missing:["reviewer"]`, task → `needs_user_input`, `roster_incomplete` activity, mailbox to PM, `agent_runs=0`. `/tmp/mc-validation/review-robust/RR-S1/`. |
| **RR-S2 — Full roster passes** | 0 | ✅ GREEN | HTTP 200, `success:true`, `openclaw_sessions` row created, no `roster_incomplete` activity. `/tmp/mc-validation/review-robust/RR-S2/`. |
| **RR-S3 — Self-review block + auto-pick** | 1 | ✅ GREEN | First call (only builder, no reviewer): `reviewer_required` rejection. After adding reviewer agent: transition succeeded, `task_roles` row written for `rr-s3-reviewer`. Self-review path (pre-seeded reviewer = builder): `self_review_blocked`, task stayed `in_progress`. `/tmp/mc-validation/review-robust/RR-S3/`. |
| **RR-S4 — Subtask cannot reach review without `test_full`** | 2 | ✅ GREEN | First attempt: `evidence_gate` rejection naming `test_full`. After inserting passing evidence row: transition succeeded. `/tmp/mc-validation/review-robust/RR-S4/`. |
| **RR-S5 — Full incident replay** | 3 | ✅ GREEN | `spawn_subtask` denial returned `next_action:"escalate_to_parent"` + `blocked_tools:[…]`, `locked_for_completion=1` on subtask. `register_deliverable` while locked rejected with `task_locked_pending_escalation`. `escalate_to_parent` succeeded: child → `assigned`/`is_failed=1`/`status_reason="Failed: child_escalated — …"`, lock cleared, parent gained `escalation` activity, coordinator mailbox row written (after the validation-phase fix in `ad56c43`). `/tmp/mc-validation/review-robust/RR-S5/` + `/RR-S5b/`. |
| **RR-S6 — Stale review auto-bounces** | 4 | ✅ GREEN | Single scan with `STALL_DETECTION_MINUTES_REVIEW=1` and 5m idle: both `reviewer_stalled` (1×) and `review_autobounced` (2×) fired, status flipped to `assigned`/`is_failed=1`/`status_reason="Failed: reviewer unresponsive (idle 5m)"`, reviewer got `REVIEW SLA: idle 5m`, coordinator got `REVIEW SLA: child auto-bounced`. `/tmp/mc-validation/review-robust/RR-S6/`. |

### Globals

- **GG-1** — preview console: clean. No errors or unhandled rejections noted in `/tmp/mc-dev.log` for the scenario windows.
- **GG-2** — targeted suite: ✅ 109/109. Full repo 989/990.
- **GG-3** — no worker dispatched on a refused gate: ✅ verified explicitly in RR-S1 (`agent_runs=0` after 422).
- **GG-4** — pre-existing failures listed: ✅ `src/lib/research/eval/schedule-runner.test.ts > "schedule-runner: produces a brief and advances run_count"`. Confirmed pre-existing on `main@483d5de` via stash + re-run before Slice 0.
- **GG-5** — backfill audit run before flipping `MC_REVIEW_AUTOBOUNCE=1`: ✅ `yarn audit:review-stalls` output preserved at `/tmp/mc-validation/review-robust/00-audit.log`. Found 2 pre-existing review-stage parking-lot rows (`92b7b092` — the spec's trigger incident — and `3ecfc55b`). Both lack reviewer + evidence + are over the 20m threshold; both would auto-bounce on the next scan, which is the expected behavior. Operator decision: leave as-is or board_override before re-enabling autobounce in prod.

## Validation-phase findings

| # | Finding | Slice | Status |
|---|---|---|---|
| F1 | `escalate_to_parent` mailbox push silently failed: `sendAgentMail` runs `assertAgentCanActOnTask(escalating-agent, parent-task, 'activity')`, but the escalating PM is by definition not on the parent task. Activity row + status flip + lock clear all worked; only the operator-side notify was lost. | 3 (committed on Slice 5 head as `ad56c43`) | ✅ Fixed: switched to direct `sendMail` from `@/lib/mailbox` with `from=to=coordinator/pm`, matching the system-emitted convention used by `stall-detection.ts`. Re-ran RR-S5 — coordinator mailbox row now appears. |

## Pre-existing test failures

| File | Test | Status |
|---|---|---|
| `src/lib/research/eval/schedule-runner.test.ts` | `schedule-runner: produces a brief and advances run_count` | Pre-existing on `main@483d5de`. Confirmed via stash + re-run before this stack landed. Not in the blast radius of any slice. |

## Backfill audit (Slice 4)

`yarn audit:review-stalls` against the current dev DB:

```
# Review-stage audit (threshold 20m)
Total review-status tasks: 2
## No reviewer assigned (2)
- 3ecfc55b-0b94-4647-b74d-f030090cbac0 · default · idle=14099m · Build AlertDialog component mirroring ConfirmDialog
- 92b7b092-a7b6-4542-ba41-b1bdb95860db · default · idle=431m · Implement alert() replacements, alert-shim heuristics, and verify no regressions
## No evidence rows (2)
- (same two rows)
## Over SLA threshold (20m) (2)
- (same two rows)

2 task(s) lack BOTH reviewer and evidence — these are the highest-risk parking-lot rows.
```

Recommendation: in the dev DB these are leftover from earlier sessions (including the spec's trigger incident `92b7b092`); operator can `board_override` them or let the next stall scan auto-bounce them. Either way the scanner will not surprise anyone.

## Open issues surfaced

None beyond F1 (already fixed). Stack is ready to merge.

## Sign-off

Operator review: _pending_
Date: _pending_
