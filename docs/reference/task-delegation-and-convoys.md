---
status: current
last-verified: 2026-05-14
audience: ai-subagents-primary, operator-secondary
code-anchors:
  - src/lib/convoy.ts
  - src/lib/convoy-dag.ts
  - src/lib/workspace-isolation.ts
  - src/lib/mcp/groups/work.ts
  - src/lib/mcp/groups/core.ts
  - src/lib/db/migrations.ts
  - src/lib/task-governance.ts
  - src/lib/services/task-status.ts
  - src/lib/dispatch/roster-gate.ts
  - src/lib/mailbox.ts
  - src/lib/rollcall.ts
  - src/lib/checkpoint.ts
mcp-tools:
  [spawn_subtask, list_my_subtasks, update_subtask, escalate_to_parent,
   submit_evidence, register_deliverable, update_task_status, fail_task,
   send_mail, fetch_mail, save_checkpoint, get_task, list_peers, log_activity]
db-tables:
  [convoys, convoy_subtasks, work_checkpoints, agent_mailbox,
   rollcall_sessions, rollcall_entries, workspace_ports, workspace_merges,
   tasks (convoy_id / is_subtask / workspace_path / workspace_strategy /
   workspace_port / workspace_base_commit / merge_status / merge_pr_url /
   locked_for_completion)]
migrations:
  - "020 add_convoy_mode — convoys, convoy_subtasks, work_checkpoints, agent_mailbox; tasks.convoy_id + tasks.is_subtask + 'convoy_active' status (migrations.ts:673-819, esp. CREATE TABLE convoys :679, convoy_subtasks :695, work_checkpoints :721, agent_mailbox :734)"
  - "029 add_parallel_build_isolation — tasks.workspace_path/_strategy/_port/_base_commit + merge_status/_pr_url; workspace_ports; workspace_merges (migrations.ts:1297-1357)"
  - "030 add_suggested_role_to_convoy_subtasks — role hint for dispatch (migrations.ts:1682-1693)"
  - "032 active_flag_and_general_mailbox_and_rollcall — agent_mailbox.convoy_id nullable + .task_id added; rollcall_sessions + rollcall_entries (migrations.ts:1736-1817)"
  - "034 convoy_resolve_symbolic_depends_on — backfill (migrations.ts:1850-1916)"
  - "037 coordinator_delegation_convoy — SLO columns (slice, expected_deliverables, acceptance_criteria, expected_duration_minutes, checkin_interval_minutes, dispatched_at, due_at, deliverables_registered_count); DROP UNIQUE on convoys.parent_task_id; add 'agent' decomposition_strategy; idx_convoys_parent_active (migrations.ts:2075-2167)"
  - "091 convoy_subtasks_required_evidence_gates — JSON array of gates each subtask must satisfy to enter review (migrations.ts:4674-4687)"
  - "092 tasks_locked_for_completion — soft-lock fired by capability denial; only escalate_to_parent clears it (migrations.ts:4689-4702)"
related-specs:
  - autonomous-flow-tightening-spec.md — evidence gates + strict workspace isolation layer
  - review-stage-robustness-spec.md — role gating, convoy-subtask evidence gate, capability-denial soft-lock, escalate_to_parent
  - agent-health.md — generic stall semantics; convoy SLO clock is the per-subtask layer above it
  - subagent-orchestration.md — different capability (read-only subagents); cross-reference, do not merge
  - pm-convoy-mandate.md — PM-emit convoy entry point (decompose-flow proposals materialize convoys at accept time)
---

# Task Delegation and Convoys

> Canonical reference, replacing `coordinator-delegation-via-convoy-spec.md`,
> `convoy-mode-spec.md`, and `parallel-build-isolation-spec.md` (now in
> `docs/archive/`).

## 1. Overview & vocabulary

Mission Control fans out work through a single mechanism: a **parent task**
*spawns* one or more **subtasks** that *belong to a convoy*. Each subtask
runs in its own *isolated workspace*, reports progress through MCP tools,
and is *gated* on declared deliverables and evidence before it can be
accepted.

- A **task** is the durable work record (`tasks` row).
- A **convoy** is a group of subtasks that share a parent task. The convoy
  is the "obligation tree" attached to that parent and its lifecycle
  (active → done / failed / paused) is independent of the parent's status.
  See `src/lib/convoy.ts:70-78` (`getActiveConvoyForTask`).
- A **subtask** is a `tasks` row with `is_subtask = 1` and
  `convoy_id IS NOT NULL`; it is also indexed by a `convoy_subtasks` row
  that carries the **Delegation Contract** (slice, expected deliverables,
  acceptance criteria, SLO clock, role hint, evidence-gate set).
- The parent **spawns** a subtask via the `spawn_subtask` MCP tool, which
  *lazy-creates* a convoy on first call and *appends* on subsequent calls
  (`src/lib/convoy.ts:550-714`).
- A coordinator agent **coordinates** a convoy: it decides what work to
  delegate, monitors via `list_my_subtasks`, and closes each branch with
  `update_subtask({action: 'accept'|'reject'|'cancel'})`.
- A peer agent **executes** its subtask in the isolated workspace,
  *registers* deliverables, *submits* evidence for prescribed gates, and
  transitions status when done.
- Convoy **completion** is observed by `checkConvoyCompletion`
  (`src/lib/convoy.ts:219`): when every subtask is `done`, the parent is
  promoted from `convoy_active` to `review`.

The mental model is intentionally narrow: **the operator does not micro-
manage convoys**; the coordinator does. Operator-driven decomposition (the
old `POST /api/tasks/:id/convoy` AI flow) still exists for explicit
planning use but is no longer the primary path — see §17 Appendix A.

The legacy `delegate` MCP tool has been removed. The MCP test suite
asserts this (`src/lib/mcp/mcp.test.ts:90`:
`assert.ok(!names.has('delegate'), 'delegate tool should be removed')`).

### Two convoy entry points (post-PM-convoy-mandate)

Convoys now have **two distinct entry points** for the same underlying
machinery:

1. **PM-emit at proposal-accept time.** When the PM produces a
   decompose-flow proposal (`trigger_kind` ∈ {`decompose_story`,
   `decompose_initiative`, `plan_initiative`}), it emits one or more
   `create_convoy_under_initiative` diffs. On accept, the apply pass in
   [`src/lib/db/pm-proposals.ts`](../../src/lib/db/pm-proposals.ts) calls
   the shared DAG materializer in
   [`src/lib/convoy-dag.ts`](../../src/lib/convoy-dag.ts) to create the
   parent task (status=`convoy_active`), the `convoys` row (with
   `acceptance_criteria` populated), and per-slice `convoy_subtasks`
   rows in topological order, then fires
   `dispatchReadyConvoySubtasks`. See
   [pm-convoy-mandate.md](pm-convoy-mandate.md).
2. **Coordinator-emit mid-flight.** A coordinator with an active task
   calls `spawn_subtask` or `plan_convoy` to append slices to an
   existing convoy (or lazy-create the first one). Same underlying
   helpers (`spawnDelegationSubtask`,
   `dispatchReadyConvoySubtasks`). The coordinator's role has shifted
   from *decomposer* to *monitor + accept + escalate*: decomposition
   happens at PM-emit time; `spawn_subtask` / `plan_convoy` remain
   available for follow-up work discovered mid-flight (e.g. a builder
   reports a missing slice).

The PM mandate is unconditional — the schema rejects
`create_task_under_initiative` from decompose-flow proposals at intake.
The original `MC_PM_CONVOY_MANDATE` env flag was removed after the
mandate stabilized.

---

## 2. Data model

### 2.1 `convoys`

Created by migration 020 (`migrations.ts:679-694`), amended by
migration 037 (`migrations.ts:2075-2167`).

| Column                   | Notes                                                                 |
|--------------------------|-----------------------------------------------------------------------|
| `id`                     | UUID PK                                                               |
| `parent_task_id`         | FK → `tasks.id` ON DELETE CASCADE. **No UNIQUE** (dropped mig 037).    |
| `name`                   | Free text — convoy display name                                       |
| `status`                 | `active` \| `paused` \| `completing` \| `done` \| `failed`            |
| `decomposition_strategy` | CHECK: `manual` \| `ai` \| `planning` \| `agent` (`agent` added 037)  |
| `decomposition_spec`     | JSON — only populated for the operator AI-decomposition flow          |
| `total_subtasks`         | Counter, kept in sync by `createConvoy` / `addSubtasks` / `spawnDelegationSubtask` |
| `completed_subtasks`     | Recomputed by `updateConvoyProgress` (`convoy.ts:191`)                |
| `failed_subtasks`        | Same recompute pass                                                   |
| `created_at`, `updated_at` | ISO timestamps                                                      |
| `acceptance_criteria`    | JSON array of strings (mig 095). Populated when the convoy is spawned from a PM `create_convoy_under_initiative` diff; NULL for coordinator-spawned convoys. Gates the parent task's `review → done` transition — see [pm-convoy-mandate.md](pm-convoy-mandate.md) + `task_ac_acknowledgements` table. |

Indexes: `idx_convoys_parent_active(parent_task_id, status)` replaces the
pre-037 `idx_convoys_parent` (see `migrations.ts:2161-2164`).

**Why UNIQUE was dropped.** Pre-037 the schema enforced one convoy per
parent task. The shipping coordinator-delegation flow lazy-creates a new
convoy on demand and can legitimately want multiple convoys per task
(e.g., a wave-1 research convoy that closes, then a wave-2 review
convoy). The "latest active" semantic is centralised in
`getActiveConvoyForTask` (`convoy.ts:70`) so callers don't accumulate
their own duplicate logic.

### 2.2 `convoy_subtasks`

Created by migration 020 (`migrations.ts:695-720`), extended by
migrations 030, 037, and 091.

Pre-037 columns:

| Column           | Notes                                                              |
|------------------|--------------------------------------------------------------------|
| `id`             | UUID PK                                                            |
| `convoy_id`      | FK → `convoys.id` ON DELETE CASCADE                                |
| `task_id`        | FK → `tasks.id` ON DELETE CASCADE; UNIQUE (one subtask row per task) |
| `sort_order`     | Append order within the convoy                                     |
| `depends_on`     | JSON array of `convoy_subtasks.task_id` values (resolved by mig 034) |
| `suggested_role` | Added mig 030 (`migrations.ts:1690`) — `builder`, `tester`, …      |
| `created_at`     |                                                                    |

Migration 037 added the SLO contract (`migrations.ts:2091-2098`):

| Column                          | Purpose                                                       |
|---------------------------------|---------------------------------------------------------------|
| `slice`                         | One-line summary of what the peer owns                        |
| `expected_deliverables`         | JSON array of `{title, kind}`                                 |
| `acceptance_criteria`           | JSON array of strings                                         |
| `expected_duration_minutes`     | Used by stall detector — 1.5× = hard overdue                  |
| `checkin_interval_minutes`      | Used by stall detector — 2× = drift signal (default 15)        |
| `dispatched_at`                 | Set when `spawnDelegationSubtask` rows the subtask in         |
| `due_at`                        | `dispatched_at + expected_duration_minutes`                   |
| `deliverables_registered_count` | Bumped by `register_deliverable` to keep `list_my_subtasks` cheap |

Migration 091 (`migrations.ts:4674-4687`) added
`required_evidence_gates` (JSON array of evidence-gate names; NULL on
legacy rows preserves the bypass). `spawnDelegationSubtask` defaults
this to `['test_full']` for every new subtask
(`convoy.ts:614`).

### 2.3 `tasks` — convoy & workspace columns

Added in waves:

- Migration 020 (`migrations.ts:752-754`, `:787-:790`):
  `tasks.is_subtask INTEGER DEFAULT 0`, `tasks.convoy_id TEXT REFERENCES convoys(id)`.
- Migration 020 also extended `tasks.status` CHECK to include
  `convoy_active`.
