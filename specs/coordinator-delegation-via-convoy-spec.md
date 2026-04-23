# Coordinator Delegation via Convoy — Spec

**Version:** 0.1 (draft)
**Date:** 2026-04-22
**Status:** Proposed
**Supersedes portions of:** [`convoy-mode-spec.md`](./convoy-mode-spec.md) §7 (task decomposition is extended, not replaced)
**Depends on:** none — this is the first of a three-part observability overhaul. A sibling proposal covers `log_activity` cadence + `ask_operator`; a third covers the per-delegation stall detector.

---

## 1. Problem

Coordinator agents fan out work to peers via the `delegate` MCP tool today
([`src/lib/mcp/tools.ts:577`](../src/lib/mcp/tools.ts)). That tool is
fire-and-forget: it calls `chat.send` into a per-task session key and writes a
single `[DELEGATION]` audit string to `task_activities`. Nothing records:

- what the peer owes back (deliverables, acceptance criteria)
- by when (expected duration, check-in cadence)
- current state (dispatched → acknowledged → working → delivered → accepted)
- linkage so the parent task's stall signal can reason about which branch is
  late

Empirical evidence (live DB, 2026-04-22):

| Metric                                                 | Value |
|--------------------------------------------------------|------:|
| Tasks stuck `in_progress`                              |    45 |
| Repeat stall flags on a single fan-out task (cc3d40e1) |   106 |
| Unread mails older than 1 h                            |    49 |
| `[DELEGATION]` audit rows with no follow-up delivery   | most  |
| Convoys in use                                         |     1 |

The failure mode on task `cc3d40e1` is canonical: the coordinator fired three
`delegate` calls (Researcher, Writer, Reviewer), one peer dropped the ball,
and the system has no way to tell which. The parent-task stall scanner just
re-flagged 106 times because it has only a global "nothing has happened in 30
min" rule to fall back on.

Meanwhile the **convoy** feature already models everything the delegation
flow needs — persistent subtask rows, dependency DAG, auto-completion,
convoy-aware stall detection, and a UI — but it is operator-initiated only
(HTTP + UI form or AI decomposition) and therefore unused by agents, which
reach for the weaker `delegate` tool instead.

---

## 2. Decision

**Consolidate. Convoy becomes the substrate for all coordinator-driven
delegation; the `delegate` MCP tool is retired.**

Convoys become the natural *next step of a workflow*: when a coordinator
decides it needs peer help, creating (or appending to) a convoy is the
mechanism that codifies what was asked, what's owed, and how we know when it
is dead, blocked, or done.

### 2.1 Mental model

```
Task (planning → assigned → coordinator-in-progress)
      │
      └── Coordinator decides to delegate
              │
              └── spawn_subtask(peer, slice, deliverables, duration, acceptance)
                      │
                      │  (first call on this task: lazily creates convoy)
                      │  (subsequent calls: append subtask to same convoy)
                      │
                      ├── inserts `convoy_subtasks` row
                      ├── inserts `tasks` row (child), pre-assigned to peer
                      ├── runs the existing /api/tasks/:id/dispatch pipeline
                      │   (peer gets a normal briefing, normal MCP roster,
                      │    normal stall coverage — no new dispatch path)
                      └── parent task enters `convoy_active`

Peer's work drives the child task's normal lifecycle
  (assigned → in_progress → review → done / cancelled).

Convoy auto-completion (existing `checkConvoyCompletion` in convoy.ts)
promotes the parent task when all children are `done`.
```

### 2.2 Convoy uniqueness

- **Default behavior:** a task has **at most one convoy**; repeated
  coordinator delegations append subtasks to that convoy. The convoy is "the
  obligation tree for this task".
- **Schema posture:** drop the `UNIQUE` on `convoys.parent_task_id` in the
  same migration, so a multi-wave model ("wave 1 research, wave 2 review")
  remains available as a future pivot without another schema change.
- All convoy readers that currently use `queryOne<Convoy>` by `parent_task_id`
  (five call-sites, listed in §5.3) switch to "latest active convoy" — a
  semantic-preserving change under the default, future-proof otherwise.

### 2.3 What's kept from the existing convoy machinery

