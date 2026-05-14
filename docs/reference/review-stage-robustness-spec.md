---
status: current
last-verified: 2026-05-14
audience: ai-subagents-primary, operator-secondary
code-anchors:
  - src/lib/authz/agent-task.ts
  - src/lib/mcp/groups/work.ts
  - src/lib/services/task-status.ts
  - src/lib/task-governance.ts
  - src/lib/stall-detection.ts
  - src/lib/agent-health.ts
  - src/lib/convoy.ts
  - src/lib/workflow-engine.ts
  - src/app/api/tasks/[id]/dispatch/route.ts
  - src/app/api/mcp/pm/route.ts
mcp-tools: [escalate_to_parent, spawn_subtask, update_task_status, register_deliverable, submit_evidence]
db-tables: [tasks, task_roles, task_evidence, convoy_subtasks, agent_runs]
related-specs:
  - autonomous-flow-tightening-spec.md — same anti-pattern (replace agent judgment with rails) being applied
  - ../docs/archive/coordinator-delegation-via-convoy-spec.md — defines spawn_subtask path being tightened
  - agent-health.md — heartbeat/stall infrastructure extended here
  - ../docs/archive/convoy-mode-spec.md — convoy-subtask gate behavior modified
  - pm-convoy-mandate.md — parent-task review→done AC gate (composes with the evidence gate below)
---

# Review-Stage Robustness

Status: draft
Owner: smb209
Date: 2026-05-09
Trigger: recurring stall pattern observed across multiple convoys, most recently task `92b7b092` ("Implement alert() replacements…"). The PM hit `agent_not_coordinator` trying to spawn a builder, silently re-roled, did the work itself, marked complete → review, and stalled there with no evidence rows and no reviewer assigned.

## Goal

Make the path from `assigned → review → done` self-policing. Today the `review` status is a parking lot: any agent can land a task there with zero evidence, no reviewer assigned, and the only signal that something is wrong is a "stalled" badge that paints but doesn't act. Close all three holes (capability-denial swallowing, toothless review stage, cosmetic stall detection) so a misbehaving or under-tooled agent can't strand work.

## Non-goals

- Adding new agent roles. Builder / Reviewer / Tester / PM stay as-is.
- Re-doing evidence gates. `submit_evidence` and `task_evidence` already exist; this spec wires them in tighter.
- Changing OpenClaw worker semantics. All changes are MC-side: state machine, MCP tool surface, stall handler, role docs.
- Rewriting authz. We extend the existing `assertAgentCanActOnTask` but don't restructure it.

## Core principle: capability denials are control-flow, not advisory

When a tool returns `agent_not_coordinator` (or any structured denial), the agent must not be free to "decide" to do the work itself. The system either:
1. Forces the bounce-back via a structured response the agent can't ignore (the only useful next-tool is `escalate_to_parent` / `fail_task`), or
2. Performs the rerouting itself (auto-reassign, auto-spawn under a coordinator-capable agent).

Today the error is text and the agent prompt picks the path. That's the same anti-pattern as "ask an agent a yes/no question about its own work" from `autonomous-flow-tightening-spec.md` — replace agent judgment with rails.

## Failure modes (from post-mortem of task 92b7b092)

| FM | One-line | Ground truth |
|----|----------|--------------|
| FM1 | `agent_not_coordinator` is swallowable text — agent silently switches role | [src/lib/authz/agent-task.ts:148-160](src/lib/authz/agent-task.ts:148), [src/lib/mcp/groups/work.ts:1047-1052](src/lib/mcp/groups/work.ts:1047) |
| FM2 | `transitionTaskStatus → review` accepts any caller; no reviewer is required or assigned | [src/lib/services/task-status.ts:74-208](src/lib/services/task-status.ts:74) |
| FM3 | Self-review allowed: completer == reviewer is permitted | (no check exists) |
| FM4 | Convoy-subtask path bypasses the strict evidence gate | [src/lib/task-governance.ts:113-115](src/lib/task-governance.ts:113) (`if (task?.convoy_id) return { ok: true }`) — exactly the case our incident hit |
| FM5 | `stalled_no_activity` is purely cosmetic for `review` — scanner sets `status_reason` but never bounces or escalates | [src/lib/stall-detection.ts:54-130](src/lib/stall-detection.ts:54) |
| FM6 | No SLA on time-in-review. A subtask in `review` with no reviewer can sit there indefinitely | (no timer exists) |
| FM7 | `task_roles` only knows `coordinator` / `builder` — no `reviewer` row, so the system can't pick one to assign | `sqlite> SELECT DISTINCT role FROM task_roles;` → `builder` only |
| FM8 | Dispatch fires even when the workspace can't field every role the task will need (no reviewer, no coordinator, no tester). The shortage is discovered mid-flight, by which time work is in progress and rollback is expensive | [src/app/api/tasks/[id]/dispatch/route.ts](src/app/api/tasks/[id]/dispatch/route.ts), [src/lib/convoy.ts](src/lib/convoy.ts) `dispatchReadyConvoySubtasks` |

