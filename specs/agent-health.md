---
status: current
last-verified: 2026-05-11
audience: ai-subagents-primary, operator-secondary
code-anchors:
  - src/lib/agent-health.ts
  - src/lib/stall-detection.ts
  - src/lib/autopilot/stall-detection.ts
  - src/app/api/events/stream/route.ts:40-48
  - src/app/api/agents/health/route.ts
  - src/app/api/agents/[id]/health/route.ts
  - src/app/api/agents/[id]/health/nudge/route.ts
  - src/lib/health.ts:184
db-tables: [agent_health, task_activities, openclaw_sessions, agents, tasks]
migrations:
  - "015 agent_health table + indexes — migrations.ts:705-718, 815-816"
related-specs:
  - convoy-mode-spec.md — original health-state proposal, partly shipped
  - autonomous-flow-tightening-spec.md — stall thresholds + auto-bounce
---

# Agent Health

**Scope:** `src/lib/agent-health.ts` plus the two stall scanners it piggybacks on (`src/lib/stall-detection.ts`, `src/lib/autopilot/stall-detection.ts`).

## Overview

The agent-health subsystem classifies every agent with an active task into one of six health states (`working`, `stalled`, `stuck`, `zombie`, `idle`, `offline`), persists the verdict to the `agent_health` table, and auto-nudges agents that get stuck. It runs every 120 s, driven by an interval inside the SSE stream route (`src/app/api/events/stream/route.ts:40-48`). The same cycle also sweeps orphaned `assigned` tasks for auto-dispatch and invokes two stall scanners (task-level and autopilot-cycle) so callers don't have to schedule them separately.

It is intentionally timestamp-based and stateless — there is no session-liveness RPC against the OpenClaw gateway, no task-scoped auth token, and no artifact-detection / auto-complete path. Those were proposed in the original spec (see appendix) and were not built.

## State model

Per-agent classification lives in `checkAgentHealth(agentId)` (`src/lib/agent-health.ts:24-70`):

| State | Trigger |
|-------|---------|
| `offline` | Agent row missing, or `agents.status = 'offline'` (`agent-health.ts:26-27`). |
| `idle` | Agent has no active task in `{assigned, in_progress, testing, verification}` (`agent-health.ts:30-35`). |
| `zombie` | Agent has an active task but no `openclaw_sessions` row with `status='active'` for that agent (`agent-health.ts:38-50`). |
| `stuck` | Most recent non-health-check `task_activities` row is older than `STUCK_THRESHOLD_MINUTES` = 15 (`agent-health.ts:18,58-66`). |
| `stalled` | Most recent non-health-check `task_activities` row is older than `STALL_THRESHOLD_MINUTES` = 5 (`agent-health.ts:17,58-66`). |
| `working` | Default when an active task exists and a recent activity row is present (`agent-health.ts:69`). |

Self-defeating-log bug is avoided in SQL rather than via an `is_system` column: the query at `agent-health.ts:53-56` filters with `message NOT LIKE 'Agent health:%'`, so health-check log rows do not reset the timer.

### Cycle behavior

`runHealthCheckCycle()` (`src/lib/agent-health.ts:75-240`):

1. Builds the agent set from tasks in active statuses plus agents with `status='working'` (`agent-health.ts:76-85`).
2. Calls `checkAgentHealth` per agent, upserts `agent_health` with the new state and an incremented `consecutive_stall_checks` counter (reset to 0 when state is not stalled/stuck) (`agent-health.ts:107-123`).
3. Broadcasts an `agent_health_changed` SSE event on transition (`agent-health.ts:126-131`).
4. Writes an `Agent health: <state>` row to `task_activities` for stalled/stuck/zombie (`agent-health.ts:134-140`). These rows are filtered back out by the LIKE clause in step 2 of the next cycle.
5. Writes a throttled `heartbeat` row (`logTaskActivityThrottled`, 300 s) for `working` agents so the stall scanner sees proof of life (`agent-health.ts:147-157`).
6. Fires `nudgeAgent(agentId)` (fire-and-forget) when `consecutive_stall_checks >= AUTO_NUDGE_AFTER_STALLS` = 3 AND state is `stuck` (`agent-health.ts:19,163-168`).
7. Sweeps `status='assigned' AND planning_complete=1` tasks idle >2 min and calls `internalDispatch` to recover them (`agent-health.ts:173-200`).
8. Marks standby agents with no active task as `idle` (`agent-health.ts:203-216`).
9. Invokes `scanStalledTasks()` and `scanStalledCycles()`; failures are caught and logged so they cannot break the per-agent cycle (`agent-health.ts:223-237`).

