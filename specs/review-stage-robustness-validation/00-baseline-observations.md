# 00 · Baseline Observations

Read-only snapshot captured 2026-05-09, before any feature slice lands. Used as the diff target for post-slice runs.

## Repo state
- Branch: `main` at `483d5de Replace window.alert with app dialogs/toasts`.
- Working tree clean apart from this feature's spec/build-plan/validation skeleton.

## Recurring incident — example task
- `tasks.id = 92b7b092-a7b6-4542-ba41-b1bdb95860db` ("Implement alert() replacements…").
  - `status = review`, `assigned_agent_id = 8e52f6688339f2eb7a5330f4cce875f9` (MC PM).
  - `task_evidence` rows: **0**.
  - `task_roles` rows: **0** (no reviewer assigned).
  - Activity trail: `agent_not_coordinator` denial → "I'll do it myself" → 4× `register_deliverable` → `update_task_status → review` → stalled.
  - Parent `be51f229-…` `convoy_active`, `status_reason='stalled_no_activity (idle 62m)'`.

## DB-level invariants today
- `SELECT DISTINCT role FROM task_roles;` → `builder` only. No `coordinator` or `reviewer` rows in dev DB.
- `tasks.locked_for_completion` column does not exist.
- `convoy_subtasks.required_evidence_gates` column does not exist.
- `STAGE_REQUIRED_EVIDENCE` map ([src/lib/task-governance.ts:43-48](../../src/lib/task-governance.ts:43)): `testing → ['build_fast']`, `review → ['test_full']`, others empty. Convoy-subtask early-return at line 113-115 bypasses this entirely for subtasks.
- Stall detection: single global `STALL_DETECTION_MINUTES` (default 30). No review-specific threshold. Scanner sets `status_reason` but never transitions.

## Reviewer-stranded review tasks (pre-feature snapshot)

```sql
SELECT id, title, datetime(updated_at)
FROM tasks
WHERE status = 'review'
  AND id NOT IN (SELECT task_id FROM task_roles WHERE role = 'reviewer')
  AND id NOT IN (SELECT task_id FROM task_evidence)
ORDER BY updated_at DESC LIMIT 10;
```

To be re-run as part of pre-check 01 each iteration; counts inserted into 04 results doc.

## MCP tool surface (pre-feature)
- `spawn_subtask` exists. `escalate_to_parent` does **not**.
- `update_task_status`, `register_deliverable`, `submit_evidence` honor authz but no soft-lock concept.