- Migration 029 (`migrations.ts:1303-1311`): `workspace_path`,
  `workspace_strategy`, `workspace_port` (subsequent block adds
  `workspace_base_commit`, `merge_status`, `merge_pr_url`).
- Migration 092 (`migrations.ts:4691-4702`): `locked_for_completion
  INTEGER NOT NULL DEFAULT 0` (soft-lock used by review-stage-robustness
  slice 3).

### 2.4 `work_checkpoints`

Created mig 020 (`migrations.ts:721-732`). One row per checkpoint save.

| Column            | Notes                                                          |
|-------------------|----------------------------------------------------------------|
| `id`              | UUID                                                           |
| `task_id`         | FK → `tasks.id`                                                |
| `agent_id`        | FK → `agents.id`                                               |
| `checkpoint_type` | `auto` \| `manual` \| `crash_recovery`                         |
| `state_summary`   | Free text                                                      |
| `files_snapshot`  | JSON `[{path, hash, size}]`                                    |
| `context_data`    | JSON record                                                    |
| `created_at`      |                                                                |

Index: `idx_work_checkpoints_task(task_id, created_at DESC)`.

Driver coverage is light — see §10.

### 2.5 `agent_mailbox`

Created mig 020 (`migrations.ts:734-745`), generalised mig 032
(`migrations.ts:1747-1781`). Originally convoy-scoped only; mig 032
makes `convoy_id` nullable and adds `task_id` so mail can be scoped to a
task or to nothing (ad-hoc roll-call mail, master-orchestrator pings).

| Column                       | Notes                                       |
|------------------------------|---------------------------------------------|
| `id`, `convoy_id?`, `task_id?` | scope (both nullable post-mig 032)         |
| `from_agent_id`, `to_agent_id` |                                            |
| `subject`, `body`            |                                             |
| `read_at`                    | NULL = unread                               |
| `created_at`                 |                                             |

Indexes: `idx_agent_mailbox_to(to_agent_id, read_at)`,
`idx_agent_mailbox_convoy(convoy_id) WHERE convoy_id IS NOT NULL`,
`idx_agent_mailbox_task(task_id) WHERE task_id IS NOT NULL`.

### 2.6 `rollcall_sessions` / `rollcall_entries`

Created mig 032 (`migrations.ts:1786-1813`). Durable record of every
roll-call: one session row per call, one entry row per target agent.
See `src/lib/rollcall.ts` for the driver.

### 2.7 `workspace_ports` / `workspace_merges`

Created mig 029 (`migrations.ts:1322-1357`). Port allocator backing
store and merge history.

---

## 3. `spawn_subtask` MCP tool

Registered at `src/lib/mcp/groups/work.ts:1145-1382`.

### 3.1 Signature

```ts
spawn_subtask({
  agent_id:                  string,   // calling coordinator
  task_id:                   string,   // parent task id
  peer_gateway_id:           string,   // e.g. 'mc-researcher'
  slice:                     string,   // 10..500 chars
  message:                   string,   // 1..10000 chars — full brief
  expected_deliverables:     Array<{ title: string; kind: 'file'|'note'|'report' }>,  // min 1
  acceptance_criteria:       string[],  // min 1, each ≥10 chars
  expected_duration_minutes: number,    // int 5..240
  checkin_interval_minutes?: number,    // int 5..60, default 15
  depends_on_subtask_ids?:   string[],  // ids from prior spawn_subtask calls
})
```

Schema definitions are inline (`work.ts:1151-1202`).

### 3.2 Pre-conditions

1. `assertAgentCanActOnTask(agent_id, task_id, 'delegate')` —
   coordinator-only on this task (`work.ts:1212`).
2. The parent task must **not** itself be a subtask
   (`tasks.is_subtask !== 1` — `work.ts:1241-1257`). Peer
   sub-delegation is forbidden by design.
3. The peer (`peer_gateway_id`) must exist **in the parent task's
   workspace** (`work.ts:1265-1307`). Cross-workspace clones return a
   structured `peer_not_in_workspace` error with the actual workspaces
   the gateway id appears in.

### 3.3 Behaviour

1. Resolve the peer agent row (id, name, role).
2. Call `spawnDelegationSubtask(...)` (`convoy.ts:550`), which inside a
   single transaction:
   - finds the latest `active` convoy on the parent
     (`getActiveConvoyForTask`) or lazy-creates one with
     `decomposition_strategy = 'agent'`;
   - sets the parent's status to `convoy_active` on convoy creation;
   - inserts a `tasks` row (`is_subtask = 1`, status `inbox`,
     `assigned_agent_id = peer.id`, workspace + business + workflow
     inherited from parent);
   - inserts a `convoy_subtasks` row carrying the SLO contract,
     `dispatched_at = now`, `due_at = now + expected_duration_minutes`,
     and `required_evidence_gates = ["test_full"]` by default
     (`convoy.ts:614`);
   - propagates the parent's `task_roles` to the child for every stage
     role; fills gaps via `populateTaskRolesFromAgents`
     (`convoy.ts:660-704`).
3. Log `delegation_spawned` on the parent's timeline (`work.ts:1329-1334`).
4. Move the child task to `assigned` and call `internalDispatch` so the
   peer gets the normal dispatch pipeline plus a **Delegation Contract**
   block (rendered from the dispatch route — see
   `src/app/api/tasks/[id]/dispatch/route.ts:864-907`).

### 3.4 Post-conditions / return

```ts
{
  subtask_id:                string,
  child_task_id:             string,
  convoy_id:                 string,
  peer:                      { id, name, gateway_agent_id },
  dispatched_at:             string,
  due_at:                    string,
  checkin_interval_minutes:  number,
}
```

If dispatch fails after the rows are written, the call returns
`isError: true, error: 'dispatch_failed'` with the orphan
`subtask_id` so the coordinator can `update_subtask({action: 'cancel'})`
and retry (`work.ts:1347-1366`). No silent rollback.

### 3.5 Authz denial → soft-lock