| Capability                           | Reused as-is                                                     |
|--------------------------------------|------------------------------------------------------------------|
| Persistent subtask rows              | `tasks` (with `is_subtask=1`, `convoy_id`)                       |
| Dependency DAG                       | `convoy_subtasks.depends_on`                                     |
| Parallel fan-out                     | `dispatchReadyConvoySubtasks` (cap raised — see §5.2)            |
| Auto-completion                      | `checkConvoyCompletion` ([`convoy.ts:195`](../src/lib/convoy.ts)) |
| Convoy-aware stall handling          | [`stall-detection.ts:234`](../src/lib/stall-detection.ts)        |
| UI                                   | `ConvoyTab.tsx`, `DependencyGraph.tsx`                            |
| Parent-state sentinel                | `tasks.status = 'convoy_active'`                                  |
| AI decomposition path                | Unchanged — operator-initiated convoys still work                |

### 2.4 What's retired (same PR as `spawn_subtask` ships)

- The `delegate` MCP tool ([`tools.ts:577`](../src/lib/mcp/tools.ts)) —
  handler and `server.registerTool` entry deleted outright. No
  deprecation window: `spawn_subtask` is strictly more capable and there
  is no production traffic worth preserving.
- The `[DELEGATION]` audit-string convention and its prompt guidance in
  the dispatch template (the coordinator example block in
  [`dispatch/route.ts:447`](../src/app/api/tasks/[id]/dispatch/route.ts)
  that shows a `delegate({…})` call).
- `src/lib/coordinator-audit.ts` (the scanner that greps
  `task_activities` for `[DELEGATION]` markers) — convoy subtask rows
  make it obsolete. Remove the file and any caller / cron entry.
- The "solo stall" branch of the stall scanner for convoy-parent tasks
  remains; only the per-subtask path gets richer SLO rules (§5.4).

---

## 3. MCP surface

Every agent ↔ MC interaction required by the convoy flow must go through the
`sc-mission-control` MCP server. No agent writes to the DB directly, no
agent POSTs to an HTTP route, and no convoy state change is reachable via
any channel an agent could take other than a tool call. HTTP routes for
operator-only actions (convoy delete/pause, AI decomposition) remain, but
are firewalled from agents by the normal authz.

### 3.1 Coverage matrix

For each interaction an agent legitimately needs, one named MCP tool is
authoritative:

| Agent interaction                                         | Role         | Tool                   | Status             |
|-----------------------------------------------------------|--------------|------------------------|--------------------|
| Delegate a slice of work to a peer                        | Coordinator  | `spawn_subtask`        | **NEW** (§3.2)     |
| List my outstanding delegations and their state           | Coordinator  | `list_my_subtasks`     | **NEW** (§3.3)     |
| Read a single subtask's contract + live status            | Coordinator  | `get_task` *(extend)*  | MODIFIED (§3.7)    |
| Accept a peer's delivered work                            | Coordinator  | `accept_subtask`       | **NEW** (§3.4)     |
| Reject a peer's delivered work with a reason              | Coordinator  | `reject_subtask`       | **NEW** (§3.4)     |
| Cancel a stuck peer before timeout                        | Coordinator  | `cancel_subtask`       | **NEW** (§3.5)     |
| Read my own task (including the Delegation Contract)      | Peer         | `get_task` *(extend)*  | MODIFIED (§3.7)    |
| Emit required heartbeat note                              | Peer         | `log_activity`         | Existing           |
| Register a deliverable against my contract                | Peer         | `register_deliverable` *(extend)* | MODIFIED (§3.7) |
| Move my task forward when done                            | Peer         | `update_task_status` *(extend)*   | MODIFIED (§3.7) |
| Declare I'm blocked with a reason                         | Peer         | `fail_task` *(extend)* | MODIFIED (§3.7)    |
| Ask a human for help when genuinely ambiguous             | Peer         | `ask_operator`         | NEW (sibling spec) |
| Mail the coordinator (free-form)                          | Peer         | `send_mail`            | Existing           |

Tools **not** added for agents — operator-only, HTTP only:

- `createConvoy` AI-decomposition flow ([`/api/tasks/:id/convoy`](../src/app/api/tasks/[id]/convoy/route.ts)) — operator plans a task; agents never do.
- `updateConvoyStatus` pause/resume, `deleteConvoy` — lifecycle control is operator-side.
- `addSubtasks` bulk-operator endpoint — agents use `spawn_subtask` one at a time with a full contract each.

