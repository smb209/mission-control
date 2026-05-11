# Phase J — Worker dispatch via openclaw `sessions_spawn`

> Addendum to [`scope-keyed-sessions.md`](scope-keyed-sessions.md). Phase
> I established per-workspace PMs with isolated memory pools (per-agent
> openclaw storage). Phase J leans into openclaw's parent/child model:
> **the workspace PM coordinates, subagents do the work.**

## Why

After Phase I, every workspace has its own PM agent
(`mc-pm-<slug>-(dev)?`) with its own memory pool. The current worker
dispatch path (`dispatchScope` from Phase B+C) opens a sibling session
on the PM agent for each worker:

```
agent:mc-pm-foia-dev:task-<id>:builder:1
agent:mc-pm-foia-dev:task-<id>:tester:1
agent:mc-pm-foia-dev:task-<id>:reviewer:1
```

That works, but it's fundamentally dispatching cold. Each worker session
starts with no context other than what MC injects in the briefing. The
PM agent — which has the workspace-scoped memory — isn't actually
*involved*; sessions are siblings, not children.

openclaw's native primitive is `sessions_spawn`: a parent agent calls
this MCP tool to fan out child agents that inherit the parent's MCP
tools, optionally inherit context, and auto-announce results back. This
matches the architectural claim "PM is the coordinator" much more
closely than the sibling-sessions pattern does.

## Goals

- Move worker dispatch (builder, tester, reviewer, researcher, writer,
  learner) from sibling sessions to subagent spawns from the workspace PM.
- Preserve memory isolation (Phase I): subagents share the parent PM's
  workspace-scoped memory pool. No cross-workspace leak surface.
- Make orchestration state durable: MC's `mc_sessions` table is the
  source of truth for "which subagent is running for which task." The
  PM's session memory is not load-bearing.
- Ship behind a feature flag so we can validate without breaking the
  existing dispatch path.

## Non-Goals

- Replacing PM dispatches (PM Chat, plan, decompose, notes-intake) —
  those stay on `dispatchScope`. They're operator → PM, not worker
  fan-out.
- Replacing the heartbeat coordinator (Phase E) — that's a recurring
  observation job, not a worker spawn.
- Eliminating the `dispatchScope` primitive — it remains for the PM-
  level dispatches above and as the J2 fallback when the flag is off.

## Architecture

```
Operator
  ↓ POST /api/tasks/<id>/dispatch
MC dispatch route
  ↓ dispatchSubagent({task_id, role, brief, attempt, context_mode})
  ↓ — builds the worker briefing (role-soul + identity + notetaker + task context)
  ↓ — sends a META message to the PM's per-task coord session
PM agent (workspace-scoped)
  ↓ receives META: "spawn a builder subagent. Brief: <…>. After spawn
  ↓                returns, call register_subagent_dispatch with run_id."
  ↓ openclaw `sessions_spawn`({task: <briefing>, mode: 'run', context: 'isolated'})
  ↓ openclaw fans out a child session on the same agent
Subagent (child of PM, inherits PM's MCP + memory pool)
  ↓ runs the work
  ↓ MCP: log_activity, take_note, register_deliverable, update_task_status
  ↓ exits
openclaw
  ↓ subagent_ended hook fires
  ↓ subagent's final reply auto-announces to PM as a chat message
PM agent
  ↓ observes outcome
  ↓ accepts / re-spawns with attempt+1 / escalates via take_note(audience='pm', importance=2)
```

## Locked design decisions

### D1 — Subagent context mode is per-call

`dispatchSubagent` takes `context_mode: 'isolated' | 'fork'`. Default
per role:

| Role | Default | Rationale |
|---|---|---|
| builder | isolated | clean retry, no PM chatter to drown out |
| tester | isolated | ditto |
| reviewer | isolated | ditto |
| researcher | isolated | self-contained brief; uses `read_notes` for context |
| writer | isolated | same |
| learner | isolated | same |
| (future) summarizer | fork | needs the parent's transcript as input |

Per-role default lives in `agent_role_overrides.subagent_context_mode`
(NULL = use the table above). Per-spawn override via the primitive.

### D2 — Subagent agent_id stays as parent PM's id

openclaw's default behavior: subagent inherits `targetAgentId` from
parent. For MC's tracking (which subagent did what), we use
`mc_sessions.run_id` + `scope_key` (the `childSessionKey`), NOT
`agent_id`. The audit trail at the agent level shows "PM" for every
subagent action — acceptable cost to avoid expanding named agents.

Improving per-subagent audit detail is a follow-up (a separate
`agent_subagent_runs` table or denormalized audit columns); not
in scope for J1/J2.

### D3 — `register_subagent_dispatch` MCP tool

New tool the PM calls right after `sessions_spawn` returns. Writes a
`mc_sessions` row with:

```typescript
{
  scope_key: <childSessionKey>,        // returned by sessions_spawn
  workspace_id: <workspace>,
  role: 'builder' | 'tester' | …,
  scope_type: 'task_role' | 'recurring',
  task_id?: string,
  initiative_id?: string,
  recurring_job_id?: string,
  attempt: number,
  status: 'active',
  run_id: <openclaw runId>,            // NEW in migration 072
}
```