If `assertAgentCanActOnTask` throws `agent_not_coordinator`,
`setTaskCompletionLock` is set on the calling task with reason
`agent_not_coordinator`. The returned `structuredContent.next_action`
is `escalate_to_parent` and `blocked_tools` lists
`register_deliverable`, `update_task_status`, `submit_evidence`
(`work.ts:1219-1234`). This is review-stage-robustness slice 3 — see
that spec for the full rail.

---

## 4. Convoy lifecycle

```
   no convoy
       │
       │  first spawn_subtask on parent
       ▼
   ┌─────────┐  every subtask done  ┌────────┐
   │ active  │ ───────────────────► │  done  │
   └────┬────┘                      └────────┘
        │  > 50% subtasks failed
        ▼
   ┌────────┐
   │ failed │
   └────────┘
```

- **Creation.** Four entry points all converge on
  `INSERT INTO convoys`:
  1. `createConvoy()` — operator-driven manual / AI / planning flows
     (`convoy.ts:83`). Rejects a second active convoy on the same
     parent (`convoy.ts:97`).
  2. `spawnDelegationSubtask()` — lazy create from coordinator
     `spawn_subtask` / `plan_convoy` (`convoy.ts:560-574`).
  3. AI decomposition route at `src/app/api/tasks/[id]/convoy/route.ts`
     (unchanged from the original convoy-mode-spec; preserved for the
     operator path).
  4. **PM-emit** via `create_convoy_under_initiative` diff — the apply
     pass in [`src/lib/db/pm-proposals.ts`](../../src/lib/db/pm-proposals.ts)
     materializes the parent task + convoy + slice DAG through
     [`src/lib/convoy-dag.ts`](../../src/lib/convoy-dag.ts), populating
     `convoys.acceptance_criteria`. See
     [pm-convoy-mandate.md](pm-convoy-mandate.md).
- **Active.** Parent task sits in `convoy_active`. Each subtask runs
  the normal task lifecycle (`assigned → in_progress → testing → review →
  done`). `dispatchReadyConvoySubtasks` (`convoy.ts:321`) iterates
  subtasks whose dependencies have completed, respecting the parallel
  cap (`MC_CONVOY_MAX_PARALLEL`, default 10 — `convoy.ts:296-302`).
- **Promotion.** When a subtask transitions to `done`,
  `transitionTaskStatus` (`src/lib/services/task-status.ts:294-303`)
  calls `updateConvoyProgress` and `checkConvoyCompletion`. When all
  subtasks are `done`, the convoy moves to `done` and the parent moves
  to `review` (`convoy.ts:230-264`).
- **Failure threshold.** If more than half the subtasks have
  `status_reason IS NOT NULL`, the convoy is marked `failed` and the
  parent is moved to `review` with `status_reason = 'Convoy failed: too
  many sub-task failures'` (`convoy.ts:267-285`).
- **Deletion.** `deleteConvoy` (`convoy.ts:482`) cascades subtask rows,
  removes the convoy, and resets the parent to `inbox`. Operator-only
  path via HTTP DELETE.

---

## 5. Workspace isolation

Implemented in `src/lib/workspace-isolation.ts`.

### 5.1 Strategy resolution

`determineIsolationStrategy(task)` (`workspace-isolation.ts:108`):

| Condition                                            | Strategy   |
|------------------------------------------------------|------------|
| `task.repo_url` set                                  | `worktree` |
| Sibling task active on same `product_id`             | `sandbox`  |
| Neither                                              | `null` (shared dir) |

### 5.2 Strict-mode dispatch resolution

`resolveDispatchWorkspace(task, role, io)` (`workspace-isolation.ts:170-256`)
is the autonomous-flow-tightening enforcement point. The table summarises
its decision matrix (also captured in the function's doc comment):

| strategy | role               | `task.workspace_path` | Result                                                    |
|----------|--------------------|-----------------------|-----------------------------------------------------------|
| `null`   | any                | —                     | OK, `isolated: false`, shared dir                          |
| set      | `builder`          | exists on FS          | OK, reuse                                                  |
| set      | `builder`          | unset / missing       | Create fresh; on failure return `workspace_isolation_failed` (HTTP 503) |
| set      | `tester_or_reviewer` | set                  | OK, reuse Builder's workspace                              |
| set      | `tester_or_reviewer` | unset                | `no_workspace_for_quality_stage` (HTTP 409)                |
| set      | `other`            | —                     | OK, `isolated: false`, shared dir                          |

The 503 path is what caught the "Builder commits to main" post-mortem run
(see comment at `workspace-isolation.ts:148-168`).

### 5.3 Worktree strategy

`createWorktreeWorkspace` (`workspace-isolation.ts:345-414`):

1. If the project dir is a git repo, `git fetch origin` (best effort),
   then `git worktree add <path> -b autopilot/<slug> HEAD` falling back
   to checking out an existing branch.
2. Otherwise clone from `task.repo_url`.
3. Record the base commit (`git rev-parse HEAD`).

### 5.4 Sandbox strategy

`createSandboxWorkspace` (`workspace-isolation.ts:416-440`):

1. `rsync -a --exclude='.workspaces' --exclude='node_modules'
   --exclude='.next' --exclude='.git' --exclude='dist' --exclude='build'
   <projectDir>/ <workspaceDir>/`.
2. Fall back to `mkdirSync` on rsync failure.

### 5.5 Port isolation

Range 4200–4299 (`workspace-isolation.ts:70-71`). `allocatePort`
finds the lowest unused port in `workspace_ports` and INSERTs an
`active` row. `releasePort` flips `status='released'`.

### 5.6 Metadata file

`.mc-workspace.json` written into the workspace dir on creation
(`workspace-isolation.ts:319-332`). Carries `{taskId, productId,
createdAt, strategy, branch, baseBranch, baseCommit, status,
agentId, isolatedPort}`.

### 5.7 Persistence

`createTaskWorkspace` updates the task row with
`workspace_path`, `workspace_strategy`, `workspace_port`,
`workspace_base_commit`, `merge_status = 'pending'`
(`workspace-isolation.ts:336-340`).

### 5.8 Merge & cleanup

`mergeWorkspace` (`workspace-isolation.ts:508`) dispatches to
`mergeWorktree` (push + `gh pr create`, write `workspace_merges` row)
or `mergeSandbox` (rsync + diff conflict detection). Merge lock is
in-process Map keyed by `product_id`
(`workspace-isolation.ts:779-789`). `cleanupWorkspace`
(`workspace-isolation.ts:676`) removes the worktree (or sandbox dir),
deletes the branch, releases the port, and NULLs the task workspace
columns.

---

## 6. Subtask state model

Subtasks use the **same** `tasks.status` state machine as any other task
(`pending_dispatch | planning | inbox | assigned | in_progress |
convoy_active | testing | review | verification | done | cancelled`).
The convoy lifecycle is an aggregate above that.

### 6.1 Who can change what

- The **assigned peer** drives `in_progress → testing → review` via
  `update_task_status` (`work.ts:543-689`).
- The **coordinator** closes a subtask via `update_subtask`
  (`work.ts:1510-1573`):
  - `accept` → child `review/done` → `done` (and may promote the
    convoy).
  - `reject` → child back to `in_progress`, peer is messaged with the
    reason (and optional new acceptance criteria).
  - `cancel` → child `cancelled`, `failed_subtasks++`, no longer blocks
    convoy completion.
- Workflow orchestration on forward status moves is driven by
  `handleStageTransition` (`work.ts:602-635`) so role handoffs (Tester,
  Reviewer) actually dispatch the next agent — without this the
  builder stays "assigned" while the convoy waits forever.

### 6.2 Role gating

`src/lib/dispatch/roster-gate.ts:46-78` reads
`convoy_subtasks.suggested_role` to constrain who can run the subtask:
the subtask's row contributes its role plus `reviewer` (for the review
stage). Convoy parents (`status = 'convoy_active'`) take the **union**
of their children's suggested roles. See `review-stage-robustness-spec.md`
slice 1 for the full role-gating layer.

