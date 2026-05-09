# 02 · Test Plan

Six concrete scenarios. Each lands a different slice's failure-mode coverage. All real-agent dispatches use `spark-lb/agent`. Captures at `/tmp/mc-validation/review-robust/<scenario_id>/`.

Time budget: ~5 min real-agent time per scenario. RR-S5 (full incident replay) is ~10 min.

---

## RR-S1 · Dispatch refused on missing reviewer (Slice 0)

**Setup**
- Workspace `rr-s1-test` (fresh) seeded with one builder + one PM. **No reviewer.**
- `MC_ROSTER_GATE=1`.
- Plain task created via API, status `inbox`.

**Action**
- `POST /api/tasks/<id>/dispatch`.

**Observation**
- HTTP 422 with structured error containing `code: 'roster_incomplete'`, `missing: ['reviewer']`.
- Task status flips to `needs_user_input`, `status_reason='roster_incomplete: reviewer'`.
- `task_activities` row `activity_type='roster_incomplete'`, metadata includes `missing`.
- Mailbox row written to operator (or workspace default agent).
- **No** OpenClaw worker dispatched (check `agent_runs` table).

**Capture:** dispatch request/response, task row, activity row, mailbox row.

---

## RR-S2 · Full roster passes (Slice 0 regression)

**Setup**
- Workspace with builder + reviewer + PM all online.
- `MC_ROSTER_GATE=1`.
- Plain task created.

**Action**
- `POST /api/tasks/<id>/dispatch`.

**Observation**
- HTTP 200; task transitions to `assigned`.
- OpenClaw worker dispatched (check `agent_runs` row created).
- No `roster_incomplete` activity.

**Capture:** dispatch response, agent_runs row.

---

## RR-S3 · Self-review block + reviewer auto-pick (Slice 1)

**Setup**
- Task assigned to builder agent A, in `in_progress`.
- `MC_REVIEW_STRICT_GATING=1`.
- Reviewer agent B online in same workspace.

**Action**
- Builder A submits `test_full` evidence and calls `update_task_status({status:'review'})`.

**Observation**
- Transition succeeds (A ≠ B; auto-picked B as reviewer).
- `task_roles` row written: `(task_id, 'reviewer', B.id)`.

**Action 2**
- Workspace reduced to A only (B disabled). New task assigned to A. A submits evidence and calls `update_task_status({status:'review'})`.

**Observation 2**
- Transition rejected with `code: 'self_review_blocked'` (no other agent to auto-pick → falls through to self-review check).

**Capture:** both transition responses, `task_roles` row.

---

## RR-S4 · Subtask cannot reach review without `test_full` (Slice 2)

**Setup**
- Convoy parent + one subtask spawned via `spawn_subtask`. Subtask carries `required_evidence_gates: ['test_full']`.
- `MC_REVIEW_STRICT_GATING=1`.

**Action**
- Subtask agent registers deliverables but does **not** submit `test_full`. Calls `update_task_status({status:'review'})`.

**Observation**
- Transition rejected with `code: 'evidence_gate'`, message naming `test_full`.
- Task remains in `in_progress`.

**Action 2**
- Submit `test_full` (passing). Re-call `update_task_status`.

**Observation 2**
- Transition succeeds.

**Capture:** rejection response, evidence rows.

---

## RR-S5 · Full incident replay — `agent_not_coordinator` → escalation, not stall (Slice 3)

This is the headline scenario: the original task `92b7b092` failure mode, replayed against the patched stack.

**Setup**
- Convoy parent assigned to coordinator C; subtask assigned to PM agent P (not a coordinator on this task).
- `MC_REVIEW_STRICT_GATING=1` (just for the lock to be honored against subsequent mutations).

**Action**
- P calls `spawn_subtask` to delegate to a builder.

**Observation**
- Tool returns `isError: true, structuredContent: { error: 'agent_not_coordinator', next_action: 'escalate_to_parent' }`.
- `tasks.locked_for_completion = 1` for P's task.
- P attempts `register_deliverable` → rejected with `error: 'task_locked_pending_escalation'`.
- P calls `escalate_to_parent({ task_id, reason: 'I cannot delegate; redecompose' })`.
- Parent gets activity row `activity_type='escalation'`, mailbox row to coordinator C.
- Child bounces to `assigned`, `is_failed = 1`, `locked_for_completion = 0`.

**Capture:** full transcript of P's MCP calls; parent + child task rows before/after.

**Time budget:** 10 min (longer than other scenarios because of the multi-step interaction).

---

## RR-S6 · Stale review auto-bounces; coordinator pinged (Slice 4)

**Setup**
- Task `T` in `review`, reviewer `R` assigned, parent `P` `convoy_active` with coordinator `C`.
- `MC_REVIEW_AUTOBOUNCE=1`, `STALL_DETECTION_MINUTES_REVIEW=1` (1 min for test acceleration).
- Backdate `T.updated_at` and last activity to 3 minutes ago.

**Action**
- Run `POST /api/tasks/scan-stalls` (or wait for scheduled run).

**Observation**
- First scan (≥ 1× threshold): `task_activities` row `reviewer_stalled`; mailbox row to `R`.
- Second scan (≥ 2× threshold): `T` transitions `review → assigned`, `is_failed = 1`, `status_reason='Failed: reviewer unresponsive (idle 3m)'`. Coordinator `C` mailbox-pinged.

**Capture:** scan response payloads, both activity rows, mailbox rows, task transitions.

---

## Globals (apply to every scenario)

- No unhandled SSE errors during the run (`preview_console_logs` clean).
- No worker dispatched on a refused gate (any `agent_runs` row appearing on a refused task is a global fail).
- Pre-existing test failures listed in `04-e2e-run-results.md`, not silently ignored.
- Each scenario writes its capture dir before passing to the next.