Without this row, MC can't attribute subagent activity (notes,
deliverables, status changes) to the right (task, role, attempt) tuple.
The PM's coord briefing in J2 explicitly instructs it to call this tool
right after every `sessions_spawn`.

### D4 — PM coordinates from a per-task `:coord-task-<id>` session

```
agent:mc-pm-foia-dev:coord-task-<task_id>
```

One coord session per task, persists across stages. Compaction pressure
stays low (bounded scope). When a stage finishes, MC dispatches a "stage
complete" meta-message to the same coord session, retaining the PM's
short-term memory of the task's progression.

The PM Chat session (`agent:mc-pm-foia-dev:pm-chat-<thread>`) stays
separate. Same agent, separate sessions.

### D5 — Compaction-resilient orchestration state

PM session compaction or restart should NOT lose orchestration. MC's
`mc_sessions` is the durable record. When a coord session dispatches
cold (or after compaction), the briefing builder injects an
**active-session manifest** into the task-context block:

```
**Active subagents for this task:**
- builder (run abc12345, started 2h ago, last activity 3min ago) — scope_key=…
- tester (queued, run not yet started)

You may receive announcements from these subagents at any time. Look up
their current state via `read_notes(task_id=…)` and `mc_sessions` if you
need details.
```

The PM never has to remember what's running. It looks up MC's truth.

### D6 — Failure detection via openclaw runtime hook

`subagent_ended` is a runtime hook openclaw fires when a subagent's run
completes (success, error, or timeout). MC subscribes to this via the
gateway client (or polls `mc_sessions` rows that have `last_used_at`
older than `runTimeoutSeconds + buffer` and `status='active'` — a
liveness check). The PM also gets the auto-announcement as a chat message.

Either path (hook OR announcement) triggers PM to decide retry vs accept.
Not relying on the PM agent to "decide" the subagent has ended — the
runtime tells everyone.

### Handling PM crashes mid-orchestration

The subagent keeps running after a PM session restart. Since the
subagent calls MCP directly to record results (deliverables, status
changes, notes), MC's view stays consistent regardless of whether the
PM's session memory survives. Worst case: an orphaned announcement
that no PM ever reads. Acceptable — the work landed, MC knows.

### Heartbeat coordinator stays on `dispatchScope`

Phase E's heartbeat coordinator is a recurring observation job, not a
worker fan-out. It uses `dispatchScope` to its `:heartbeat` session.
Phase J doesn't change this.

## Phase split

### J1 — Primitives + schema (this PR)

**No behavior change.** Library code waiting for J2 to wire up.

- Migration 072: `mc_sessions.run_id TEXT NULL`
- Migration 073: `agent_role_overrides.subagent_context_mode TEXT CHECK ('isolated','fork')`
- `mc_sessions.ts`: read/write `run_id`; per-role context-mode lookup helper
- `register_subagent_dispatch` MCP tool — registers a subagent dispatch in `mc_sessions`
- `dispatchSubagent` primitive — builds the worker briefing + meta-message format the PM will receive in J2
- Tests for all of the above

### J2 — Wiring + flag (next PR, stacked)

- Active-session manifest in `buildBriefing` task context block
- PM coord briefing template — instructs PM how to call `sessions_spawn`
  + `register_subagent_dispatch`
- `dispatch/route.ts`: when `MC_USE_SUBAGENT_SPAWN=1`, route worker
  dispatches via `dispatchSubagent` instead of the existing scope-keyed
  path. Default off.
- Integration test: mock openclaw client, assert the PM receives the
  meta-message with the right briefing, asserts `mc_sessions` row lands
  after register_subagent_dispatch is called.
- Real-agent smoke: deferred (still blocked on openclaw MCP server
  activation gap from the Phase F e2e report).

### Phase K (later, separate)

Flip `MC_USE_SUBAGENT_SPAWN` default to on; remove the legacy worker
scope-keyed branch from `dispatch/route.ts`. Same shape as the Phase F
flag-removal cleanup.

## Validation pack additions

The validation pack at `docs/archive/scope-keyed-sessions-validation/` already
covers worker dispatch in §5. Phase J extends:

- §5 worker scenarios get a `MC_USE_SUBAGENT_SPAWN=1` variant.
- New §11 — subagent lifecycle: spawn → MC observes via `register_subagent_dispatch` → subagent works → `subagent_ended` lands → MC's `mc_sessions.status` flips to `closed` or `failed`.
- New global gate: every worker dispatch produces exactly one `mc_sessions` row with `run_id NOT NULL`.

## Status

- [ ] J1: schema, MCP tool, primitive (this PR)
- [ ] J2: PM briefing wiring + integration test (next PR)
- [ ] Phase K: flip `MC_USE_SUBAGENT_SPAWN` default to on; remove legacy branch
- [ ] Real-agent integration smoke once openclaw MCP activation lands