## Design

### A. Capability denials become forced bounces (FM1)

`spawn_subtask` and friends already throw `AuthzError` with a typed `code`. Two changes:

1. **At the MCP transport layer** (`src/lib/mcp/groups/work.ts`), catch `AuthzError` for the coordinator-only family and rewrite the response so the `structuredContent.next_action` field names a single allowed continuation:

   ```jsonc
   {
     "isError": true,
     "structuredContent": {
       "error": "agent_not_coordinator",
       "next_action": "escalate_to_parent",
       "next_action_args_hint": { "reason": "<why I can't dispatch this myself>" },
       "blocked_tools": ["register_deliverable", "update_task_status"]
     }
   }
   ```

   Adding `blocked_tools` is advisory metadata (the rails in B/C below do the actual blocking).

2. **Add a server-side soft-lock**: when an agent receives a coordinator-only denial on task T, set `tasks.locked_for_completion = 1` for T. While the lock is set, `update_task_status` and `register_deliverable` from that agent return a hard error pointing at `escalate_to_parent`. The lock is cleared when the task is reassigned or the parent acknowledges the escalation.

   New column: `tasks.locked_for_completion INTEGER NOT NULL DEFAULT 0`. Migration is additive, defaults to off, no backfill needed.

3. **`escalate_to_parent` MCP tool** (new). Writes a parent-task activity with `activity_type='escalation'`, flips the parent's `status_reason` to `child_escalated:<reason>`, and bounces the child to `assigned` with `is_failed=1`. Ada (or whoever the parent's coordinator is) sees the escalation in the next inbox poll.

### B. Review stage requires a reviewer at transition time (FM2, FM7)

In `transitionTaskStatus`, when `newStatus === 'review'`:

1. Require either:
   - A `task_roles` row with `role='reviewer'` for this task, OR
   - An auto-pickable reviewer agent in the workspace (mirrors `ensureFixerExists`: pick by role, online, not the completer).
2. If neither exists, fail with `code='reviewer_required'` and a hint: "no reviewer agent available — operator must add one or call escalate_to_parent".
3. If auto-picked, write the `task_roles` row inline so subsequent transitions are deterministic.

### C. Self-review interlock (FM3)

When `newStatus === 'review'`:
- The transitioning agent (`actingAgentId`) cannot equal `tasks.assigned_agent_id` UNLESS a separate `task_roles[role='reviewer']` row exists with a different `agent_id`.
- This is enforced in `transitionTaskStatus` next to the existing evidence gate, returning `code='self_review_blocked'`.

This is the cheapest invariant in the whole spec and would have caught our incident even with FM1 unfixed.

### D. Convoy-subtask evidence gate (FM4)

The current bypass at `task-governance.ts:113-115` was added because subtasks don't carry the parent's `planning_spec`. The bypass is too broad — it skips even the baseline `deliverableCount > 0 && activityCount > 0` check.