**Tool that deliberately does not exist: peer sub-delegation.** A peer on a
subtask cannot call `spawn_subtask` — the authz check rejects callers whose
task has `is_subtask=1`. See §3.8 for the required escape hatch when a peer
decides its slice is wrong.

### 3.2 `spawn_subtask` (replaces `delegate` in the same change)

**Authorization:** caller must be the parent task's `assigned_agent_id`
(reuses `assertAgentCanActOnTask(… , 'spawn_subtask')`).

**Input schema:**

```ts
{
  agent_id:         string,    // calling coordinator
  task_id:          string,    // parent task
  peer_gateway_id:  string,    // 'mc-researcher' | 'mc-writer' | …
  slice:            string,    // 1-line "what this peer owns"
  message:          string,    // full brief sent to peer's session
  expected_deliverables: Array<{ title: string, kind: 'file'|'note'|'report' }>,
                              // ≥1 required
  acceptance_criteria:   string[],
                              // ≥1 required, each ≥10 chars
  expected_duration_minutes: number,   // 5..240, required
  checkin_interval_minutes:  number,   // default 15, 5..60
  depends_on_subtask_ids:   string[]   // optional, same-convoy ids only
}
```

**Behavior:**

1. Resolve peer by `gateway_agent_id` (fail with `peer_not_found` otherwise).
2. **Lazy convoy create or reuse:**
   - Find the latest `status='active'` convoy for this parent task.
   - If none, `createConvoy({ parentTaskId, name: "<task title> — delegations", strategy: 'agent' })` — new enum value added to the `decomposition_strategy` CHECK.
3. Insert a `convoy_subtasks` row (with the SLO fields from §5.1) and a
   companion `tasks` row (`is_subtask=1`, assigned to the peer, priority
   inherited from parent).
4. Call `/api/tasks/:child_id/dispatch` internally — peer gets the standard
   briefing (call-home block, deliverables checklist, completion
   instructions) plus a **Delegation Contract** section carrying
   `slice`, `expected_deliverables`, `acceptance_criteria`,
   `expected_duration_minutes`, `checkin_interval_minutes`, and an explicit
   `parent_subtask_id` the peer echoes back if needed.
5. Log `delegation_spawned` activity on the **parent** task for the timeline.
6. Return:
   ```json
   { "subtask_id": "...", "child_task_id": "...", "convoy_id": "...",
     "due_at": "2026-04-22T15:30:00Z" }
   ```

**No coexistence with `delegate`.** In the same PR that registers
`spawn_subtask`, the `delegate` tool is deleted (handler + registration +
schema), the `[DELEGATION]` audit-string convention is removed, and the
`coordinator-audit.ts` scanner that greps for those strings is deleted. The
tool is not marked deprecated; there is no fallback. Rationale: we're still
in the build phase with low usage, so a clean swap avoids the ambiguity of
having two tools that look like they do the same thing but have different
observability.

### 3.3 `list_my_subtasks` (coordinator-facing)

Gives a coordinator the live picture of its delegations without needing to
poll `get_task` per child.

**Input:**
```ts
{ agent_id: string, task_id: string,
  states?: Array<'active'|'overdue'|'drifting'|'delivered'|'closed'> }
```

**Returns:** array of
```ts
{
  subtask_id, child_task_id, peer: { id, name, gateway_agent_id },
  slice, state_derived,                 // dispatched|in_progress|drifting|overdue|delivered|accepted|rejected|timed_out
  dispatched_at, due_at, last_activity_at,
  deliverables_registered: number, deliverables_expected: number
}
```

This is the single read the coordinator uses in its "am I waiting on
anyone?" check.

### 3.4 `accept_subtask` / `reject_subtask`

When a peer's child task reaches `review` (builder-style) or `done`
(tester/reviewer-style), the coordinator closes the loop via these tools.
No HTTP fallback.

- `accept_subtask({ agent_id, subtask_id })`
  - Promotes child `review → done` (or re-affirms `done`).
  - Bumps `convoys.completed_subtasks`; triggers `checkConvoyCompletion`
    which may promote the parent to `review`.
  - Logs `delegation_accepted` activity on the parent task timeline.