### Nudge behavior

`nudgeAgent(agentId)` (`src/lib/agent-health.ts:245-350`):

1. Looks up the active task.
2. Checks the workflow stage's expected role; if the assigned agent doesn't match the role for the current stage, ends the wrong agent's session, logs the mismatch, and routes through `handleStageTransition` instead of re-dispatching (`agent-health.ts:262-303`).
3. Otherwise: ends the active OpenClaw session, appends checkpoint context (via `buildCheckpointContext`) to the task description, resets task status to `assigned`, and calls `internalDispatch` (`agent-health.ts:309-344`).
4. On success, resets `consecutive_stall_checks` to 0 and sets `health_state='working'` (`agent-health.ts:345-348`).

No max-attempts gate is enforced; consecutive failures will re-trigger after another three stall cycles (~6+ min).

## Schema

`agent_health` table (migration 015, `src/lib/db/migrations.ts:705-718`):

```
id                        TEXT PRIMARY KEY
agent_id                  TEXT NOT NULL → agents(id) ON DELETE CASCADE
task_id                   TEXT → tasks(id)
health_state              TEXT  CHECK in (idle, working, stalled, stuck, zombie, offline) — default 'idle'
last_activity_at          TEXT
last_checkpoint_at        TEXT
progress_score            REAL DEFAULT 0
consecutive_stall_checks  INTEGER DEFAULT 0
metadata                  TEXT
updated_at                TEXT DEFAULT (datetime('now'))
```

Indexes: `idx_agent_health_agent (agent_id)`, `idx_agent_health_state (health_state)` (`src/lib/db/migrations.ts:815-816`).

Note: `last_checkpoint_at`, `progress_score`, and `metadata` are declared but not written by `agent-health.ts`. Treat them as reserved.

## Integration points / callers

- `src/app/api/events/stream/route.ts:40-48` — invokes `runHealthCheckCycle()` every 120 s on each SSE connection.
- `src/app/api/agents/health/route.ts:9` — `GET` returns `getAllAgentHealth()`; `POST` (`:19`) triggers `runHealthCheckCycle()` on demand.
- `src/app/api/agents/[id]/health/route.ts:15,18` — returns persisted health row, or computes fresh state via `checkAgentHealth` if no row exists.
- `src/app/api/agents/[id]/health/nudge/route.ts:14` — manual nudge endpoint, calls `nudgeAgent`.
- `src/lib/health.ts:184` — system-health summary endpoint reads `getAllAgentHealth()` to roll up `by_state` counts.
- `src/lib/stall-detection.ts:70` (`scanStalledTasks`) and `src/lib/autopilot/stall-detection.ts` (`scanStalledCycles`) — invoked from inside `runHealthCheckCycle` (`agent-health.ts:224,234`).

## Stall scanner (task-level)

Companion to the per-agent health check; lives at task granularity in `src/lib/stall-detection.ts`.

