---
name: Review-Stage Robustness — Build Plan
description: Slice plan + design decisions for closing the review-stage stall pattern (roster gate, self-review interlock, soft-lock, SLA)
status: draft
spec: specs/review-stage-robustness-spec.md
---

# Review-Stage Robustness — Build Plan

Status: draft · Owner: smb209 · Date: 2026-05-09
Spec: [specs/review-stage-robustness-spec.md](review-stage-robustness-spec.md)

Companion to the spec. Commits to slices, files-touched, and load-bearing design calls. Per [specs/long-unattended-feature-dev.md](long-unattended-feature-dev.md): operator OKs build plan + validation skeleton; per-slice unit tests are the per-PR contract; full real-agent validation runs against the stack tip before merge.

## Audit (verified 2026-05-09)

- **`transitionTaskStatus`** — [src/lib/services/task-status.ts:74-208](src/lib/services/task-status.ts:74). Single chokepoint for all status moves (HTTP PATCH + MCP `update_task_status` + `update_subtask`). Returns a discriminated `{ ok, code }`. Already enforces evidence gate, terminal guard, fail-backwards reason, `taskCanBeDone`. Adding new gates here is the right shape.
- **`checkStageEvidence`** — [src/lib/task-governance.ts:50-140](src/lib/task-governance.ts:50). Strict path enforces `STAGE_REQUIRED_EVIDENCE` once any `task_evidence` row exists; legacy path falls back to `deliverableCount + activityCount`. Convoy-subtask early-return at line 113-115 (`if (task?.convoy_id) return { ok: true }`) is the load-bearing gap for FM4.
- **Authz** — [src/lib/authz/agent-task.ts:42-166](src/lib/authz/agent-task.ts:42). `AuthzError` already has typed `code`. `agent_not_coordinator` is thrown by `assertAgentCanActOnTask(..., 'delegate' | 'status')`. The MCP layer at [src/lib/mcp/groups/work.ts:1047-1052](src/lib/mcp/groups/work.ts:1047) calls `assertAgentCanActOnTask` directly and lets the error propagate as plain text.
- **Stall detection** — [src/lib/stall-detection.ts:54-130](src/lib/stall-detection.ts:54). One global threshold (`STALL_DETECTION_MINUTES`, default 30). Marks `status_reason = 'stalled_no_activity (...)'` and notifies coordinator/webhook. **Does not bounce or transition.** Has `coordinator_stalled` / `coordinator_missing` fallback paths we can reuse for review-SLA escalation.
- **Dispatch entry points** — [src/app/api/tasks/[id]/dispatch/route.ts](src/app/api/tasks/[id]/dispatch/route.ts) (HTTP), [src/lib/convoy.ts](src/lib/convoy.ts) `dispatchReadyConvoySubtasks`, [src/lib/workflow-engine.ts](src/lib/workflow-engine.ts) `drainQueue`. Three call sites; the gate (Slice 0) needs to slot in front of all three. Existing `pickDynamicAgent` + `resolveBriefingRole` give us role lookup primitives.
- **`task_roles`** — schema has `(task_id, role, agent_id)`. Today's prod data only carries `role='builder'`; `coordinator` and `reviewer` rows are never written even though `assertAgentCanActOnTask` reads `coordinator` rows.
- **`spawn_subtask`** — [src/lib/mcp/groups/work.ts:988-1230](src/lib/mcp/groups/work.ts:988). Already does the auth check first thing; clean place to intercept the `agent_not_coordinator` denial.
- **`tasks` schema** — additive columns are cheap; existing migrations (`is_failed` was added similarly in PR 2 of autonomous-flow-tightening). New `locked_for_completion` is a one-column migration.
- **`convoy_subtasks` schema** — has `acceptance_criteria` (JSON) and `expected_deliverables` (JSON) already. Adding `required_evidence_gates` JSON is parallel.
- **Agent role pool** — `getRunnerAgent`, `getPmAgent`, gateway-id-derived role via `resolveBriefingRole` give us the means to enumerate workspace agents by role.

## Design decisions

### D1. Required-roles derivation for the roster gate