Fix: convoy-subtasks still skip *spec reconciliation* (correct, they don't own the spec), but they pass through the strict-mode evidence gate (`STAGE_REQUIRED_EVIDENCE[review]: ['test_full']`) once the dispatcher prescribes commands. Subtasks get evidence requirements from `convoy_subtasks.acceptance_criteria` — extend the schema with an optional `required_evidence_gates: ['build_fast', 'test_full']` JSON field, default `['test_full']` for review-bound subtasks.

### E. Review SLA → action, not just badge (FM5, FM6)

Extend `scanStalledTasks` (and the per-stage timer in `agent-health.ts`) with:

- **Per-stage thresholds.** Today there's one `STALL_DETECTION_MINUTES`. Add `STALL_DETECTION_MINUTES_REVIEW` (default 20m) — review should be tighter than `in_progress` because the only legitimate work is reviewer evaluation.
- **Action, not paint.** When a `review` task crosses threshold:
  1. If a reviewer is assigned but inactive: log `reviewer_stalled`, send a mailbox ping, and after 2× threshold auto-bounce to `assigned` with `is_failed=1, status_reason='Failed: reviewer unresponsive'`.
  2. If no reviewer is assigned (only possible if A/B were bypassed by an older flow): bounce immediately and surface as `status='needs_user_input'`.
- **Convoy-aware escalation.** If the parent is `convoy_active` and a child stalls in `review`, ping the convoy coordinator (Ada in our case) — the existing `notifyCoordinator` path is the right hook.

### F. Role docs (FM1)

PM and builder soul-prompts get a one-paragraph addition: when you receive `agent_not_coordinator` (or any `next_action: escalate_to_parent`), your only valid next call is `escalate_to_parent`. Doing the work yourself is a protocol violation.

This is a belt-and-braces redundant rail — A.2's soft-lock makes it impossible at the system level — but worth keeping aligned.

### G. Parent-task `review → done` AC gate (PM convoy mandate, slice 5)

Layered on top of the evidence gate above. When the PM emits a
`create_convoy_under_initiative` diff (decompose-flow output — see
[pm-convoy-mandate.md](pm-convoy-mandate.md)), the resulting convoy
carries operator-facing parent acceptance criteria in
`convoys.acceptance_criteria` (JSON array; mig 095). The parent task
sits in `convoy_active` while slices run, gets auto-promoted to
`review` by `checkConvoyCompletion` once all subtasks are `done`, and
then must clear the AC gate before transitioning to `done`.

**Composition order in `transitionTaskStatus`:**

1. **Evidence gate first** — `STAGE_REQUIRED_EVIDENCE[review]` (today's
   rail). If evidence is missing, return the existing
   `evidence_required` error. No AC check runs.
2. **AC gate second** — if the parent has a convoy with
   `acceptance_criteria` populated and is being transitioned to
   `done`, the service looks up `task_ac_acknowledgements` (mig 096).
   Each AC must have an `acknowledged_at` row keyed by the operator
   before the transition is allowed; otherwise return
   `parent_ac_check_pending`.
3. **`board_override: true` bypasses both gates** — operator escape
   hatch, mirroring the existing evidence-gate bypass.

**UI:** the parent task's detail page surfaces an `AcAckModal` when
the task is in `review` and the convoy has uncherished ACs. The
endpoint `GET/POST /api/tasks/[id]/ac-ack` writes the ack rows
operator-by-operator. See
[`src/components/AcAckModal.tsx`](../../src/components/AcAckModal.tsx)
and the convoy-mandate spec for the wiring.

**Why it composes cleanly:** the evidence gate is per-slice; the AC
gate is per-feature. A parent that genuinely shipped will satisfy
both (each subtask has its `test_full` evidence + operator has
acked the parent ACs). A parent whose subtasks gamed evidence but
whose feature isn't really done will fail the AC gate, surfacing the
"locally green, globally wrong" failure mode the mandate was designed
to catch.

## Decisions (formerly open questions)

- **`escalate_to_parent` works for non-convoy tasks too.** Operator is the implicit parent for top-level tasks: tool flips the task to `needs_user_input` and writes a mailbox row to the workspace's default operator agent (or the activity feed if none). One code path, two equally valid parents — mirrors the existing `coordinator_missing` fallback in `stall-detection.ts:262-274`.
- **Soft-lock and `is_failed` are orthogonal.** Lock describes agent agency (you cannot advance this task; only `escalate_to_parent` is legal). Flag describes stage outcome (the work was rejected). Both can be set in one incident; lock clears on reassign/escalation-ack, flag clears on next forward transition. No precedence puzzle.
- **Soft-lock blocks all forward-only mutations on the locked task** for the locked agent: `update_task_status`, `register_deliverable`, `submit_evidence`. Read-only tools (`get_task`, `read_brief`) stay open so the agent can craft a clean escalation message. Rationale: a denied agent dropping deliverables creates exactly the artifact set that bypasses the legacy evidence gate.
- **Single-agent-workspace reviewer fallback is moot** once the pre-dispatch roster gate (Slice 0) lands — the task never reaches `assigned`. Slice 1's auto-pick stays as defense-in-depth, not the load-bearing rail.

## Implementation slices

Each slice is a stacked PR. All target `smb209/mission-control`, base on the prior slice.

### Slice 0 — Pre-dispatch workspace-roster gate

**Goal**: refuse to dispatch a task whose downstream stages need roles the workspace can't currently fill. Converts the recurring "mid-flight stall because no reviewer/no coordinator existed" failure into a one-time, operator-actionable error at dispatch time.

Files: `src/lib/dispatch/roster-gate.ts` (new), `src/app/api/tasks/[id]/dispatch/route.ts`, `src/lib/convoy.ts` (`dispatchReadyConvoySubtasks`), `src/lib/workflow-engine.ts` (`drainQueue`).

1. **`requiredRolesForTask(taskId): RoleName[]`** — derive the role set:
   - If the task has a `workflow_template_id`, walk its stages and collect every `required_role`.
   - If the task is a convoy subtask, return `[suggested_role, 'reviewer']` (review stage will need one).
   - If neither, default to `['builder', 'reviewer']` for the standard `assigned → in_progress → review → done` ladder.
   - For convoy parents (`status='convoy_active'`), union across all child rows.

2. **`validateWorkspaceRoster(workspaceId, requiredRoles): { ok: true } | { ok: false, missing: RoleName[] }`** — an "available" agent is `status != 'offline' AND disabled = 0` and has a matching `role` (or gateway-id-derived role per `resolveBriefingRole`).

3. **At every dispatch entry point** (HTTP route, convoy auto-dispatch, workflow drain), call the gate before any side effects. On failure:
   - Flip the task to `needs_user_input` with `status_reason='roster_incomplete: <missing>'`.
   - Log a `roster_incomplete` activity row carrying the missing roles in metadata.
   - Send a mailbox row to the operator (or workspace default agent) with the actionable text: "workspace `<id>` is missing role(s) X — onboard or enable an agent and call dispatch again".
   - Return a structured error to the caller; do **not** fire the OpenClaw worker.

4. **Feature flag**: `MC_ROSTER_GATE=1` (off for one cycle so we can backfill-audit existing workspaces, then default-on).

5. **Tests**: workspace with builder but no reviewer rejects at dispatch; workspace with offline reviewer rejects; workspace with full roster passes; convoy parent gate unions across children correctly.

This slice is upstream of everything else: it removes the precondition for most of the failure modes (FM2, FM7, partly FM1 where the missing role is `coordinator`).

### Slice 1 — Self-review interlock + reviewer-required gate

Files: `src/lib/services/task-status.ts`, `src/lib/services/services.test.ts`.
- Add `code: 'self_review_blocked' | 'reviewer_required'` to the result enum.
- Enforce both at the start of `newStatus === 'review'` branch.
- Add `task_roles` reviewer auto-pick helper next to `ensureFixerExists`.
- Tests: completer ≠ reviewer; missing reviewer rejects; auto-pick writes `task_roles`.

Smallest, lowest-risk change. Lands the highest-leverage invariant (C) and unblocks B.

### Slice 2 — Convoy-subtask evidence gate

Files: `src/lib/task-governance.ts`, `src/lib/db/schema.ts` (add `convoy_subtasks.required_evidence_gates`), `src/lib/convoy.ts` (read it on dispatch).
- Migration: additive, default `['test_full']`.
- Update the `if (task?.convoy_id) return { ok: true }` early-return: keep skipping spec reconciliation, but enforce strict-mode gates from `required_evidence_gates`.
- Tests: subtask without `test_full` evidence is rejected at `review`; legacy subtasks (no required_evidence_gates set) keep working.

### Slice 3 — Capability-denial soft-lock + escalate_to_parent

Files: `src/lib/authz/agent-task.ts`, `src/lib/mcp/groups/work.ts`, `src/lib/db/schema.ts` (`tasks.locked_for_completion`), `src/app/api/mcp/pm/route.ts`.
- Migration: additive column, default 0.
- New MCP tool `escalate_to_parent` (≈80 LOC).
- `spawn_subtask` and `delegate`-class denials set the lock + return `next_action`.
- `update_task_status` and `register_deliverable` honor the lock with `'task_locked_pending_escalation'`.
- Tests: PM hits `agent_not_coordinator`, lock gets set, `update_task_status` rejects, `escalate_to_parent` clears lock and bounces.

### Slice 4 — Review SLA + convoy-aware escalation

Files: `src/lib/stall-detection.ts`, `src/lib/agent-health.ts`, env schema.
- New `STALL_DETECTION_MINUTES_REVIEW` env (default 20).
- Auto-bounce logic + reviewer-stalled mailbox ping.
- Tests: stalled review → bounced; reviewer stalled → mailbox row written to coordinator.

### Slice 5 — Role-doc updates + ops doc

Files: `src/lib/agents/pm-soul.md`, `src/lib/agents/builder-soul.md` (create if missing), `docs/REVIEW_STAGE_PROTOCOL.md`.
- One paragraph each. Pure docs slice; no code change. Goes last so the soul-prompt references the now-existing tools.

## Verification

Per CLAUDE.md "Spec-First" workflow:

1. **Unit tests** at slice boundaries (above).
2. **MCP integration** (`yarn mcp:integration`) covering: agent_not_coordinator → soft-lock → escalate_to_parent.
3. **Real-agent dogfood**: re-run an alert-replacement-style task on the dev stack (`:4010`) — assigned PM, no builder available — and verify the system either auto-spawns under the orchestrator or bounces back instead of stalling. Capture the evidence in `docs/archive/review-stage-robustness-validation/`.
4. **Backfill check** before merging slice 4: count current tasks in `review` with no reviewer assigned and no `task_evidence`. They'll auto-bounce on first scan after deploy. List them in the PR description so the operator isn't surprised.

## Rollout

- Each slice ships with a feature flag where it could affect in-flight work:
  - Slice 1: `MC_REVIEW_STRICT_GATING=1` (off by default for one cycle, then default-on).
  - Slice 4: `MC_REVIEW_AUTOBOUNCE=1` (off by default; flip after operator reviews backfill list).
- Slices 2, 3, 5 are safe to land default-on.
- One-shot backfill script (`scripts/audit-review-stalls.ts`) prints in-flight `review` rows with no reviewer / no evidence so operator can clean up before flipping `MC_REVIEW_AUTOBOUNCE`.

## Open questions

- **Q1.** Should the roster gate (Slice 0) also re-check at the start of `convoy_active → review` transitions, or is dispatch-time enough? Lean: dispatch-time only. Re-checking on every transition risks blocking legitimate work if an agent goes offline mid-flow; that case is the SLA's job (Slice 4), not the gate's.
- **Q2.** Workflow templates with conditional stages (e.g. `testing` only fires if `task.has_tests`) — does `requiredRolesForTask` over-collect? Probably yes for the first cut. Acceptable: false-positive failures at dispatch ("you don't have a tester, even though this task may not need one") are operator-actionable, whereas false negatives recreate the original failure mode. Re-evaluate after a week of dogfood.

## References

- Recurring incident exemplars: task `92b7b092-a7b6-4542-ba41-b1bdb95860db` (this spec's trigger), prior PR #111 post-mortem in [autonomous-flow-tightening-spec.md](docs/reference/autonomous-flow-tightening-spec.md).
- Adjacent specs: [coordinator-delegation-via-convoy-spec.md](../docs/archive/coordinator-delegation-via-convoy-spec.md) (built `spawn_subtask`/`update_subtask`), [agent-health.md](docs/reference/agent-health.md) (heartbeat + stall infrastructure this builds on).
