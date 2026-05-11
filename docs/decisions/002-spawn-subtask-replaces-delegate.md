---
adr-number: 2
status: accepted
date: 2026-05-11
deciders: smb209
related-specs:
  - docs/reference/task-delegation-and-convoys.md — canonical convoy + spawn_subtask reference
related-adrs: []
code-anchors:
  - src/lib/mcp/groups/work.ts:1146
  - src/lib/db/migrations.ts:2110
  - src/lib/mcp/mcp.test.ts:90
---

# ADR-002: `spawn_subtask` replaces `delegate`; multiple convoys per parent

## Context

The original delegation surface (`delegate`) tried to support
AI-decomposition: an agent on a task could ask the system to break it
down and farm out subtasks autonomously. In practice this path was
fragile — agents produced uneven decompositions, mis-scoped subtasks,
and didn't reliably converge.

Separately, the `convoys` table had `UNIQUE(parent_task_id)`, locking
each parent to at most one convoy lifetime. That constraint blocked
re-decomposition flows (a coordinator re-attempting after an
escalation) and parallel convoys for genuinely independent slices.

See `docs/reference/task-delegation-and-convoys.md` §"Convoy lifecycle" and
§"Appendix A" for the full rationale.

## Decision

We removed the `delegate` MCP tool entirely and replaced it with
`spawn_subtask`, an explicit per-subtask coordinator call. AI auto-
decomposition is gone; the operator or a coordinator agent issues
discrete `spawn_subtask` calls with a scoped brief. Concurrently, we
dropped the `UNIQUE` on `convoys.parent_task_id` and added a partial
index on `(parent_task_id, status)` so multiple convoys per parent are
permitted while active-convoy lookups stay fast.

## Consequences

- Positive: decomposition decisions are auditable (each
  `spawn_subtask` call is a discrete event with its own brief).
- Positive: coordinators can re-decompose after a failed slice without
  schema gymnastics.
- Negative: convoy queries that previously assumed "one convoy per
  parent" must filter by status; we paid that migration cost once
  (migration around line 2110).
- Things to watch: if AI-decomposition gets revisited, it should be a
  new tool layered on top of `spawn_subtask`, not a revival of the
  old surface.

## Code anchors

1. `src/lib/mcp/groups/work.ts:1146` — `spawn_subtask` tool definition.
2. `src/lib/db/migrations.ts:2110` — UNIQUE-drop migration; partial
   index added at line 2164.
3. `src/lib/mcp/mcp.test.ts:90` — regression test asserts `delegate`
   is no longer registered.
