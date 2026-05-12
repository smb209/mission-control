# 03 · Validation Criteria

Per-scenario gates (AND-ed within a scenario). Plus globals applied across the run. A milestone is GREEN only if all gates pass.

`FLAKE` policy: re-run 3×; passes if ≥ 2/3.

## Per-scenario gates

### RR-S1 — Dispatch refused on missing reviewer
- **G1.1** HTTP 422 returned.
- **G1.2** Response body has `code: 'roster_incomplete'` and `missing: ['reviewer']` (or superset).
- **G1.3** Task status flipped to `needs_user_input`.
- **G1.4** `task_activities` row with `activity_type='roster_incomplete'` exists.
- **G1.5** Operator mailbox row exists for this task.
- **G1.6** No `agent_runs` row created for this task.

### RR-S2 — Full roster passes
- **G2.1** HTTP 200.
- **G2.2** Task status `assigned`.
- **G2.3** `agent_runs` row exists (`status` in `queued|running`).
- **G2.4** No `roster_incomplete` activity row.

### RR-S3 — Self-review block + auto-pick
- **G3.1** First action succeeds (A ≠ B auto-pick path).
- **G3.2** `task_roles` row inserted with `role='reviewer'`, `agent_id != A.id`.
- **G3.3** Second action returns `code: 'self_review_blocked'`.
- **G3.4** Task remains in `in_progress` after rejection.

### RR-S4 — Subtask evidence gate
- **G4.1** First action returns `code: 'evidence_gate'` mentioning `test_full`.
- **G4.2** Task remains in `in_progress`.
- **G4.3** Second action (with evidence) succeeds; status transitions to `review`.

### RR-S5 — Full incident replay
- **G5.1** `spawn_subtask` returns `next_action: 'escalate_to_parent'` on denial.
- **G5.2** `tasks.locked_for_completion = 1` immediately after denial.
- **G5.3** `register_deliverable` while locked returns `error: 'task_locked_pending_escalation'`.
- **G5.4** `escalate_to_parent` returns success; parent activity `activity_type='escalation'` written; mailbox row to coordinator.
- **G5.5** Child bounces: `status='assigned'`, `is_failed=1`, `locked_for_completion=0`.
- **G5.6** No `register_deliverable` rows accepted between denial and escalation.

### RR-S6 — Review SLA auto-bounce
- **G6.1** First scan writes `reviewer_stalled` activity + reviewer mailbox row; task remains in `review`.
- **G6.2** Second scan transitions `review → assigned`, `is_failed=1`.
- **G6.3** `status_reason` matches `^Failed: reviewer unresponsive`.
- **G6.4** Coordinator mailbox row written.

## Global gates (apply across the run)

- **GG-1** No unhandled errors in `preview_console_logs` for the duration of any scenario.
- **GG-2** Targeted-suite (`yarn test` slice from pre-check 01 step 5) green.
- **GG-3** No worker dispatched on a refused gate (cross-cuts G1.6).
- **GG-4** Pre-existing failures (if any) are listed in `04-e2e-run-results.md` with file + reason — not silently skipped.
- **GG-5** Backfill audit (`scripts/audit-review-stalls.ts`) was run before flipping `MC_REVIEW_AUTOBOUNCE`; results pasted into `04`.

## Verdict mapping

- **GREEN** — all per-scenario gates AND all globals pass.
- **YELLOW** — a non-load-bearing gate fails (e.g. mailbox-row text mismatch but transition correct). Documented; ship-eligible with operator OK.
- **BLOCKED** — environmental failure (DB locked, port collision) blocks scenario execution. Re-run after fix.
- **RED** — a load-bearing gate fails (G1.1, G5.5, etc.). Stop, file the failure mode, fix, re-run.