### 6.3 Evidence gates on subtasks

`task-governance.ts:118-138` reads
`convoy_subtasks.required_evidence_gates`. When the column is set (new
subtasks default to `['test_full']` — see §3.3), the gate fires on the
`review` transition; failures return
`Evidence gate: ${gate} required to enter review (subtask). Submit raw
command output via submit_evidence.` Legacy rows (NULL) keep the prior
bypass.

---

## 7. Evidence & completion

See `autonomous-flow-tightening-spec.md` for the full evidence pipeline.
Convoy-relevant points:

- **`register_deliverable`** (`work.ts:337-400`) — the peer's primary
  output mechanism. Bumps
  `convoy_subtasks.deliverables_registered_count` so the coordinator's
  `list_my_subtasks` view stays accurate without joining
  `task_deliverables` on every poll (`work.ts:371-376`).
- **`submit_evidence`** (`work.ts:402-448`) — paste-and-forward verifier
  for prescribed gates. Required to enter `testing` / `review` on tasks
  that carry a `required_evidence_gates` set (per §6.3). Self-reported
  booleans are rejected.
- **`update_task_status`** (`work.ts:542-689`) — when a delegated
  subtask transitions to `review` / `testing` / `verification`,
  `update_task_status` mails the coordinator with subject
  `DELEGATION: ready_for_review` so the coordinator can call
  `update_subtask` without polling (`work.ts:642-668`).
- **`fail_task`** on a subtask (`work.ts:692-758`) mails the
  coordinator with either `DELEGATION: blocked` or
  `DELEGATION: redecompose_requested` depending on whether the reason
  begins with `redecompose:` (the peer's "my slice is wrong" escape
  hatch).

The coordinator's `update_subtask({action: 'accept'})` ultimately drives
the convoy completion check — see §4.

---

## 8. Inter-agent communications during a convoy

### 8.1 Mail

`src/lib/mailbox.ts` exposes `sendMail` (driver) and the
`send_mail` MCP tool (`work.ts:958-1001`) wraps it via
`sendAgentMail` (which adds rollcall reply matching).

- Scope is optional: `convoy_id` and `task_id` may both be null.
- `push: true` pushes the mail through the recipient's active OpenClaw
  session via `sendChatToAgent` so they see it immediately rather than
  on the next dispatch (`mailbox.ts:65-138`).
- Unread mail is folded into dispatch briefings by
  `formatMailForDispatch` (`mailbox.ts:197-245`). Non-roll-call mail is
  capped at 5 most-recent entries; overflow stays unread for the next
  dispatch.

### 8.2 Roll-call

`src/lib/rollcall.ts` is the dedicated broadcast surface. The master
orchestrator pings every active agent in the workspace with a
templated mail (subject `roll_call:<rollcallId>`); replies match back
through `recordRollCallReplyIfMatch` (`rollcall.ts:340-384`).
Roll-call entries are durable (in `rollcall_entries`) and surface on
every dispatch via `formatPendingRollcallsForDispatch`
(`rollcall.ts:313-331`) until replied to — fixing the "stage-isolated
session has no mail history" failure mode noted in FM3 of the
autonomous-flow tightening work.

### 8.3 Mailbox vs roll-call

`agent_mailbox` is the actual transport for both surfaces. The pure
"broadcast-style messaging in a convoy" UX from the original
convoy-mode-spec §10 (per-convoy mailbox endpoints, `gt mail check
--inject`-style injection) **is not the active surface** — what
ships is generalised mail + roll-call. See §17 Appendix A.

---

## 9. Coordinator role

The Coordinator is bundled as an agent template at
`agent-templates/coordinator/` (`AGENTS.md`, `IDENTITY.md`,
`SOUL.md`). The dispatch route's role-specific block at
`src/app/api/tasks/[id]/dispatch/route.ts:646-697` is what the
Coordinator sees in its prompt:

- "Delegate to peers using the `spawn_subtask` MCP tool. Every
  delegation must declare deliverables, acceptance criteria, duration,
  and cadence — no declarations, no spawn."
- Inline example payloads for `spawn_subtask`, `list_my_subtasks`,
  `update_subtask`.