**Choice:** rule-based, not configured.
- Convoy subtask: `[suggested_role, 'reviewer']`.
- Workflow-template task: union of `required_role` across stages, defaulting `reviewer` if any stage is `review`.
- Plain task: `['builder', 'reviewer']` (the standard ladder).
- Convoy parent: union of all child requirements.

**Why:** every task's lifecycle is already encoded in workflow_template or convoy structure; we don't need a new declaration surface. Reversible via a single function — swap the rules without schema changes.

### D2. "Available" agent definition

**Choice:** `disabled = 0 AND status != 'offline' AND role matches required role (via column or gateway-id derivation)`.

**Why over "ever-existed":** dispatch fires the worker right now; the gate has to reflect now. An offline reviewer is not a reviewer for this dispatch. False-positive failures ("you're missing X") are operator-actionable; false-negative passes recreate the stall pattern.

### D3. Soft-lock storage

**Choice:** new column `tasks.locked_for_completion INTEGER NOT NULL DEFAULT 0`.

**Why over a `task_locks` side table:** the lock is 1:1 with the task and read on every mutating MCP call; an indexed boolean column is simpler and faster than a join. Reversible — column is additive.

### D4. Self-review interlock placement

**Choice:** at the top of the `newStatus === 'review'` branch in `transitionTaskStatus`, before the evidence gate.

**Why:** earliest cheap rejection. Tests get a deterministic error code (`self_review_blocked`) regardless of evidence state.

### D5. Per-stage stall thresholds

**Choice:** introduce `STALL_DETECTION_MINUTES_REVIEW` (default 20m). Other stages keep the global default.

**Why:** review's only legitimate work is reviewer evaluation; 20m is generous for that. Other stages have wider variance (in-progress can legitimately be slow). Keeps the env surface minimal.

### D6. Auto-bounce mechanics for stalled review

**Choice:** at 1× threshold, log `reviewer_stalled` activity + mailbox-ping the reviewer. At 2× threshold, transition `review → assigned` with `is_failed=1, status_reason='Failed: reviewer unresponsive (idle Xm)'`. Convoy-aware: also notify the coordinator if the parent is `convoy_active`.

**Why two-stage:** matches the existing throttle/notify cadence in `stall-detection.ts`. One-shot bounce is too aggressive (real reviewers can be 25m late); never-bounce is the current bug.

### D7. `escalate_to_parent` shape

**Choice:** new MCP tool with args `{ task_id, agent_id, reason }`. Behavior:
- Walk parent chain: convoy parent if exists; else operator (top-level).
- Write `task_activities` row on parent: `activity_type='escalation'`.
- Set parent `status_reason='child_escalated:<reason>'`; if parent is operator (top-level), flip task to `needs_user_input` and write to operator mailbox.
- Bounce child: `review/assigned/in_progress → assigned, is_failed=1`. Clear `locked_for_completion` on child.
- Idempotent: a second call within 60s returns the same parent ack.

**Why:** matches existing fail-backwards semantics; `is_failed` already triggers fixer logic downstream. No new bounce primitive.

## Slice plan

Each slice = one stacked PR. Branch base for slice N = slice N-1's branch. Per [feedback_stacked_pr_merges.md](file:///Users/snappytwo/.claude/projects/-Users-snappytwo-snappytwo-sandbox-mission-control/memory/feedback_stacked_pr_merges.md): retarget children to `main` before merging the parent. All PRs target `smb209/mission-control` with explicit `--repo`.

### Slice 0 — Pre-dispatch workspace-roster gate

**Branch:** `feat/review-robust-0-roster-gate` (off `main`)

**Files:**
- `src/lib/dispatch/roster-gate.ts` (new) — `requiredRolesForTask(taskId)`, `validateWorkspaceRoster(workspaceId, requiredRoles)`, `enforceRosterGate(taskId)` orchestrator.
- `src/app/api/tasks/[id]/dispatch/route.ts` — invoke gate before any side effects.
- `src/lib/convoy.ts` — invoke gate inside `dispatchReadyConvoySubtasks` per child.
- `src/lib/workflow-engine.ts` — invoke gate inside `drainQueue`.
- `src/lib/mailbox.ts` — reuse for operator ping (no schema change).
- Tests: `src/lib/dispatch/roster-gate.test.ts` (new) — required-roles derivation; available-agent rules; gate pass/fail; mailbox row written on fail.

