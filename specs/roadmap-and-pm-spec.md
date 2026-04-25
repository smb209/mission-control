# Roadmap & PM Agent — Project Planning Layer for Mission Control

**Version:** 0.2
**Date:** 2026-04-24
**Status:** Draft (awaiting operator sign-off)
**Repo:** smb209/mission-control

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Solution Overview](#2-solution-overview)
3. [Core Concepts](#3-core-concepts)
4. [Decomposition Rules](#4-decomposition-rules)
5. [Database Schema Changes](#5-database-schema-changes)
6. [Traceability & Re-parenting](#6-traceability--re-parenting)
7. [Date Semantics & Derived Schedule](#7-date-semantics--derived-schedule)
8. [Status Checks](#8-status-checks)
9. [PM Agent](#9-pm-agent)
10. [API Surface](#10-api-surface)
11. [MCP Surface](#11-mcp-surface)
12. [UI Surface](#12-ui-surface)
13. [Workflow Unification](#13-workflow-unification)
14. [Phased Delivery](#14-phased-delivery)
15. [Out of Scope](#15-out-of-scope)
16. [Open Questions](#16-open-questions)
17. [Acceptance Criteria](#17-acceptance-criteria)

---

## 1. Problem Statement

Mission Control today is excellent at **executing one task at a time**: Task → Plan → Execute → Deliver. It has no representation of work that lives *above* a task — milestones, epics, multi-task initiatives, dependencies that span tasks, target windows.

Three concrete gaps:

1. **No planning horizon.** Work that's a month out has no place to live except as a stale `idea` row or in the operator's head.
2. **No traceability after decomposition.** When a big initiative becomes ten tasks, the link from "this task" back to "this milestone" is lost.
3. **No discipline.** The hardest part of project management is keeping the schedule honest — re-estimating, re-sequencing, flagging slippage. Doing this manually is what kills every roadmap tool.

The execution board (current `tasks` table + Mission Queue UI) works. We need a **planning layer** above it, with an agent that maintains hygiene so the operator doesn't have to.

---

## 2. Solution Overview

Add a **planning layer** on top of the existing execution layer:

- **Initiatives**: a tree of planning units (themes, milestones, epics, stories). Initiatives carry target windows, owners, dependencies, effort estimates, and free-form status checks. Almost every field is optional — an initiative can be a one-line backlog idea.
- **Tasks-in-draft on the planning board**: tasks created from story decomposition live on the roadmap in a new `draft` status. They appear on the execution board (Mission Queue) only after explicit operator promotion.
- **Operator-driven promotion**: at every layer (idea → initiative, story → task draft, task draft → execution queue), promotion is an explicit operator action. Never automatic. Always atomic, one at a time.
- **PM agent**: a designated agent (role=`pm`) that maintains the roadmap. It re-estimates from velocity, flags drift, and responds to disruption events ("contractor out a week", "dependency delayed") with a *proposed diff* the operator can refine and accept.
- **Roadmap view**: a timeline UI showing initiatives, milestones, tasks (drafts and active), and dependency arrows.
- **MCP surface**: new tools on `sc-mission-control` so the PM agent (and any other agent) can read and manipulate the roadmap through MCP, not direct DB writes.

The execution board is unchanged. Tasks gain a single new pointer back to their owning initiative and a new `draft` status.

```
┌──────────────────────────────────────────────────────────────┐
│  PLANNING LAYER (new)                                        │
│                                                              │
│   Initiative tree → Tasks (draft) → Roadmap → PM agent       │
│                                                              │
└─────────────────┬─────────────────────────────────────────────┘
                  │  operator-driven promotion only
                  ▼  (sets task.status: draft → inbox)
┌──────────────────────────────────────────────────────────────┐
│  EXECUTION LAYER (existing)                                  │
│                                                              │
│   Tasks → Convoys → Agents → Deliverables                    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Core Concepts

### 3.1 Initiative

A node in the planning tree. Every initiative has a `kind`:

| Kind         | Meaning                                                                | Has children? |
| ------------ | ---------------------------------------------------------------------- | ------------- |
| `theme`      | Optional grouping above milestones (quarterly themes).                 | Yes           |
| `milestone`  | External commitment (launch date, customer demo). Has `committed_end`. | Usually yes   |
| `epic`       | Large body of work. Decomposes into stories.                           | Yes           |
| `story`      | Promotable unit of work. Becomes one or more task drafts.              | Rarely        |

`kind` is advisory for the UI — the data model doesn't enforce hierarchy depth. An operator can put a `story` directly under a `milestone` (skipping `epic`) or convert a `story` to an `epic` when scope grows (`kind` is mutable).

**All fields except `id`, `workspace_id`, `kind`, and `title` are optional.** An initiative can be a one-line idea on a backlog with nothing else filled in. The PM and operator fill in details over time.

### 3.2 Task draft (planning-board task)

A task with `status='draft'`. Created when an operator decomposes a story into work units. Lives only on the roadmap until explicitly promoted to `inbox`. From `inbox` onward, the existing execution pipeline takes over unchanged.

A task in `draft` has a populated `initiative_id`. After promotion, the `initiative_id` stays — provenance is preserved through the entire lifecycle.

### 3.3 Promotion (operator-driven, atomic)

There are three promotion edges, all manual, all one-at-a-time:

| From            | To                  | Effect                                                  |
| --------------- | ------------------- | ------------------------------------------------------- |
| `idea`          | `initiative`        | Creates initiative with `source_idea_id`. Idea remains. |
| `initiative` (story) | `task` (draft) | Creates one task in `status='draft'` linked to initiative. |
| `task` (draft)  | `task` (inbox)      | Transitions status. Now visible on Mission Queue.       |

Each is one click, one DB row created or one status flipped. Bulk versions deferred to v2.

### 3.4 Disruption

A free-text event the operator drops on the PM: "Sarah out next week", "API X delayed 9 days", "We're cutting Phase 2 from the launch". The PM turns it into an impact analysis + proposed diff. (See §9.)

---

## 4. Decomposition Rules

This section defines how the planning tree behaves when items are decomposed, re-parented, or have their dependencies adjusted. Conventions follow standard agile / Linear / Jira semantics.

### 4.1 Containers persist

Decomposing an epic into stories, or a story into substories, **does not delete the parent**. The parent becomes a container. Its status rolls up from descendants (§7.3). The parent retains:

- Its own description, dates, owner, status check, and dependencies.
- All audit history.
- All references from other initiatives that depend on it.

A container with zero descendants behaves as a leaf — it can still be promoted (if `kind='story'`), still has its own dates, still gets scheduled.

### 4.2 Dependencies attach at the declared level

If "Story C depends on Story 2", that edge lives on `(C, 2)` in `initiative_dependencies`. If Story 2 is later decomposed into 2.1 and 2.2, **the edge stays on Story 2**. Story C unblocks when Story 2 (the container) reaches `done`, which by rollup means all of 2's descendants are `done`.

If the operator wants finer granularity ("C only needs 2.1, not 2.2"), they explicitly:

1. Delete the `C → 2` dependency.
2. Add a `C → 2.1` dependency.

Dependency edges are intentional declarations; we never auto-rewrite them. This is the standard Jira / Linear behavior and avoids surprising edge cascades during decomposition.

### 4.3 Multiple prerequisites

`initiative_dependencies` is many-to-many. If "C blocks on A and B", that's two rows: `(C, A)` and `(C, B)`. The derivation algorithm (§7.2) takes the max end date across all prerequisites when computing C's `derived_start`.

### 4.4 Two distinct mutation operations

| Operation   | What it does                                                | Reversible?                          |
| ----------- | ----------------------------------------------------------- | ------------------------------------ |
| **Decompose** | Add children under an initiative; parent stays as container. Optional `kind` change (e.g. story → epic when adding sub-stories). | Yes (delete children).               |
| **Convert**   | Change an initiative's `kind` without adding children. Used when scope grew but you haven't broken it down yet. | Yes (change kind back). |

A "split" operation (replace one item with N items) is intentionally **not** a primitive. If you want to "split" a story, you `convert` it to an epic and `decompose` it into stories. The original identity is preserved as the container, dependencies and history intact.

### 4.5 Re-parenting tasks across initiatives

Tasks (drafts and active) can be moved between initiatives at any time. Every move appends a row to `task_initiative_history` with operator, timestamp, and reason. Active tasks (status beyond `inbox`) can also be re-parented — provenance is maintained even mid-execution. (See §6.)

### 4.6 Cancellation cascade

- **Initiative cancelled:** child initiatives and tasks are *not* auto-cancelled. Operator decides per-child via UI prompt.
- **Initiative deleted:** blocked if any descendant initiative or task references it. Operator must re-parent or cancel descendants first.
- **Task archived/cancelled:** `initiative_id` retained for provenance.

---

## 5. Database Schema Changes

### 5.1 New tables

```sql
-- Planning-layer nodes. Forms a tree via parent_initiative_id.
-- Almost every column is nullable; an initiative can be a one-line backlog item.
CREATE TABLE initiatives (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  product_id TEXT REFERENCES products(id),
  parent_initiative_id TEXT REFERENCES initiatives(id),
  kind TEXT NOT NULL CHECK (kind IN ('theme','milestone','epic','story')),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','in_progress','at_risk','blocked','done','cancelled')),
  owner_agent_id TEXT REFERENCES agents(id),

  -- Optional sizing / effort
  estimated_effort_hours REAL,
  complexity TEXT CHECK (complexity IN ('S','M','L','XL')),

  -- Optional date semantics (see §7)
  target_start TEXT,
  target_end TEXT,
  derived_start TEXT,
  derived_end TEXT,
  committed_end TEXT,

  -- Optional status check (§8) — freeform v1
  status_check_md TEXT,

  sort_order INTEGER DEFAULT 0,
  source_idea_id TEXT REFERENCES ideas(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Cross-initiative dependencies (DAG). Many-to-many; an initiative can have
-- multiple prerequisites (A and B blocking C is two rows here).
CREATE TABLE initiative_dependencies (
  id TEXT PRIMARY KEY,
  initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  depends_on_initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'finish_to_start'
    CHECK (kind IN ('finish_to_start','start_to_start','blocking','informational')),
  note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(initiative_id, depends_on_initiative_id)
);

-- Audit log of every initiative-tree move (parent change).
CREATE TABLE initiative_parent_history (
  id TEXT PRIMARY KEY,
  initiative_id TEXT NOT NULL REFERENCES initiatives(id) ON DELETE CASCADE,
  from_parent_id TEXT REFERENCES initiatives(id),
  to_parent_id TEXT REFERENCES initiatives(id),
  moved_by_agent_id TEXT REFERENCES agents(id),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit log of every task re-parent. First row for each task has
-- from_initiative_id = NULL (creation/initial promotion).
CREATE TABLE task_initiative_history (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_initiative_id TEXT REFERENCES initiatives(id),
  to_initiative_id TEXT REFERENCES initiatives(id),
  moved_by_agent_id TEXT REFERENCES agents(id),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Owner availability windows (PM impact analysis input).
CREATE TABLE owner_availability (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  unavailable_start TEXT NOT NULL,
  unavailable_end TEXT NOT NULL,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- PM proposal artifacts. Mirrors planning_specs pattern.
CREATE TABLE pm_proposals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  trigger_text TEXT NOT NULL,
  trigger_kind TEXT NOT NULL DEFAULT 'manual'
    CHECK (trigger_kind IN ('manual','scheduled_drift_scan','disruption_event','status_check_investigation')),
  impact_md TEXT NOT NULL,
  proposed_changes TEXT NOT NULL,                 -- JSON array of typed diffs
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','accepted','rejected','superseded')),
  applied_at TEXT,
  applied_by_agent_id TEXT REFERENCES agents(id),
  parent_proposal_id TEXT REFERENCES pm_proposals(id),
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 5.2 Changes to existing tables

```sql
-- tasks: add initiative pointer + 'draft' status + status check.
ALTER TABLE tasks ADD COLUMN initiative_id TEXT REFERENCES initiatives(id);
ALTER TABLE tasks ADD COLUMN status_check_md TEXT;
-- Status CHECK constraint extended to include 'draft'. SQLite can't ALTER
-- a CHECK in place, so the migration uses the existing table-rebuild
-- helper pattern in migrations.ts (CREATE _new, copy, drop, rename).

-- ideas: optional path to promote idea → initiative.
ALTER TABLE ideas ADD COLUMN initiative_id TEXT REFERENCES initiatives(id);
```

### 5.3 Indexes

```sql
CREATE INDEX idx_initiatives_workspace ON initiatives(workspace_id);
CREATE INDEX idx_initiatives_parent ON initiatives(parent_initiative_id);
CREATE INDEX idx_initiatives_product ON initiatives(product_id);
CREATE INDEX idx_initiatives_status ON initiatives(status);
CREATE INDEX idx_initiatives_target_window ON initiatives(target_start, target_end);
CREATE INDEX idx_initiative_deps_from ON initiative_dependencies(initiative_id);
CREATE INDEX idx_initiative_deps_to ON initiative_dependencies(depends_on_initiative_id);
CREATE INDEX idx_task_initiative_history_task ON task_initiative_history(task_id, created_at);
CREATE INDEX idx_initiative_parent_history ON initiative_parent_history(initiative_id, created_at);
CREATE INDEX idx_owner_availability_agent ON owner_availability(agent_id, unavailable_start);
CREATE INDEX idx_tasks_initiative ON tasks(initiative_id);
CREATE INDEX idx_tasks_draft ON tasks(status, initiative_id) WHERE status='draft';
CREATE INDEX idx_pm_proposals_status ON pm_proposals(status, created_at DESC);
```

---

## 6. Traceability & Re-parenting

### 6.1 Provenance model

Two pointers, two audit logs:

| What             | Current state                  | History                          |
| ---------------- | ------------------------------ | -------------------------------- |
| Initiative tree  | `initiatives.parent_initiative_id` | `initiative_parent_history` |
| Task → initiative | `tasks.initiative_id`         | `task_initiative_history`        |

**Invariant:** every task that was ever linked to an initiative has at least one row in `task_initiative_history`. The first row's `from_initiative_id` is `NULL`. The latest row's `to_initiative_id` matches the current `tasks.initiative_id`.

This gives:

- "Where did this task come from?" → first audit row.
- "Where does it live now?" → `tasks.initiative_id`.
- "Has it been re-scoped?" → audit row count > 1.
- "Why did it move?" → `reason` on the audit row.

### 6.2 Re-parenting operations

All operator-driven, all audited:

1. **Move a task to a different initiative.** Updates `tasks.initiative_id`, appends `task_initiative_history` row. Allowed at any task status, including mid-execution.
2. **Move an initiative subtree.** Updates `initiatives.parent_initiative_id` for the moved node. Descendant initiatives and their tasks come along automatically (relationship is parent-pointer, no rewrite). Audit row on the moved node.
3. **Detach a task.** `tasks.initiative_id = NULL`, audit row, UI flags as "orphaned".
4. **Bulk move tasks.** v2; v1 is one at a time per the atomic-promotion rule.

### 6.3 Re-scoping example

> Initiative A "Build big feature" has tasks T1, T2, T3. Operator decides T3 belongs to a new initiative C "Phase 2 polish".

1. Operator creates initiative C as sibling of A.
2. Roadmap or task detail → "Move to initiative" → C, reason "Deferred to phase 2".
3. `tasks.initiative_id` for T3 changes A → C. Audit row appended.
4. Schedule re-derives nightly: A's `derived_end` likely earlier, C's later.
5. PM's next drift scan posts a "schedule shifted" card if it crosses thresholds.

---

## 7. Date Semantics & Derived Schedule

### 7.1 Three optional date pairs

| Field             | Set by                  | Mutable? | Meaning                                           |
| ----------------- | ----------------------- | -------- | ------------------------------------------------- |
| `target_start/end`| Operator                | Yes      | Operator's intent. Movable freely.                |
| `derived_start/end`| PM (computed)          | Read-only| Schedule from velocity + dep graph + availability. |
| `committed_end`   | Operator (milestones)   | Rarely   | External commitment. Alarms when derived > committed. |

All optional. An initiative with no dates renders on the roadmap as a "no date set" row — useful for backlog entries.

### 7.2 Derivation algorithm (initial)

Run nightly via `product_schedules` (new schedule_type `roadmap_drift_scan`):

1. **Velocity model:** per-owner average `actual / estimated` ratio from completed tasks in last N days. Default 1.0 if no history.
2. **Effective effort:** `estimated_effort_hours / velocity_ratio`. For containers, sum descendants. If neither effort nor complexity is set, exclude from derivation rather than guessing.
3. **Critical path:** topological sort over `initiative_dependencies`. `derived_start = max(deps' derived_end, target_start, today)`.
4. **Availability:** subtract overlapping `owner_availability` windows from the effort calendar.
5. **Slippage flag:** if `derived_end > committed_end`, set status `at_risk`. If gap exceeds threshold, surface in PM's morning card.

Keep simple in v1 — no resource leveling, no parallel-effort discounting. PM narrates the gap; operator decides.

### 7.3 Status roll-up

Initiative status is derived from descendants:

- All descendants `done` → `done`
- Any descendant `in_progress` / `convoy_active` / etc. → `in_progress`
- Any descendant `at_risk` → `at_risk`
- Any descendant `blocked` → `blocked`
- Otherwise → `planned`

Operator override deferred to v2 (would require `status_override` column).

---

## 8. Status Checks

Every initiative and every task gets an optional `status_check_md` text field. Freeform in v1. Examples:

> Linked PR https://github.com/foo/bar/pull/42 — needs review
> Email thread with vendor; awaiting reply by Apr 30
> Customer demo on calendar Apr 30 14:00 MT
> Run `pnpm test:smoke` against staging

The PM agent reads this field as part of impact analysis (e.g. when computing whether a milestone is realistically on track). v2 (out of scope here) adds:

- `status_check_url` for actionable links the agent can fetch.
- `status_check_last_checked_at` / `status_check_last_result` for periodic investigation.
- A "status check investigation" PM action that fetches URLs / parses GitHub / etc. and posts a proposal if state has shifted.

For v1, the field exists, the PM reads it as context, and the operator manually updates it.

---

## 9. PM Agent

### 9.1 Identity

A new agent role: **`pm`**. Distinct from the existing `coordinator` (which handles task-level decomposition into convoys) and `master` (which orchestrates execution). One PM agent per workspace, auto-seeded by migration.

| Role          | Scope                                | Layer       |
| ------------- | ------------------------------------ | ----------- |
| `pm`          | Roadmap, initiatives, schedule       | Planning    |
| `coordinator` | Task decomposition into convoys      | Planning ↔ Execution |
| `master`      | Multi-agent orchestration            | Execution   |
| Workers       | Individual tasks                     | Execution   |

Reuses existing `agents` infrastructure: chat (`agent_chat_messages`), mailbox (`agent_mailbox`), sessions (`openclaw_sessions`).

### 9.2 Two operating modes

**Reactive (operator-triggered):**

1. Operator opens PM chat (`/pm` route, reuses `agent_chat_messages`).
2. Drops a disruption: "Sarah out 9 days, dep Y delayed til May 3".
3. PM:
   - Parses dates / owner names / initiative refs from text.
   - Stages proposed `owner_availability` rows (not yet committed).
   - Runs derivation with the staged changes layered on.
   - Generates `impact_md` + `proposed_changes` JSON.
4. Persists `pm_proposals` row (status=`draft`), posts a chat message linking to it.
5. Operator can:
   - **Refine** ("don't slip the launch milestone, defer analytics instead") → new proposal with `parent_proposal_id`.
   - **Accept** → applies diff in one transaction. Marks proposal `accepted`.
   - **Reject** → marks `rejected`.

**Proactive (scheduled):**

1. New `product_schedules.schedule_type='roadmap_drift_scan'` runs each morning.
2. PM scans all initiatives, recomputes derivation, identifies drift.
3. If drift exists, posts a "morning standup" proposal (trigger_kind=`scheduled_drift_scan`).

### 9.3 Proposed-changes format

`pm_proposals.proposed_changes` is a JSON array of typed diffs:

```jsonc
[
  { "kind": "shift_initiative_target", "initiative_id": "...", "target_end": "2026-05-12", "reason": "..." },
  { "kind": "add_availability", "agent_id": "...", "start": "...", "end": "...", "reason": "..." },
  { "kind": "set_initiative_status", "initiative_id": "...", "status": "at_risk" },
  { "kind": "add_dependency", "initiative_id": "...", "depends_on_initiative_id": "...", "note": "..." },
  { "kind": "remove_dependency", "dependency_id": "..." },
  { "kind": "reorder_initiatives", "parent_id": "...", "child_ids_in_order": ["..."] },
  { "kind": "update_status_check", "initiative_id": "...", "status_check_md": "..." }
]
```

Apply is a single transaction. v1 is all-or-nothing accept; partial accept (per-diff checkboxes) deferred to v2.

### 9.4 What the PM never does

- **Never** promotes ideas → initiatives, stories → tasks, drafts → inbox. All promotion is operator-driven.
- **Never** dispatches tasks.
- **Never** edits `tasks.status` for active tasks (anything beyond `draft`/`inbox`).
- **Never** writes `derived_*` outside the nightly scan.

The PM is a *suggester*, not an actor on the execution board. **Note for `plan_initiative` (§9.5):** plan-initiative proposals are explicitly advisory — `acceptProposal` is a no-op for that trigger_kind. The operator applies the suggestions client-side by populating the new-initiative form. The proposal exists only for audit + the refine chain. (Decompose proposals, by contrast, DO mutate state on accept.)

### 9.5 Guided modes (Polish B)

In addition to the reactive disruption flow, the PM has two operator-driven guided modes. Both reuse the proposal lifecycle (draft → refine* → accept/reject) and the same MCP tools, but specialize the synthesizer:

**Plan an initiative draft** — `trigger_kind='plan_initiative'`. Operator drafts an initiative (title + rough description) and asks the PM for a refined description, suggested complexity, suggested target window, and candidate dependencies surfaced from existing workspace initiatives by keyword overlap. Output is a single advisory proposal: `acceptProposal` is a no-op for this trigger_kind, and `proposed_changes` stays empty. The structured suggestions are returned in the API response and embedded in `impact_md` as an HTML-comment JSON sidecar so the refine endpoint can return them too. The operator applies the suggestions by populating the create-initiative form before clicking Save.

**Decompose an existing epic/milestone** — `trigger_kind='decompose_initiative'`. Operator picks an existing epic or milestone (story-kind initiatives are not decomposable). The PM proposes 3-7 child initiatives (story-kind by default; epic allowed; theme/milestone forbidden as `child_kind`). Each child carries a brief description, a complexity estimate, a `sort_order`, and optional `depends_on_initiative_ids`. Sibling pre-wiring uses placeholder ids (`$0`, `$1`, …) that resolve to the freshly-inserted real ids during the second pass of `acceptProposal`. On accept: children are inserted under the parent in a single transaction with matching `initiative_parent_history` rows (`reason='created via PM decompose proposal #<id>'`).

**New diff kind** — `create_child_initiative`. Only emitted from `decompose_initiative` proposals. Validation rejects `child_kind='theme'` or `'milestone'`.

UI surface: a "Plan with PM" button next to Save in the initiative edit drawer; a "Decompose with PM" entry in the `⋮` action menu (epic/milestone rows) and a button on `/initiatives/[id]` for the same kinds. Both flows use the existing refine endpoint.

---

## 10. API Surface

New Next.js route handlers under `src/app/api/`:

| Method | Path                                                  | Purpose                                          |
| ------ | ----------------------------------------------------- | ------------------------------------------------ |
| GET    | `/api/initiatives`                                    | List (filter: workspace, product, parent, status, kind) |
| POST   | `/api/initiatives`                                    | Create initiative                                |
| GET    | `/api/initiatives/[id]`                               | Get one (children + tasks on demand)             |
| PATCH  | `/api/initiatives/[id]`                               | Update any field (kind, dates, status_check_md, etc.) |
| POST   | `/api/initiatives/[id]/move`                          | Re-parent (audit row)                            |
| POST   | `/api/initiatives/[id]/convert`                       | Change `kind` (story → epic, etc.)               |
| POST   | `/api/initiatives/[id]/promote-to-task`               | Create one task in `status='draft'`              |
| DELETE | `/api/initiatives/[id]`                               | Blocked if descendants exist                     |
| POST   | `/api/initiatives/[id]/dependencies`                  | Add dependency edge                              |
| DELETE | `/api/initiative-dependencies/[depId]`                | Remove edge                                      |
| GET    | `/api/initiatives/[id]/history`                       | Parent-change history                            |
| POST   | `/api/tasks/[id]/move-initiative`                     | Re-parent task (audit row)                       |
| POST   | `/api/tasks/[id]/promote`                             | `draft` → `inbox` (the execution-board promotion) |
| GET    | `/api/tasks/[id]/initiative-history`                  | Task provenance trail                            |
| POST   | `/api/ideas/[id]/promote-to-initiative`               | Sibling of existing idea→task path               |
| POST   | `/api/pm/proposals`                                   | Operator drops disruption → draft proposal      |
| GET    | `/api/pm/proposals`                                   | List (filter status)                             |
| POST   | `/api/pm/proposals/[id]/refine`                       | Re-prompt with constraint                        |
| POST   | `/api/pm/proposals/[id]/accept`                       | Apply diff transactionally                       |
| POST   | `/api/pm/proposals/[id]/reject`                       | Mark rejected                                    |
| GET    | `/api/roadmap`                                        | Aggregated timeline data                         |
| POST   | `/api/owner-availability`                             | Operator-managed availability                    |
| GET    | `/api/owner-availability`                             | List (filter agent, window)                      |
| DELETE | `/api/owner-availability/[id]`                        | Remove                                           |

---

## 11. MCP Surface

The `sc-mission-control` MCP server (used by openclaw workers and the PM agent) gains new tools, mirroring the API. The PM agent acts through these tools, not direct DB writes — keeps the audit story uniform and gives every other agent the same affordances.

### 11.1 Read tools

- `list_initiatives({ workspace_id?, product_id?, parent_id?, status?, kind? })`
- `get_initiative({ id, include_descendants?, include_tasks? })`
- `get_initiative_tree({ workspace_id, root_id? })` — full tree for PM context
- `get_roadmap_snapshot({ workspace_id })` — flattened initiatives + tasks + deps + availability for derivation
- `get_initiative_history({ id })`
- `get_task_initiative_history({ task_id })`
- `list_owner_availability({ agent_id?, between_start?, between_end? })`
- `get_velocity_data({ owner_agent_id?, since? })`

### 11.2 Write tools (general — gated by persona)

- `create_initiative(...)`
- `update_initiative({ id, ... })`
- `move_initiative({ id, to_parent_id, reason })`
- `convert_initiative({ id, new_kind })`
- `add_initiative_dependency({ initiative_id, depends_on_id, kind?, note? })`
- `remove_initiative_dependency({ dependency_id })`
- `move_task_to_initiative({ task_id, to_initiative_id, reason })`
- `promote_initiative_to_task({ initiative_id, task_title, task_description? })` — creates draft
- `promote_task_to_inbox({ task_id })` — draft → inbox
- `add_owner_availability({ agent_id, start, end, reason })`

### 11.3 PM-specific tools

- `propose_changes({ trigger_text, trigger_kind, impact_md, changes: [...] })` — creates a `pm_proposals` row in `draft`. **This is the PM's primary write path.**
- `refine_proposal({ proposal_id, additional_constraint })` — generates a new proposal with `parent_proposal_id` set.
- `list_proposals({ status?, since? })`

The PM's persona prompt instructs: "to make changes, call `propose_changes`. Never call write tools directly except to record availability the operator explicitly stated."

---

## 12. UI Surface

### 12.1 New routes

- `/roadmap` — timeline view per workspace (filter by product).
- `/initiatives/[id]` — initiative detail (children, tasks, deps, dates, history, status check).
- `/pm` — PM chat thread + active proposal cards.
- `/backlog` — flat list of initiatives with no parent and no dates (idea-stage planning items).

### 12.2 Roadmap view

- Rows are initiatives, indented by parent.
- Bars: `target_start..target_end` (solid), `derived_start..derived_end` (outline). Gap = schedule debt.
- Milestones rendered as diamonds with `committed_end`.
- Dependency arrows between bars.
- Tasks as chips on their initiative row, colored by status (draft = ghost outline; inbox/active = filled).
- Drag handles adjust `target_*`. `derived_*` is read-only.
- Buttons: "Decompose", "Convert", "Promote to task", "Move", "Add dependency".

### 12.3 PM chat

Reuse the agent chat component. Card renderer for messages with `metadata.proposal_id`:

```
┌───────────────────────────────────────────────────┐
│ ⚠ Schedule impact: Launch milestone slips 5d      │
│                                                   │
│ • "Build big feature" target_end → May 17         │
│ • "Customer demo" milestone at_risk               │
│ • Adds availability: Sarah out Apr 25 – May 2     │
│                                                   │
│ [Refine]  [Accept]  [Reject]                      │
└───────────────────────────────────────────────────┘
```

---

## 13. Workflow Unification

This feature touches three pre-existing flows. Unification opportunities:

### 13.1 Idea promotion paths

| Path                    | Today                | After this spec                       |
| ----------------------- | -------------------- | ------------------------------------- |
| Idea → task (autopilot) | Yes (`product_autopilot`) | Unchanged                       |
| Idea → initiative       | None                 | New: `POST /api/ideas/[id]/promote-to-initiative` |
| Idea → initiative → task| Implicit             | Recommended for non-autopilot work    |

The autopilot path is preserved for products with build automation. Manual / planning-driven flows go through initiatives. Both result in `tasks` rows; the difference is whether they cross the planning layer first.

### 13.2 Tasks: planning-board ↔ execution-board (one source of truth)

A task always lives in one row; surfaces filter by status:

| `tasks.status` | On planning board (Roadmap)? | On execution board (Mission Queue)? |
| -------------- | ---------------------------- | ----------------------------------- |
| `draft`        | ✅ (under initiative)        | ❌                                  |
| `inbox`        | ✅ (if `initiative_id` set)  | ✅                                  |
| beyond inbox   | ✅ (if `initiative_id` set)  | ✅                                  |

Roadmap shows all tasks with `initiative_id`. Mission Queue shows all tasks with `status != 'draft'`. One table, two views — no duplicated state.

### 13.3 Convoys vs initiative decomposition

These are **different layers** and stay separate:

- **Convoy**: ephemeral, parallel execution under one task, agents work concurrently.
- **Initiative decomposition**: persistent planning structure, manual promotion to tasks.

A convoy is a mid-flight task-level concern. An initiative tree is a long-lived planning concern. Don't conflate.

---

## 14. Phased Delivery

Each phase is a separate PR, demoable.

### Phase 1: Schema + provenance bones

- Migration: `initiatives`, `initiative_dependencies`, `initiative_parent_history`, `task_initiative_history`, `owner_availability`, `pm_proposals`, plus `tasks.initiative_id`, `tasks.status_check_md`, extend `tasks.status` CHECK to include `'draft'`, `ideas.initiative_id`.
- Update `src/lib/db/schema.ts`.
- DB helpers in `src/lib/db/initiatives.ts` and `src/lib/db/pm.ts`.
- API: GET/POST/PATCH/DELETE `/api/initiatives`, move, convert, history, dependencies.
- Minimal `/initiatives` page: tree list with create/edit/delete and parent picker.
- Tests: re-parent writes audit; delete-with-descendants blocked; multi-prereq deps; container retention through decompose.

**Done means:** initiative tree exists, every move audited, no UI past basic list.

### Phase 2: Promotion + initiative-aware task UI

- "Promote initiative to task" endpoint (creates `status='draft'` task).
- "Promote task to inbox" endpoint (draft → inbox).
- Idea → initiative endpoint.
- Task detail shows owning initiative + provenance trail.
- "Move to initiative" affordance.
- `/initiatives/[id]` detail page with children + tasks.

**Done means:** end-to-end manual flow: idea → promote → initiative → decompose → promote story to task draft → promote draft to inbox → existing pipeline runs.

### Phase 3: Roadmap timeline view

- `/api/roadmap` aggregated endpoint.
- `/roadmap` page (lightweight Gantt; lib decision during impl).
- Drag target-date adjustment, dependency arrows, status colors, draft-task chips.
- Filters: workspace, product, owner, kind.

**Done means:** visual planning surface; timelines visible; drift gap renders once Phase 4 lands.

### Phase 4: Derivation engine + drift scan

- Velocity computation from completed tasks.
- Critical-path solver over deps + availability.
- New `roadmap_drift_scan` schedule_type.
- Background job updating `derived_*` and flagging `at_risk`.

**Done means:** schedule moves on its own; slippage visible without operator action.

### Phase 5: PM agent (reactive) + MCP surface

- Seed `pm` agent (workspace migration).
- MCP tools (§11) added to `sc-mission-control`.
- PM dispatch path: disruption text + roadmap snapshot → `propose_changes` MCP call → `pm_proposals` row.
- `/pm` chat UI with proposal-card renderer.
- Refine loop (parent_proposal_id chain).

**Done means:** type "Sarah out next week" → impact analysis → refine → accept → roadmap updates.

### Phase 6: PM agent (proactive)

- Wire `roadmap_drift_scan` schedule to the PM.
- Morning-standup proposal generation.
- Event feed integration.

**Done means:** without prompting, PM posts a daily card if anything's drifting.

**Phase 6 implementation notes (post-merge):**

- Standup synthesis lives in `src/lib/agents/pm-standup.ts` (`generateStandup`).
  Deterministic — given the same snapshot + `today` anchor, the same diff list comes out.
- Idempotency uses the `(YYYY-MM-DD)` stamp embedded in `trigger_text` (not
  `created_at`) so a re-run with the same logical day correctly returns the
  existing draft. The `force=true` flag bypasses this for "Run standup now".
- Drift signals: milestone_at_risk, slippage (>3d), stale_blocked (≥3d idle),
  stale_in_progress (≥7d idle), cycle_detected. Cycle members never receive
  date-shift diffs.
- Schedule seeding chosen: **Option A** — migration `046_seed_roadmap_drift_scan_schedules`
  inserts a per-workspace cron (`0 9 * * 1-5` MT) on the workspace's oldest
  active product. Workspaces without a product are skipped — operators can
  trigger via `POST /api/pm/standup` instead.
- Two new event types: `pm_standup_generated` (with proposal_id) and
  `pm_standup_skipped` (silent runs). Both surface in `LiveFeed` with deep
  links into `/pm?proposal=…` (standup) or `/roadmap` (drift scan).
- `/pm` page additions: pinned-standup banner, "Run standup" toolbar
  button, `?proposal=<id>` deep-link auto-scroll + highlight, trigger_kind
  badge on every proposal card.
- The PM still never auto-applies — every standup proposal is `draft`
  awaiting operator accept.

---

## 15. Out of Scope (v1)

- **Bulk operations** (multi-task promotion, multi-task move). All atomic in v1.
- **Resource leveling / capacity planning** beyond simple availability.
- **Cross-workspace roadmaps.**
- **Permissions / multi-operator conflict resolution.**
- **Burndown charts, velocity dashboards** (the roadmap is the chart).
- **External calendar / Linear / GitHub Projects sync.**
- **Auto-promotion** at any layer — explicitly excluded.
- **Status-check investigation by PM** (fetching URLs, parsing PRs). Field exists; investigation is v2.
- **Partial-accept of PM proposals** (per-diff checkboxes). v1 is all-or-nothing.

---

## 16. Open Questions

1. **Velocity unit when estimates are missing.** Lean: complexity → hours fallback table (`S=4`, `M=12`, `L=40`, `XL=120`), operator-overridable per workspace. If neither is set, exclude from derivation rather than guessing.

2. **PM agent identity / model.** Auto-seed via migration, idempotent. Use Claude Opus 4.7 with planning-layer system prompt. Distinct from coordinator and master.

3. **Status override on initiatives.** Defer; if rollup proves wrong in practice, add `status_override` in Phase 4.

4. **Backlog UI.** A `/backlog` flat view for initiatives with no parent and no dates is included in Phase 2 — confirm scope.

5. **Convert operation vs `kind` PATCH.** A dedicated `/convert` endpoint exists for clarity in audit logs, but mechanically it's a `kind` change. **Resolved (post-Phase 1):** keep `/convert` as the operator-facing endpoint; convert emits a row in the existing `events` table with `type='initiative_kind_changed'` (no new audit table). PATCH on `kind` is allowed but discouraged and does not emit the event.

6. **`parent_id` query param semantics on `GET /api/initiatives`.** **Resolved (post-Phase 1):** missing = no filter; literal string `"null"` = roots only (parent_initiative_id IS NULL); any other value = exact match.

---

## 17. Acceptance Criteria

Each phase ships only when:

- ✅ Migration runs cleanly on a current production DB snapshot.
- ✅ Existing task pipeline is unaffected (no regressions on the execution board).
- ✅ All new tables have indexes per §5.3.
- ✅ A scripted demo walks the phase's "done means" scenario end-to-end.
- ✅ Operator can recover from any botched action (every mutation reversible).
- ✅ For phases with PM/MCP work: agent never bypasses `propose_changes` for non-availability writes.