- "Reply with `TASK_COMPLETE: [one line per delegated subtask]`" when
  done.

Peers see the **Delegation Contract** block (`dispatch/route.ts:864-907`)
which pulls `slice`, `expected_deliverables`, `acceptance_criteria`,
`expected_duration_minutes`, `checkin_interval_minutes`,
`dispatched_at`, `due_at` from `convoy_subtasks` and renders them as a
ready-to-read contract above the rest of the briefing.

---

## 10. Checkpoints (light driver use)

`src/lib/checkpoint.ts` ships the `work_checkpoints` driver:

- `saveCheckpoint`, `saveCheckpointThrottled` (`checkpoint.ts:21-59`).
- `getLatestCheckpoint`, `getCheckpoints` (`checkpoint.ts:64-92`).
- `buildCheckpointContext` (`checkpoint.ts:97-122`) — formats the most
  recent checkpoint as a "🔄 CRASH RECOVERY" block for re-dispatch.
- MCP tool `save_checkpoint` (`work.ts:920-955`) lets agents save
  manually.

**Honest assessment:** the table and helper are shipped; the
auto-checkpoint cron, zombie detection + checkpoint-driven re-dispatch
flow described in the original convoy-mode-spec §9 is **not** the active
stall-recovery path. Per-subtask SLOs in `convoy_subtasks` (§6.3 + §11)
drive recovery instead. Checkpoints remain available for explicit
"resume from here" workflows.

---

## 11. Stall & recovery

Two layers, in increasing specificity:

1. **Agent-level (`src/lib/agent-health.ts`).** Generic per-agent
   health states (`idle | working | stalled | stuck | zombie | offline`)
   based on activity timestamps. Auto-nudges after
   `AUTO_NUDGE_AFTER_STALLS` stuck checks
   (`agent-health.ts:159-163`). Cross-reference `agent-health.md`.
2. **Convoy SLO (per-subtask).** Stall scanner (per
   `coordinator-delegation-via-convoy-spec.md` §5.4, shipped via
   `stall-detection.ts`) reads `convoy_subtasks` SLO columns:
   - `last_activity_at` older than `checkin_interval_minutes * 2` →
     drift; mail coordinator.
   - Now past `due_at` → overdue; mail coordinator + operator.
   - Past `due_at + drift` with no deliverables → set
     `status='cancelled'`, `status_reason='timed_out'`, bump
     `failed_subtasks`.

The **per-branch escalation** that closes the loop is the
`escalate_to_parent` MCP tool (`work.ts:761-917`). An agent that hits a
capability denial (e.g., `agent_not_coordinator` after
`spawn_subtask` is blocked) finds the soft-lock set
(`tasks.locked_for_completion=1`) and its only valid next call is
`escalate_to_parent`. Behaviour:

- Bounces the child to `assigned`, `is_failed=1`, status_reason
  `Failed: child_escalated — <reason>`.
- Clears the completion lock.
- Idempotent: a second call within 60s is a no-op
  (`work.ts:803-820`).
- If the task is a convoy child, the coordinator gets a pushed
  `ESCALATION: <title>` mail.
- If the task is top-level, the task flips to `needs_user_input` and
  the workspace PM gets the same mail (`work.ts:887-908`).

---

## 12. Operator-facing UI

### 12.1 Convoy tab on TaskModal

`src/components/ConvoyTab.tsx` (component:line `:36`). Loaded from
`src/components/TaskModal.tsx:14` and rendered conditionally at
`TaskModal.tsx:861`. Shows progress bar, per-subtask state pill,
dependency badges. Includes:

- `DependencyGraph` visualisation
  (`src/components/DependencyGraph.tsx:29`).
- Calls to `/api/tasks/[id]/convoy/progress` and
  `/api/tasks/[id]/convoy/route.ts`.

### 12.2 Initiatives view

`src/app/(app)/initiatives/[id]/page.tsx` is the initiative detail
view. It pulls convoy + subtask relationships via the standard task
API; there is no dedicated "convoy strip" component beyond
`ConvoyTab` today.

### 12.3 Workspace dashboard

`/api/products/[id]/workspaces` (route exists) backs the
"active workspaces for this product" panel; consumed by the product
detail UI.

---

## 13. Exhaustive MCP tool surface

All registered in `src/lib/mcp/groups/work.ts` unless noted.

| Tool                          | file:line                            | Role           | Purpose                                                          |
|-------------------------------|--------------------------------------|----------------|------------------------------------------------------------------|
| `spawn_subtask`               | `work.ts:1145`                       | coordinator    | Delegate a slice; lazy-creates / appends to convoy.              |
| `list_my_subtasks`            | `work.ts:1388`                       | coordinator    | Derived-state view of own delegations.                           |
| `update_subtask`              | `work.ts:1510`                       | coordinator    | `accept` / `reject` / `cancel`.                                  |
| `escalate_to_parent`          | `work.ts:767`                        | any peer       | Capability-denial escape hatch; bounces to coordinator/operator. |
| `submit_evidence`             | `work.ts:403`                        | peer           | Paste raw command output for an evidence gate.                   |
| `register_deliverable`        | `work.ts:337`                        | peer           | Record file/url/artifact; bumps subtask counter.                 |
| `update_task_status`          | `work.ts:543`                        | peer           | Transition status; convoy-aware coordinator notification.        |
| `fail_task`                   | `work.ts:692`                        | peer           | Stage failure; mails coordinator with `DELEGATION:` subject.     |
| `send_mail`                   | `work.ts:958`                        | any agent      | Mail another agent (push optional).                              |
| `fetch_mail`                  | `work.ts:317`                        | any agent      | Read own unread mail.                                            |
| `save_checkpoint`             | `work.ts:920`                        | any peer       | Save a `work_checkpoints` row.                                   |
| `get_task`                    | `work.ts:223`                        | any agent      | Reads task; appends `delegation_contract` for subtasks.          |
| `take_note`                   | `src/lib/mcp/groups/core.ts:353`     | any agent      | Notes — convoy-related observability.                            |
| `read_notes`                  | `core.ts:556`                        | any agent      | Read notes.                                                      |
| `log_activity`                | `core.ts:300`                        | any peer       | Heartbeat; feeds the SLO `last_activity_at` clock.               |
| `list_peers`                  | `core.ts:263`                        | any agent      | Roster lookup; used by coordinator to find `peer_gateway_id`.    |
| `whoami`                      | `core.ts:54`                         | any agent      | Self-identity.                                                   |
| `get_workspace_context`       | `core.ts:161`                        | any agent      | Workspace context.                                               |
| `register_subagent_dispatch`  | `work.ts:1584`                       | PM             | Phase J — distinct surface for openclaw `sessions_spawn`.        |