**Feature flag:** `MC_ROSTER_GATE` (default `0` for one cycle, then default-on after backfill).

**Testable after this slice:** dispatch refuses tasks in workspaces missing required roles; existing dispatches with full roster behave identically.

### Slice 1 — Self-review interlock + reviewer-required gate

**Branch:** `feat/review-robust-1-self-review` (off slice 0)

**Files:**
- `src/lib/services/task-status.ts` — extend result `code` enum (`self_review_blocked`, `reviewer_required`); enforce both at top of `→ review` branch.
- `src/lib/services/task-status.test.ts` — three new cases.
- `src/lib/task-governance.ts` — add `pickReviewerForTask(taskId, workspaceId, excludeAgentId)` mirroring `ensureFixerExists`. Writes `task_roles` row on auto-pick.
- `src/app/api/tasks/[id]/route.ts` + MCP tool error-mapping — surface new codes to callers (HTTP 422, MCP `structuredContent.error`).

**Feature flag:** `MC_REVIEW_STRICT_GATING` (default `0` for one cycle).

**Testable after this slice:** completer cannot transition own task to review; tasks lacking a reviewer either auto-pick or reject with actionable error.

### Slice 2 — Convoy-subtask evidence gate

**Branch:** `feat/review-robust-2-subtask-evidence` (off slice 1)

**Files:**
- `src/lib/db/migrations.ts` — add `convoy_subtasks.required_evidence_gates TEXT` (JSON array).
- `src/lib/convoy.ts` — write `required_evidence_gates: ['test_full']` (default for review-bound subtasks) into `spawnDelegationSubtask`. Read on dispatch.
- `src/lib/task-governance.ts` — replace the `if (task?.convoy_id) return { ok: true }` early-return with: skip *spec reconciliation* but enforce `STAGE_REQUIRED_EVIDENCE` plus per-subtask `required_evidence_gates` if set.
- `src/lib/task-governance.test.ts` — extend with subtask cases.

**No feature flag** — additive default; legacy subtasks (no required_evidence_gates set) keep current behavior.

**Testable after this slice:** convoy subtask cannot reach `review` without `test_full` evidence; legacy subtasks unaffected.

### Slice 3 — Capability-denial soft-lock + `escalate_to_parent`

**Branch:** `feat/review-robust-3-soft-lock` (off slice 2)

**Files:**
- `src/lib/db/migrations.ts` — `tasks.locked_for_completion INTEGER NOT NULL DEFAULT 0`.
- `src/lib/authz/agent-task.ts` — `lockTaskForCompletion(taskId, reason)` helper; honored by `assertAgentCanActOnTask` for actions in `('status', 'register_deliverable', 'submit_evidence')` — denies if locked.
- `src/lib/mcp/groups/work.ts` — `spawn_subtask` and other coordinator-only tools: catch `AuthzError(code='agent_not_coordinator')`, set lock, return `next_action: 'escalate_to_parent'` shape.
- `src/lib/mcp/groups/work.ts` — register `escalate_to_parent` tool.
- `src/lib/mcp/mcp.test.ts` — add tool to discovery test.
- `src/app/api/mcp/pm/route.ts` — register tool.
- Tests: capability-denial → lock set → register_deliverable rejected → escalate_to_parent clears lock and bounces.

**Testable after this slice:** the original incident (`92b7b092`) replays with a clean escalation instead of a stall.

### Slice 4 — Review SLA + auto-bounce

**Branch:** `feat/review-robust-4-review-sla` (off slice 3)

**Files:**
- `src/lib/stall-detection.ts` — per-stage threshold helper; review-specific bounce path.
- `src/lib/agent-health.ts` — feed bounced rows back into the activity stream.
- `src/lib/stall-detection.test.ts` — review stall + bounce + coordinator notify cases.
- `scripts/audit-review-stalls.ts` (new) — one-shot operator backfill: list `status='review'` rows with no reviewer / no evidence.
- `package.json` — script entry.

