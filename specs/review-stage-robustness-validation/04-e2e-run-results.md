# 04 · End-to-End Run Results

Written 2026-05-09 against the stack tip at `feat/review-robust-5-docs` (commit `e0ba43e`).

## Verdict

**Status: STRUCTURAL GREEN — real-agent run NEEDS-OPERATOR**

Six slices land cleanly. 109/109 of the targeted-suite tests pass at the stack tip — including 48 new tests that directly exercise every load-bearing path in the spec (roster gate, reviewer-required, self-review block, subtask evidence, soft-lock, escalate_to_parent end-to-end, review SLA). Full repo suite is 989/990 pass; the one failure (`schedule-runner.test.ts > "schedule-runner: produces a brief and advances run_count"`) is pre-existing on `main` (verified via stash + re-run before Slice 0) and unrelated to this stack.

The headline scenario (RR-S5, full incident replay) is exercised by the in-process MCP harness — `mcp.test.ts` boots the real `buildServer()` over an `InMemoryTransport` pair and drives `spawn_subtask` → soft-lock → `register_deliverable` rejection → `escalate_to_parent` → child bounce + parent activity. That harness is structurally identical to a real openclaw caller; the only difference is the wire transport.

Live real-agent run on `spark-lb/agent` against `:4010` was not executed: the dev port is currently held by the Claude desktop app's network service (PID 52321), which is not safe for me to kill. Operator action: free `:4010`, run the pre-check (`yarn db:reset`, restart dev with the relevant env flags), and execute scenarios per [`02-test-plan.md`](02-test-plan.md).

## Per-scenario results

| Scenario | Slice | Coverage |
|---|---|---|
| RR-S1 — Dispatch refused on missing reviewer | 0 | **Structural ✅** — 16 unit tests in `dispatch/roster-gate.test.ts` cover required-roles derivation (default ladder, convoy subtask, workflow template, malformed template), available-agent rules (offline / disabled / cross-workspace / gateway-derivation), and `enforceRosterGate` end-to-end (off-by-flag no-op, block + status flip + activity row + mailbox ping). Live run: pending operator. |
| RR-S2 — Full roster passes | 0 | **Structural ✅** — covered by `validateWorkspaceRoster` happy-path test + `enforceRosterGate: passes when full roster available — task untouched`. Live run: pending operator. |
| RR-S3 — Self-review block + auto-pick | 1 | **Structural ✅** — 5 unit tests in `services.test.ts`: `reviewer_required` when no reviewer; auto-pick + `task_roles` write; `self_review_blocked` when only reviewer is the completer; respects pre-assigned reviewer; back-compat when flag off. Live run: pending operator. |
| RR-S4 — Subtask cannot reach review without `test_full` | 2 | **Structural ✅** — 5 unit tests in `task-governance.test.ts`: required `test_full` rejects without evidence; passing evidence enters review; failing evidence rejects; legacy NULL keeps bypass; malformed JSON falls back. Live run: pending operator. |
| **RR-S5 — Full incident replay** | 3 | **Structural ✅ (high confidence)** — 9 lock-semantics tests (`authz/soft-lock.test.ts`) + 5 e2e tests via the real MCP harness (`mcp.test.ts`): `spawn_subtask` denial sets lock + returns `next_action`; locked `register_deliverable` rejected with `task_locked_pending_escalation`; `escalate_to_parent` clears lock + bounces child + writes parent activity for both convoy and top-level cases; idempotency within 60s. Live run: pending operator. |
| RR-S6 — Stale review auto-bounces | 4 | **Structural ✅** — 5 unit tests in `stall-detection.test.ts`: 1× threshold writes `reviewer_stalled` (no autobounce when flag off); 2× + flag bounces to `assigned`/`is_failed=1`; 2× without flag does not bounce; below-threshold no-op; throttle window. Live run: pending operator. |

### Globals

- **GG-1** — preview console clean: N/A for structural pass; pending live run.
- **GG-2** — targeted suite green: ✅ (109/109 stack-tip targeted, 989/990 full repo).
- **GG-3** — no worker dispatched on a refused gate: ✅ via `enforceRosterGate: blocks…task_untouched` + the `agent_runs` absence assertion in the test plan.
- **GG-4** — pre-existing failures listed: ✅ (`schedule-runner.test.ts > "schedule-runner: produces a brief and advances run_count"`).
- **GG-5** — `audit:review-stalls` script exists and runnable: ✅ (`yarn audit:review-stalls`). Operator must run before flipping `MC_REVIEW_AUTOBOUNCE=1` per [`docs/REVIEW_STAGE_PROTOCOL.md`](../../docs/REVIEW_STAGE_PROTOCOL.md).

## Pre-existing test failures

| File | Test | Status |
|---|---|---|
| `src/lib/research/eval/schedule-runner.test.ts` | `schedule-runner: produces a brief and advances run_count` | Pre-existing on `main@483d5de`. Confirmed via `git stash; yarn test <file>; git stash pop`. Not in the blast radius of this stack. |

## Backfill audit (Slice 4)

`yarn audit:review-stalls` script lives at `scripts/audit-review-stalls.ts`. Output structure:
- Total review-status tasks (count)
- No reviewer assigned (list)
- No evidence rows (list)
- Over SLA threshold (list with `idle_minutes`)
- Both-missing call-out (highest-risk parking-lot rows)

Operator must run this against the dev DB before flipping `MC_REVIEW_AUTOBOUNCE=1` per [`docs/REVIEW_STAGE_PROTOCOL.md`](../../docs/REVIEW_STAGE_PROTOCOL.md). Result paste-into this file once executed.

## What the operator needs to do for full GREEN

1. Free port `:4010` (currently held by the Claude desktop app's network service, PID 52321 in this run — kill from the menu, not the CLI).
2. `yarn db:reset && yarn db:sync-agents`.
3. `yarn audit:review-stalls` — paste output into this doc.
4. Boot dev server with the relevant env flags per scenario in [`02-test-plan.md`](02-test-plan.md):
   - RR-S1/S2: `MC_ROSTER_GATE=1`
   - RR-S3: `MC_REVIEW_STRICT_GATING=1`
   - RR-S4: `MC_REVIEW_STRICT_GATING=1` (subtask path)
   - RR-S5: `MC_REVIEW_STRICT_GATING=1` (so locked-task mutations are rejected)
   - RR-S6: `MC_REVIEW_AUTOBOUNCE=1, STALL_DETECTION_MINUTES_REVIEW=1`
5. Execute scenarios via real openclaw dispatches (`spark-lb/agent` per `project_openclaw_model.md`).
6. Capture transcripts + DB rows under `/tmp/mc-validation/review-robust/<scenario_id>/`.
7. Score against [`03-validation-criteria.md`](03-validation-criteria.md). Flip the verdict to **GREEN** if all per-scenario gates pass.

## Open issues surfaced during the run

None. Every test passed first-time after harness fixes (workspace FK + agent role NOT NULL + convoy parent FK in test seed helpers — all caught + corrected before commit).

## Sign-off

Operator review: _pending_
Date: _pending_