- Default threshold: 30 min, override via `STALL_DETECTION_MINUTES` (`stall-detection.ts:16,52-57`).
- Review-stage threshold: 20 min, override via `STALL_DETECTION_MINUTES_REVIEW` (`stall-detection.ts:21,23-28`).
- Review auto-bounce gate: `MC_REVIEW_AUTOBOUNCE=1` enables `review → assigned, is_failed=1` at 2× the review threshold (`stall-detection.ts:30-32,281-329`).
- Coordinator considered stalled at: 10 min (`COORDINATOR_STALL_MINUTES`, `stall-detection.ts:35`).
- Re-notification throttle: 60 min per task (`NOTIFY_THROTTLE_MINUTES`, `stall-detection.ts:38`).
- Notify path: convoy coordinator via `sendMail`, else webhook `MC_STALL_WEBHOOK_URL` (`stall-detection.ts:383-490`).
- `clearStallFlag(taskId)` (`stall-detection.ts:497-520`) is called by dispatch / reassign paths to clear `status_reason='stalled_*'`.

## Configuration

| Var | Default | Used in |
|-----|---------|---------|
| `STALL_DETECTION_MINUTES` | 30 | `src/lib/stall-detection.ts:52-57` |
| `STALL_DETECTION_MINUTES_REVIEW` | 20 | `src/lib/stall-detection.ts:23-28` |
| `MC_REVIEW_AUTOBOUNCE` | unset | `src/lib/stall-detection.ts:30-32` |
| `MC_STALL_WEBHOOK_URL` | unset | `src/lib/stall-detection.ts:466` |

The agent-health thresholds (5 min stall, 15 min stuck, 3 stall-checks before auto-nudge, 300 s heartbeat throttle) are hard-coded constants in `src/lib/agent-health.ts:15-19`. There is no env override.

## Known gaps / open questions

- **No session-liveness verification against the gateway.** `zombie` is inferred purely from the local `openclaw_sessions` table. If MC's row says `active` but the gateway has already terminated the session, MC won't notice until the task crosses the 15-min activity threshold.
- **No nudge attempt cap.** Repeated nudges can fire forever; the original spec proposed `MAX_RECOVERY_ATTEMPTS=3` but that was not built.
- **Schema reserves unused fields.** `last_checkpoint_at`, `progress_score`, and `metadata` exist on `agent_health` but no code writes them. Open question: drop them or wire them up.
- **String-LIKE filter for system rows.** Filtering health-check entries via `message NOT LIKE 'Agent health:%'` (`agent-health.ts:54`) is fragile to message-format changes. An `is_system` column (proposed but not built) would be sturdier.
- **120 s cadence is tied to SSE connections.** The interval lives inside `src/app/api/events/stream/route.ts:40-48`. Open question: behavior when zero SSE clients are connected — does the cycle still run.

## Appendix: original proposal not implemented

The pre-rewrite version of this doc (titled "Agent Health System Overhaul") proposed a much larger build. The following items from that spec were **not** shipped and are not present in the codebase:

- **Schema additions to `agent_health`**: `last_real_activity_at`, `recovery_attempts`, `last_recovery_at`, `recovery_reason`. The "filter system rows" goal was met by SQL LIKE filter instead.
- **`is_system` column on `task_activities`** (and the backfill that would have set it on existing `Agent health: …` rows).
- **Task-scoped dispatch auth tokens**: `tasks.dispatch_token`, `tasks.dispatch_token_expires_at`, index `idx_tasks_dispatch_token`, HMAC token generator, middleware validation, in-process token cache. Dispatch still uses the master `MC_API_TOKEN`.
- **`openclaw_sessions` liveness columns**: `last_checked_at`, `session_alive`, and the `checkSessionLiveness()` RPC against the gateway.
- **Recovery / artifact pipeline**: `checkTaskArtifacts()` (git/PR/output-dir probing), `autoCompleteTask()` that promotes verified work to `review`, and the `MAX_RECOVERY_ATTEMPTS` cap.
- **UI surfaces**: dedicated health dots on `TaskCard`, board-level `HealthAlertBanner`, browser-notifications path, and the `agentHealthMap` / `healthAlerts` store fields plus their SSE handlers. (The `agent_health_changed` event is broadcast — `agent-health.ts:129` — but no dedicated banner consumes it.)

Future contributors: do not assume any of the above exists. If a use case needs one of them, treat it as a fresh design.