**Feature flag:** `MC_REVIEW_AUTOBOUNCE` (default `0`; flip after operator runs the audit script).

**Testable after this slice:** review tasks idle past threshold get bounced; coordinator pinged.

### Slice 5 — Role-doc + ops-doc updates

**Branch:** `feat/review-robust-5-docs` (off slice 4)

**Files:**
- `src/lib/agents/pm-soul.md` — add escalation paragraph.
- `src/lib/agents/builder-soul.md` (create if absent; otherwise extend).
- `docs/REVIEW_STAGE_PROTOCOL.md` (new) — operator-facing runbook for the four feature flags + audit script.

Pure docs slice; no code change.

## Test strategy summary

| Slice | Unit tests added | Validation scenarios that become exercisable |
|---|---|---|
| 0 | Required-roles derivation; available-agent matrix; gate pass/fail | RR-S1 (dispatch refused on missing reviewer), RR-S2 (full roster passes) |
| 1 | Self-review block; reviewer auto-pick; reviewer-required reject | RR-S3 (completer ≠ reviewer enforced) |
| 2 | Subtask evidence-gate strict path | RR-S4 (subtask cannot reach review without test_full) |
| 3 | Soft-lock; escalate_to_parent; tool blocks | RR-S5 (full incident replay — agent_not_coordinator → escalation, not stall) |
| 4 | Review-SLA bounce; per-stage threshold | RR-S6 (stale review auto-bounces; coordinator pinged) |
| 5 | none | Doc lint only |

Validation scenarios live in [review-stage-robustness-validation/02-test-plan.md](review-stage-robustness-validation/02-test-plan.md).

## Open questions for operator

1. **Default for `MC_ROSTER_GATE`** — ship Slice 0 default-off so the first dogfood pass shows the count of tasks that *would* have been refused, then flip default-on in a follow-up? Or default-on immediately given backup safety net? Current plan: default-off for one cycle.
2. **`escalate_to_parent` for top-level tasks** — confirmed in Decisions section to flip task to `needs_user_input` + mailbox-ping the operator. Alternative: also create a high-priority `task_notes` row visible in the UI rail. Going with mailbox + needs_user_input unless you say otherwise.
3. **Cleanup of in-flight stalls before flag-flips** — Slice 4's `scripts/audit-review-stalls.ts` lists candidates but does not auto-clean. If you want auto-cleanup behind a separate flag, name it now.

None of these block writing the validation skeleton; called out so they're not surprises.

## Out of scope

- New evidence gates beyond `build_fast` / `test_full` / `review_static`. Existing set is sufficient for review-stage correctness.
- New roles. Builder / Tester / Reviewer / PM / Coordinator stay as-is.
- Workflow-template UI changes. Roster gate reads existing templates; doesn't redesign them.
- Reviewer agent prompts. Extending the soul-prompt for reviewer behavior is a separate concern — this feature only ensures one *exists* and is *assigned*.
- Multi-workspace agent borrowing. If a workspace lacks a role, operator onboards locally; cross-workspace role resolution is a deferred design.

## Cost ceiling

Per [project_openclaw_model.md](file:///Users/snappytwo/.claude/projects/-Users-snappytwo-snappytwo-sandbox-mission-control/memory/project_openclaw_model.md): real-agent dispatches use `spark-lb/agent`, self-hosted, no budget concern. Validation run is ~6 scenarios × ~5 min each ≈ 30 min of agent time, plus one full incident replay (RR-S5) at ~10 min.

**HMR-runaway watchdog** (per [project_research_hmr_runaway.md](file:///Users/snappytwo/.claude/projects/-Users-snappytwo-snappytwo-sandbox-mission-control/memory/project_research_hmr_runaway.md)): pre-check 01 confirms no editing of dispatch code while validation runs. Restart cleanly between scenarios.

## Slice merge order

1. Each slice PR opens against the prior slice's branch (`--base feat/review-robust-N-…`).
2. Before merging slice 0, retarget slice 1's base to `main`. Repeat down the stack.
3. `--delete-branch` only after children are retargeted.
4. All PRs target the fork (`smb209/mission-control`), explicit `--repo`.