- `reject_subtask({ agent_id, subtask_id, reason, new_acceptance_criteria? })`
  - Sets child `status = 'in_progress'`, `status_reason = 'rejected: …'`.
  - Sends the rejection note into the child's chat session (`chat.send`)
    with the new/augmented criteria so the peer knows what to fix.
  - Logs `delegation_rejected` on the parent timeline.

### 3.5 `cancel_subtask`

Lets a coordinator release a branch that is no longer needed (e.g., the
slice changed, a peer is demonstrably stuck and the coordinator wants to
re-spawn with a clearer brief). Distinct from `reject_subtask` which
implies "work delivered but wrong".

```ts
cancel_subtask({ agent_id, subtask_id, reason })
```
- Child task → `cancelled`, `status_reason = 'cancelled_by_coordinator: …'`.
- Bumps `convoys.failed_subtasks`; the subtask no longer blocks convoy
  completion.
- Logs `delegation_cancelled`.

### 3.6 `ask_operator` (sibling proposal)

Covered in the sibling observability spec; mentioned here because it closes
the last "peer is stuck and needs a human" hole in the delegation path. No
convoy-specific change — it just sets the peer's task to `awaiting_operator`
and the convoy-aware stall logic already routes through the coordinator.

### 3.7 Modifications to existing MCP tools

These changes are small but make the existing surface convoy-aware so
peers and coordinators don't need new tools for routine work.

- **`get_task`** ([`tools.ts:214`](../src/lib/mcp/tools.ts))
  When the task has `convoy_id IS NOT NULL` and a matching
  `convoy_subtasks` row, include the Delegation Contract
  (slice, expected_deliverables, acceptance_criteria, dispatched_at,
  due_at, checkin_interval_minutes) in the structured response. The peer
  uses this to refresh its contract mid-run; the coordinator uses it for
  point-lookups. Eliminates any need to parse the dispatch brief for
  structured data.

- **`register_deliverable`** ([`tools.ts:265`](../src/lib/mcp/tools.ts))
  Auto-resolve `parent_subtask_id` from the child task's `convoy_id`
  (no new input required). On insert, also update
  `convoy_subtasks.deliverables_registered_count` so
  `list_my_subtasks` stays cheap.

- **`update_task_status`** ([`tools.ts:340`](../src/lib/mcp/tools.ts))
  When a subtask transitions to `review`, mail the coordinator (same
  plumbing as stall detector's sendMail) with a "ready for review"
  note so the coordinator knows to call `accept_subtask` /
  `reject_subtask` — even if it's not actively polling `list_my_subtasks`.

- **`fail_task`** ([`tools.ts:399`](../src/lib/mcp/tools.ts))
  When called on a subtask, record the failure on
  `convoy_subtasks.state_reason = 'blocked: …'` and mail the
  coordinator. The peer's task stays in its current status (not
  auto-cancelled) so a coordinator can choose to re-spawn or unblock.

- **`send_mail`** — no schema change, but the convoy-aware stall code
  already uses it to notify coordinators; document the subject-line
  convention (`DELEGATION: drifting/overdue/blocked/ready_for_review`) so
  the coordinator's inbox triage is deterministic.

### 3.8 Peer escape hatch: "my slice is wrong, re-decompose"

Peers cannot sub-delegate (see §3.1). Sub-delegation creates fan-out
storms and obscures the coordinator's picture of the tree, and we don't
have the observability to handle it safely yet. A peer that realizes its
slice is too big, mis-scoped, or misaligned with the parent goal has
exactly two sanctioned paths, in preference order:

**Path A — deliver what you have, let the coordinator re-assess.**
Preferred. The peer registers partial deliverables via
`register_deliverable` (with a note on what's incomplete) and moves its
task to `review` via `update_task_status`. The coordinator receives the
`DELEGATION: ready_for_review` mail, inspects the partial work, and
either `accept_subtask` (good enough) or `reject_subtask` (with updated
acceptance criteria) or `cancel_subtask` + a fresh `spawn_subtask` round
(re-decompose). Partial progress remains visible and reusable.

**Path B — explicitly hand control back, then stop.** For the case where
the peer cannot produce anything usable (e.g., the slice describes work
the peer does not have skills for, or the acceptance criteria are
contradictory). The peer:

1. Calls `fail_task({ task_id, reason: 'redecompose: <specific ask>' })`.
   The `redecompose:` prefix is a convention; see below for why we're
   not adding a new tool.
2. Optionally sends a single `send_mail` to the coordinator with subject
   `DELEGATION: redecompose_requested` and a body describing what a
   better decomposition would look like (suggested slices, any context
   the coordinator will need).
3. Returns a final message like `REDECOMPOSE_REQUESTED: <reason>` and
   stops. No further tool calls, no workaround attempts, no
   "meanwhile-I-tried" behavior — the peer's run ends there.

The coordinator, on seeing the `redecompose:` mail, is expected to
`cancel_subtask` on this branch and then issue one or more fresh
`spawn_subtask` calls with better-scoped slices. The peer's session is
effectively terminal at that point; OpenClaw cleans it up on session
timeout or on the coordinator's `cancel_subtask` call (which closes the
child task).

**Why no dedicated `request_redecomposition` tool?** It would overlap
almost entirely with `fail_task` + `send_mail` (both of which every peer
already has) and add surface area agents would routinely confuse with
`ask_operator`. The `fail_task` reason-prefix convention is explicit
enough for the coordinator to branch on, and keeps the MCP surface
focused. If in practice coordinators miss the prefix and re-dispatch
without re-decomposing, revisit — promote it to a real tool then.

**Dispatch-briefing update.** The peer Delegation Contract block (§4)
gets a final line:

> **If the slice is wrong:** do not sub-delegate, do not improvise. Call
> `fail_task` with `reason: "redecompose: …"`, optionally mail the
> coordinator with suggestions, and stop. The coordinator will re-plan.

---

## 4. Dispatch briefing: Delegation Contract block

Peers receive an extra section in their dispatch message (appended by
`/api/tasks/:id/dispatch` when the task has `convoy_id IS NOT NULL` AND the
convoy subtask row has SLO fields):

```
---
**🤝 DELEGATION CONTRACT**

You were delegated this work by coordinator <name>. The contract is:

- **Slice:** <one-line slice>
- **Expected deliverables:** (must all be registered)
  - <title> (<kind>)
  - …
- **Acceptance criteria:** (all must hold)
  - <criterion 1>
  - …
- **Expected duration:** <N> minutes (hard deadline at <ISO-8601>)
- **Check-in cadence:** call `log_activity` at least every <M> minutes
  with a substantive note. Silence past 2× cadence = drift alert to coordinator.
- **If blocked:** call `ask_operator` (preferred) or `fail_task` with a
  specific reason. Do NOT keep working around ambiguity.

Your `parent_subtask_id` is `<uuid>` — include it in `register_deliverable`
and `fail_task` calls so the coordinator's tree updates.
```

This is the codification the operator has been asking for. It lives **inside
the peer's briefing**, so the peer literally sees the contract it is on the
hook for.

---

## 5. Schema & code changes

### 5.1 Migrations

```sql
-- 1. SLO fields on convoy_subtasks
ALTER TABLE convoy_subtasks ADD COLUMN expected_duration_minutes INTEGER;
ALTER TABLE convoy_subtasks ADD COLUMN checkin_interval_minutes  INTEGER DEFAULT 15;
ALTER TABLE convoy_subtasks ADD COLUMN acceptance_criteria TEXT;   -- JSON array
ALTER TABLE convoy_subtasks ADD COLUMN expected_deliverables TEXT; -- JSON array
ALTER TABLE convoy_subtasks ADD COLUMN dispatched_at TEXT;         -- set on spawn
ALTER TABLE convoy_subtasks ADD COLUMN due_at        TEXT;         -- dispatched_at + expected_duration

-- 2. Drop the UNIQUE on parent_task_id (SQLite = table rebuild).
--    Replace with a non-unique index; all `queryOne` readers switch to
--    "latest active" ordering.
DROP INDEX IF EXISTS idx_convoys_parent;    -- was on parent_task_id
-- (table rebuild handled in migration runner, see src/lib/db/migrations.ts
-- pattern used for the 'convoy_active' status addition at line 757)
CREATE INDEX idx_convoys_parent_active ON convoys(parent_task_id, status);

-- 3. New decomposition_strategy value for agent-initiated convoys
--    (SQLite CHECK constraint rebuild; pattern matches migrations.ts:1623)
-- old: CHECK (decomposition_strategy IN ('manual','ai','planning'))
-- new: CHECK (decomposition_strategy IN ('manual','ai','planning','agent'))
```