Deliberately removed: **`delegate`**. Test guard at
`src/lib/mcp/mcp.test.ts:90`.

Deliberately not added: **peer sub-delegation**. `spawn_subtask`
rejects when the caller's task has `is_subtask=1`
(`work.ts:1241-1257`).

---

## 14. Migrations (load-bearing)

| Migration | line range                      | Effect                                                                                 |
|-----------|---------------------------------|----------------------------------------------------------------------------------------|
| 020 `add_convoy_mode`            | `migrations.ts:673-819`        | Creates `convoys`, `convoy_subtasks`, `work_checkpoints`, `agent_mailbox`; adds `tasks.convoy_id`, `tasks.is_subtask`; adds `convoy_active` status. |
| 029 `add_parallel_build_isolation` | `migrations.ts:1297-1357`    | `tasks.workspace_path/_strategy/_port/_base_commit/_merge_status/_merge_pr_url`; `workspace_ports`; `workspace_merges`. |
| 030 `add_suggested_role_to_convoy_subtasks` | `migrations.ts:1682-1693` | Adds `convoy_subtasks.suggested_role`.                                                  |
| 032 `active_flag_and_general_mailbox_and_rollcall` | `migrations.ts:1736-1817` | Generalises `agent_mailbox` (`convoy_id` nullable, `task_id` added); creates `rollcall_sessions` + `rollcall_entries`. |
| 034 `convoy_resolve_symbolic_depends_on` | `migrations.ts:1850-1916` | Backfill: rewrites symbolic `subtask-N` deps to real task UUIDs.                       |
| 037 `coordinator_delegation_convoy` | `migrations.ts:2075-2167`  | SLO columns on `convoy_subtasks`; **drops** UNIQUE on `convoys.parent_task_id` (table rebuild via `writable_schema`); adds `'agent'` to `decomposition_strategy` CHECK; new `idx_convoys_parent_active`. |
| 091 `convoy_subtasks_required_evidence_gates` | `migrations.ts:4674-4687` | `convoy_subtasks.required_evidence_gates` (JSON array; NULL preserves legacy bypass).   |
| 092 `tasks_locked_for_completion` | `migrations.ts:4689-4702`      | `tasks.locked_for_completion` for capability-denial soft-lock.                          |

---

## 15. Configuration

| Env var                          | Default | Purpose                                                                 |
|----------------------------------|---------|-------------------------------------------------------------------------|
| `MC_CONVOY_MAX_PARALLEL`         | 10      | Convoy parallel dispatch cap (`convoy.ts:296-302`).                     |
| `PROJECTS_PATH`                  | —       | Where `workspace-isolation.ts` materialises task workspaces (`getProjectsPath`). |
| `MC_BACKUP_*`                    | —       | Unrelated to convoy directly but interacts with sandbox cleanup; see CLAUDE.md. |

Workspace strategy is determined purely by `task.repo_url` and active
siblings (see §5.1) — no env flag.

Per-task SLO values (`expected_duration_minutes`,
`checkin_interval_minutes`) are caller-supplied at `spawn_subtask` time
and bounded by the Zod schema (5..240 / 5..60).

`required_evidence_gates` defaults to `['test_full']` for new
subtasks (`convoy.ts:614`) and is operator-tunable by direct DB update
on a per-subtask basis. No env flag yet.

---

## 16. Known limitations / open questions

1. **Checkpoint driver coverage is light.** `work_checkpoints` table
   and helpers ship, but the auto-cron save + checkpoint-driven
   re-dispatch flow from the original convoy-mode-spec §9 is not the
   active recovery path. The per-subtask SLO scanner does the work
   instead. Either roll the checkpoint flow into the SLO recovery, or
   formally retire the table.
2. **Inter-agent mailbox UX is partial.** The convoy-scoped mailbox
   endpoints (`POST /api/convoy/{convoyId}/mail`) and per-convoy
   visibility view from convoy-mode-spec §10 are not the surface that
   ships. What ships is generalised `send_mail` + `rollcall_*`. Some
   `agent_mailbox` indexes exist for the original surface but the UI
   surfacing it doesn't.
3. **Multi-convoy-per-task UI.** Schema (after mig 037) supports
   multiple convoys per parent, but `ConvoyTab` and the operator
   endpoints still surface only "the active convoy" via
   `getActiveConvoyForTask`. Wave-1 / wave-2 stacked convoys would
   render only the latest.
4. **Workspace cleanup cron.** `cleanupWorkspace` exists but is called
   only on explicit merge / abandon. Long-lived stuck branches leave
   their `workspace_path` on disk indefinitely.
