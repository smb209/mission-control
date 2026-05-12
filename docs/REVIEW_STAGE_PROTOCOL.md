# Review-Stage Robustness — Operator Runbook

The Review-Stage Robustness feature stack closes the recurring failure pattern where:
- An agent hits a capability denial (`agent_not_coordinator`).
- It silently re-roles into "I'll do it myself".
- It marks the task `review` with no reviewer and no evidence.
- The task stalls indefinitely behind a cosmetic "stalled_no_activity" badge.

Spec: [docs/reference/review-stage-robustness-spec.md](../docs/reference/review-stage-robustness-spec.md)

This runbook covers the four feature flags, the audit script, and the recommended rollout sequence.

## Feature flags (env vars)

| Flag | Slice | Default | What it does |
|---|---|---|---|
| `MC_ROSTER_GATE` | 0 | off | Refuse to dispatch a task whose lifecycle needs roles the workspace can't fill (no reviewer, no coordinator, etc.). On block, task flips to `needs_user_input` and operator gets a mailbox row. |
| `MC_REVIEW_STRICT_GATING` | 1 | off | Enforce two new gates at `→ review`: `reviewer_required` (no reviewer agent ⇒ reject) and `self_review_blocked` (completer can't be reviewer). Auto-picks a reviewer when one exists and persists the assignment. |
| `STALL_DETECTION_MINUTES_REVIEW` | 4 | `20` | Per-stage threshold for review-status idle detection. Tighter than the 30m global default. |
| `MC_REVIEW_AUTOBOUNCE` | 4 | off | Auto-bounce review tasks idle past 2× threshold to `assigned`/`is_failed=1` with coordinator notify. |

## Always-on (no flags)

These behaviors land default-on once the slices merge:
- Convoy-subtask evidence gate (Slice 2): new spawns require `test_full` evidence to enter review. Legacy subtasks (NULL `required_evidence_gates`) keep the old bypass.
- Capability-denial soft-lock + `escalate_to_parent` MCP tool (Slice 3): when `spawn_subtask` denies a non-coordinator, the task is locked and the agent's only valid next call is `escalate_to_parent`. Coordinators bypass the lock.
- Reviewer-stalled notifications (Slice 4): even with `MC_REVIEW_AUTOBOUNCE` off, idle reviewers get a mailbox ping and a `reviewer_stalled` activity.

## Recommended rollout

1. **Day 0** — merge the stack. Soft-lock + `escalate_to_parent` go live immediately. Watch the activity feed for the first `escalation` row to confirm the path is wired.
2. **Day 1** — turn on `MC_ROSTER_GATE=1` after a quick `SELECT role, COUNT(*) FROM agents WHERE status != 'offline' GROUP BY role` shows every workspace has the roles it needs.
3. **Day 1** — turn on `MC_REVIEW_STRICT_GATING=1` once each workspace has a reviewer agent. New tasks transition cleanly; in-flight tasks already in `review` are unaffected (the gate only fires on the `→ review` transition).
4. **Day 2** — run the audit:
   ```sh
   yarn audit:review-stalls
   ```
   Lists every review-stage task that lacks a reviewer, lacks evidence, or is past the SLA. Address each row (assign reviewer, board_override, cancel) before the next step.
5. **Day 2** — turn on `MC_REVIEW_AUTOBOUNCE=1`. The next stall-scan run will bounce any remaining over-SLA reviews. Coordinator mailboxes get a heads-up.

## What "address each row" means in step 4

For each row from `yarn audit:review-stalls`:

- **No reviewer assigned** — onboard a reviewer, OR move the task back via `update_task_status` board_override, OR cancel.
- **No evidence rows** — almost always means the task entered review without strict gating. Decide: send back for tester run, or accept-and-move-on via board_override.
- **Over SLA** — same as no-reviewer: assign one, escalate, or board_override.

## Reading the rails

The rails surface in three places:

| Surface | What you'll see |
|---|---|
| `task_activities` | `roster_incomplete`, `escalation`, `reviewer_stalled`, `review_autobounced` |
| `tasks.status_reason` | `roster_incomplete: <missing>`, `child_escalated:<reason>`, `Failed: reviewer unresponsive (idle Xm)` |
| `tasks.locked_for_completion` | `1` while pending escalation |
| Mailbox | Operator: `Roster incomplete:` / `ESCALATION: <title> (top-level)`. Coordinator: `ESCALATION: <title>` / `REVIEW SLA: child auto-bounced` |

## Reverting

Each slice is independently reversible:
- Roster gate: unset `MC_ROSTER_GATE`. No DB cleanup required.
- Strict review gating: unset `MC_REVIEW_STRICT_GATING`. Existing `task_roles` reviewer rows stay (harmless).
- Convoy evidence gate: drop the `convoy_subtasks.required_evidence_gates` column or set NULL on the rows you want to revert.
- Soft-lock: `UPDATE tasks SET locked_for_completion = 0 WHERE locked_for_completion = 1` (releases stuck agents).
- Autobounce: unset `MC_REVIEW_AUTOBOUNCE`. The 1× threshold notification keeps firing for visibility.