### 5.2 Parallel cap

`MAX_PARALLEL_CONVOY_SUBTASKS` at [`convoy.ts:266`](../src/lib/convoy.ts)
currently `5`. Raise to `10` and expose as
`MC_CONVOY_MAX_PARALLEL` env var. Rationale: operator-planned convoys rarely
exceed 5, but an agent-driven coordinator can legitimately fan out to every
peer in the roster (7 roles today) in one batch.

### 5.3 Single-convoy reader migration

Replace in place with a shared helper `getActiveConvoyForTask(parentTaskId)`
that returns the most-recently-created `status='active'` convoy:

| Callsite                                                       | Change                                           |
|----------------------------------------------------------------|--------------------------------------------------|
| [`convoy.ts:71`](../src/lib/convoy.ts) (createConvoy guard)    | Remove `existing` check; convoys may co-exist.   |
| [`convoy.ts:136`](../src/lib/convoy.ts) (getConvoy)            | Route through helper; preserve existing shape.   |
| [`stall-detection.ts:201`](../src/lib/stall-detection.ts)      | Route through helper.                            |
| [`admin/release-stall/route.ts:56`](../src/app/api/tasks/[id]/admin/release-stall/route.ts) | Route through helper. |
| [`tasks/[id]/route.ts:578`](../src/app/api/tasks/[id]/route.ts) | Route through helper.                            |

The helper makes the "latest active" semantic explicit so it survives future
multi-convoy work.

### 5.4 Stall detection per-subtask

In [`src/lib/stall-detection.ts`](../src/lib/stall-detection.ts), when a
candidate task has a `convoy_subtasks` row with SLO fields, replace the
global `DEFAULT_STALL_MINUTES = 30` with:

```ts
const driftMinutes  = checkin_interval_minutes * 2;   // silent drift
const overdueMinutes = expected_duration_minutes * 1.5; // hard overdue
```

Escalation ladder (replaces the current "flag and throttle forever" loop
that caused 106 repeats on cc3d40e1):

| Condition                                          | Action                                                                  |
|----------------------------------------------------|-------------------------------------------------------------------------|
| `last_activity_at` older than `driftMinutes`       | Mail coordinator (existing path), set `status_reason = 'drifting'`.     |
| Wall-clock past `due_at`                           | Mail coordinator + operator, set `status_reason = 'overdue'`.           |
| Past `due_at + driftMinutes` AND no deliverables   | `status = 'cancelled'`, `status_reason = 'timed_out'`, promote convoy counter. |

The parent-task stall rule becomes: **all active subtasks `cancelled` or
`blocked` and no new `spawn_subtask` in N minutes** → stall the parent.
Deterministic, per-branch, and loop-free.

### 5.5 Prompt changes

- **Coordinator dispatch template**
  ([`src/app/api/tasks/[id]/dispatch/route.ts:447`](../src/app/api/tasks/[id]/dispatch/route.ts)):
  replace the `delegate({…})` example with a `spawn_subtask({…})` example.
  Emphasize "every delegation must declare deliverables, acceptance,
  duration, and cadence — no declarations means no spawn".
- **Peer dispatch template**: add the Delegation Contract block from §4 when
  `tasks.convoy_id IS NOT NULL` and the subtask row has SLO fields.

### 5.6 UI

- **ConvoyTab.tsx**: add per-subtask columns for `due_at` (countdown chip),
  `last_activity_at` (age), and a state pill derived from
  `tasks.status` + `status_reason` (`dispatched` / `in-progress` /
  `drifting` / `overdue` / `delivered` / `timed-out`).
- **Sidebar**: add "Delegations at risk" section listing subtasks with
  `status_reason IN ('drifting','overdue')` or `status='cancelled'` with
  `status_reason='timed_out'`.
- **Accept/Reject controls** on each subtask in `review` status, wired to
  the new `accept_subtask`/`reject_subtask` MCP tools via an internal API.

---

## 6. Rollout

Single cutover. We are still in the build phase and `delegate` has no
production dependency worth preserving, so the swap is one PR with no
coexistence window.