5. **`MCP-driven status changes do not always trigger orchestration.**
   `update_task_status` has the comment "MCP-driven status changes do
   NOT trigger automatic workflow orchestration (convoy progression,
   next-stage dispatch)" — partially mitigated by `handleStageTransition`
   wiring at `work.ts:602-635` but the broader convoy progression
   pipeline still relies on `transitionTaskStatus` being the entry
   point.
6. **`get_task` workspace gating is workspace-only.** A coordinator can
   `get_task` on any task in the same workspace; finer per-task ACLs
   are deliberate (see comment at `work.ts:233-238`) but worth
   reviewing if multi-tenant boundaries tighten.
7. **No depends-on validation across waves.** `spawn_subtask` accepts
   `depends_on_subtask_ids` but doesn't verify they belong to the
   active convoy; pre-37 work has already noted the dependency
   enforcer handles arbitrary DAGs inside one convoy, but cross-convoy
   refs would silently dead-block.

---

## 17. Appendix A — deltas from the three source specs

### From `convoy-mode-spec.md`

- **§7 task decomposition** — superseded. The operator-initiated AI
  decomposition path still exists (`/api/tasks/[id]/convoy/route.ts`)
  but the dominant path is `spawn_subtask` (agent-driven).
- **§8 agent health monitoring** — `agent_health` table exists and
  drives generic nudges, but the canonical per-subtask SLO scanner
  (§11) is the load-bearing layer.
- **§9 work-state persistence** — `work_checkpoints` ships; auto-save +
  zombie re-dispatch flow does not.
- **§10 inter-agent mailboxes** — `agent_mailbox` shipped; the
  convoy-scoped mailbox endpoints + injection UX did not. Generalised
  `send_mail` + roll-call replaced it.
- **Convoy uniqueness** — UNIQUE on `convoys.parent_task_id` dropped
  (mig 037).

### From `coordinator-delegation-via-convoy-spec.md`

- Shipped: `spawn_subtask`, `list_my_subtasks`, `update_subtask`
  (consolidated `accept_subtask` / `reject_subtask` / `cancel_subtask`
  into a single tool with `action`), `escalate_to_parent`, `delegate`
  removal, SLO columns, UNIQUE drop, `'agent'` strategy value,
  per-subtask Delegation Contract in the dispatch briefing.
- The dedicated `ask_operator` tool noted as "sibling proposal"
  is **not** in this spec — see autonomous-flow-tightening / other
  observability work for its status.
- `accept_subtask`, `reject_subtask`, `cancel_subtask` as named tools
  are NOT registered — they are subsumed by `update_subtask({action})`.

### From `parallel-build-isolation-spec.md`

- Shipped: `workspace_path`, `workspace_strategy`, `workspace_port`,
  `workspace_base_commit`, `merge_status`, `merge_pr_url`; the
  `workspace_ports` and `workspace_merges` tables; `createTaskWorkspace`
  with both `worktree` and `sandbox` strategies; auto-PR via
  `gh pr create` (worktree); rsync-back merge (sandbox); in-process
  merge lock; cleanup helpers.
- Strict-mode `resolveDispatchWorkspace` (`workspace-isolation.ts:170`)
  is the autonomous-flow-tightening enforcement that turns silent
  fallback into a 503/409 dispatch refusal.
- Workspace UI panel surface is partial — the dashboard endpoint
  ships but the rich conflict-resolution / per-workspace preview URLs
  from the original §10 are still "future considerations".

---

## 18. Appendix B — file index

Grouped by layer.

### Drivers / business logic

- `src/lib/convoy.ts` — convoy CRUD, `spawnDelegationSubtask`,
  `dispatchReadyConvoySubtasks`, `checkConvoyCompletion`.
- `src/lib/workspace-isolation.ts` — strategy detection, workspace
  creation, strict-mode resolution, merge, cleanup, port allocator.
- `src/lib/mailbox.ts` — `sendMail`, dispatch-formatting helpers.
- `src/lib/rollcall.ts` — `initiateRollCall`, reply matching,
  dispatch-formatting helpers.
- `src/lib/checkpoint.ts` — `work_checkpoints` driver.
- `src/lib/agent-health.ts` — generic per-agent health.
- `src/lib/stall-detection.ts` — per-subtask SLO scanner (drives
  drift/overdue/timeout transitions).
- `src/lib/task-governance.ts` — evidence-gate enforcement on subtask
  transitions (lines 105-138).
- `src/lib/services/task-status.ts` — `transitionTaskStatus`; convoy
  progress dispatch on subtask done (lines 256-303).
- `src/lib/dispatch/roster-gate.ts` — role gating, including
  convoy-aware union for `convoy_active` parents.
- `src/lib/workflow-engine.ts` — `getTaskWorkflow`,
  `populateTaskRolesFromAgents` used by `spawnDelegationSubtask`.

### MCP tools

- `src/lib/mcp/groups/work.ts` — every tool in §13 except
  `whoami / list_peers / log_activity / take_note / read_notes /
  get_workspace_context`.
- `src/lib/mcp/groups/core.ts` — the remaining tools above.
- `src/lib/mcp/mcp.test.ts` — surface tests; `delegate`-removal guard
  at line 90.

### Migrations

- `src/lib/db/migrations.ts` — see §14.

### HTTP routes

- `src/app/api/tasks/[id]/convoy/route.ts` — CRUD + AI decomposition.
- `src/app/api/tasks/[id]/convoy/subtasks/*` — operator subtask
  management.
- `src/app/api/tasks/[id]/convoy/dispatch/route.ts` — operator
  "dispatch all ready".
- `src/app/api/tasks/[id]/convoy/progress/route.ts` — progress poll.
- `src/app/api/convoy/[convoyId]/...` — convoy-id-keyed reads
  (mail / status).
- `src/app/api/tasks/[id]/workspace/route.ts` — workspace status.
- `src/app/api/products/[id]/workspaces/route.ts` — active workspaces
  for a product.
- `src/app/api/tasks/[id]/dispatch/route.ts` — Delegation Contract
  block rendered at `:864-907`; coordinator role block at `:646-697`.

### UI

- `src/components/ConvoyTab.tsx` — convoy tab inside `TaskModal`.
- `src/components/DependencyGraph.tsx` — DAG visualisation.
- `src/components/TaskModal.tsx` — hosts `ConvoyTab` (line 861).
- `src/app/(app)/initiatives/[id]/page.tsx` — initiative detail view.

### Agent templates

- `agent-templates/coordinator/` — `AGENTS.md`, `IDENTITY.md`,
  `SOUL.md`.

### Tests

- `src/lib/workspace-isolation.test.ts`
- `src/lib/task-governance.test.ts`
- `src/lib/dispatch/roster-gate.test.ts`
- `src/lib/mcp/mcp.test.ts`
- `src/lib/db/schema-cascade.test.ts`