1. **One PR: schema + MCP surface swap.**
   - Schema migrations from §5.1 (SLO columns, drop UNIQUE, add `'agent'`
     strategy).
   - `getActiveConvoyForTask` helper + the five-callsite refactor (§5.3).
   - Register `spawn_subtask`, `list_my_subtasks`, `accept_subtask`,
     `reject_subtask`, `cancel_subtask`; modify `get_task`,
     `register_deliverable`, `update_task_status`, `fail_task`,
     `send_mail` per §3.7.
   - **Delete `delegate`** handler, registration, and the
     `[DELEGATION]` audit-string convention.
   - Delete `src/lib/coordinator-audit.ts` (and any caller / cron entry)
     since the convoy subtask row replaces what it used to scan for.
   - Update the coordinator dispatch briefing
     ([`/api/tasks/[id]/dispatch/route.ts:447`](../src/app/api/tasks/[id]/dispatch/route.ts))
     to describe `spawn_subtask`; add the peer Delegation Contract block.
2. **Follow-up PR: per-subtask stall rules** (§5.4). Gated behind the
   schema migration from (1) so SLO columns are guaranteed present. The
   existing 30-min global rule remains the fallback for rows where SLO
   columns are NULL (operator-created convoys from before this migration —
   only the one existing row).
3. **Follow-up PR: UI.** ConvoyTab SLO chips, at-risk sidebar, accept/
   reject buttons wired to the new tools.

Rollback for PR (1): revert the single commit; the migration is
reversible via the standard `down` step (drop new columns, restore
`UNIQUE`, re-register `delegate`). But since we're killing `delegate`
deliberately, rollback is a "revert-and-redesign" move, not a "revert and
keep running" move — that's the tradeoff of the clean swap.

---

## 7. Verification

- **Unit:** `spawn_subtask` lazy-create branch; appending to existing
  convoy; authz rejects non-coordinator callers; missing-field rejects.
- **Integration:** coordinator spawns three subtasks; each peer receives a
  dispatch with the contract block; one peer stays silent past
  `2 × checkin_interval`; stall scanner marks it `drifting`; scanner mails
  the coordinator with the specific subtask id.
- **Regression:** operator-created convoys (AI decomposition path)
  continue to work unchanged. `ConvoyTab` still renders them (with the new
  columns showing NULL → `—`).
- **Data:** re-run the §1 metrics query after a week in production.
  Success signals: stall-repeat count per task falls below 3; median
  subtask has `last_activity_at` freshness inside declared cadence; zero
  `[DELEGATION]` audit strings being written.

---

## 8. Open questions

1. **Depends-on across waves.** When a coordinator appends subtasks to an
   existing convoy, the new rows can depend on earlier ones. The dependency
   enforcer ([`convoy.ts:366`](../src/lib/convoy.ts)) already handles
   arbitrary DAGs inside one convoy, but spec should state that "second
   wave" subtasks may reference first-wave ids.
2. **Workspace isolation for subtasks.** `workspace-isolation.ts:117`
   already treats convoy subtasks as active; confirm that agent-spawned
   subtasks route into the same workspace as their parent unless the peer
   is itself a builder (which would require its own isolated dir).
3. **Chargeback / cost attribution.** Convoy subtasks already inherit
   cost events via the normal pipeline; no change needed unless the
   operator wants per-delegation cost rollups in the UI.

---

## 9. Non-goals

- **Peer sub-delegation.** A peer on a subtask cannot spawn further
  subtasks. Authz explicitly rejects `spawn_subtask` when the caller's
  task has `is_subtask=1`. The desired behavior when a peer thinks its
  slice is wrong is codified in §3.8 (deliver partial → coordinator
  re-assesses; or `fail_task("redecompose: …")` → peer stops →
  coordinator re-plans). We prefer a coordinator re-plan to a deeper
  tree because (a) we don't yet have the observability to reason about
  multi-level fan-out, and (b) a partial deliverable plus a coordinator
  prompt is always more recoverable than an orphaned sub-sub-tree. Revisit
  only after the delegation observability numbers in §7 hold steady.
- **Multi-convoy-per-task UX.** The schema allows it; the UI does not
  show it yet. Deferred until a real use case emerges.
- **Replacing operator-initiated convoy creation** (HTTP + AI
  decomposition). Those paths remain; `spawn_subtask` is an additional
  entry point, not a replacement.
