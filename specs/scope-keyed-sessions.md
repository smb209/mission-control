# Scope-Keyed Sessions — End of Durable Worker Agents

## Why

Today MC has long-lived gateway-synced agents per role per workspace
(`mc-builder-dev`, `mc-tester-dev`, `mc-coordinator-dev`, `mc-pm-dev`,
etc.). PR #133 made the gateway agent identity org-wide so operators
could clone agent rosters between workspaces. The unintended downstream
effects make this design indefensible:

1. **Workspace ambiguity (the bug we just fixed).** A shared
   `gateway_agent_id` legitimately maps to N workspace rows after
   cloning, so `whoami({ agent_id: gateway_id })` returns
   `ambiguous_gateway_id` ([tools.ts:172](../src/lib/mcp/tools.ts:172)),
   the agent stalls hunting for its UUID, the PM dispatch reconciler
   times out, and every PM Chat reply falls back to the synth-only
   placeholder ([pm-dispatch.ts:329](../src/lib/agents/pm-dispatch.ts:329)).
   Fixed by [pm-dispatch.ts:140](../src/lib/agents/pm-dispatch.ts:140) embedding the UUID, but the fix is a workaround for a deeper architectural mistake.
2. **Session memory is mostly noise.** The PM dispatch session log shows
   the agent reading old heartbeat memos trying to find its own UUID.
   The real load-bearing state — deliverables, prior outcomes, task
   history, learner snapshots — already lives in MC's database.
   Per-agent openclaw session memory is an inferior place to store it:
   per-machine, lossy via compaction, opaque, unqueryable.
3. **Cross-workspace continuity is incoherent.** Drift detection
   ([pm-standup.ts:142](../src/lib/agents/pm-standup.ts:142)) is a pure
   function over the snapshot. Cross-task patterns (velocity, stall
   detection, learner) are MC-resident. Nothing in MC actually depends
   on agent-side session memory for cross-task reasoning. The "PM has
   continuity" argument is a story we tell ourselves; the code disagrees.
4. **Observability is poor.** Operators can see *what* an agent did
   (deliverables, status changes), not *what it noticed, decided, or
   struggled with* — that lives in session memory the operator can't
   query. The notes spine in this spec is the load-bearing fix.

The reframing: **everyone is scope-keyed**. No durable agents. Every
session has a name (the `sessionKey`) that encodes the work it's doing.
Resume comes free from openclaw's trajectory replay; sessions never
"die" — they're inactive until the next dispatch with the same key.

## Goals

- Eliminate the `gateway_agent_id` ambiguity class entirely (no shared
  gateway IDs across workspace rows).
- Make every agent activity observable in real time on the
  task/initiative card it relates to and in a workspace-wide live feed.
- Move role definitions into source control (`agent-templates/`) so
  authoring a new role = a PR, not filesystem surgery.
- Support recurring jobs (researcher checks something every 2 days)
  natively, not bolted on.
- Preserve and improve task-stage hand-off via the notes spine instead
  of session memory.

## Non-Goals

- Replacing the openclaw gateway. We still use openclaw to host
  sessions; we just stop pretending each role-per-workspace combo is a
  separate identity.
- Replacing the synth fallback in dispatch. Offline / gateway-down
  behavior stays as today.
- Changing the workflow stage machine (planning → assigned →
  in_progress → testing → review → verification → done).

## Architecture Overview

```
~/.openclaw/workspaces/mc-runner-dev/         # ONE neutral session host
                                              # (org-wide; symlinks shared docs;
                                              #  generic SOUL/IDENTITY/AGENTS)

agent-templates/<role>/                       # In-repo role definitions
  SOUL.md, AGENTS.md, IDENTITY.md             # Source-controlled, reviewable

agent_role_overrides table                    # Per-workspace customizations
  (workspace_id, role, soul_md, ...)          # Operator edits via existing UI

agent_notes table                             # Observability spine
  (workspace_id, agent_id, task_id,           # Every meaningful agent moment
   initiative_id, scope_key, kind, body,       # SSE-broadcast → UI cards + feed
   audience, importance, run_group_id, ...)

mc_sessions table                             # Bookkeeping for active scopes
  (scope_key, session_key, scope_type,        # Lets MC list "active sessions
   scope_ref_id, status, last_used_at)        #  for task X" or reap stale work

recurring_jobs table                          # Native scheduled work
  (scope_key_template, role, cadence_seconds, # Researcher checks every 2 days,
   briefing_template, initiative_id, ...)     #  builder runs nightly check, etc.
```

Dispatch flow at high level:

```
Operator action / scheduler tick
  → MC resolves a sessionKey (e.g. agent:mc-runner-dev:ws-<id>:task-<id>:builder:1)
  → MC builds the briefing (template + override + task context + prior notes)
  → openclaw chat.send to that sessionKey (replays trajectory if exists)
  → Agent calls MCP tools (take_note, log_activity, register_deliverable, etc.)
  → MC broadcasts SSE for every note → UI updates card / feed live
  → Agent calls update_task_status to advance the workflow
```

No `agents` row dance. No promotion. No catalog sync for workers. Roles
are templates; sessions are scopes.

## 1. Scope-Keyed Sessions

### 1.1 SessionKey grammar

```
agent:<gateway_agent_id>:<scope_segments>...
```

Each segment matches openclaw's `[a-z0-9][a-z0-9_-]{0,63}` and segments
are joined by `:`. Reference: [openclaw session-key.ts:26].

**Canonical scopes:**

| Purpose | Pattern |
|---|---|
| PM disruption thread (per-thread, see Q1) | `agent:mc-runner-dev:ws-<wsid>:pm-chat-<thread_id>` |
| plan_initiative refine loop | `agent:mc-runner-dev:ws-<wsid>:plan-<initiative_id>` |
| decompose_initiative | `agent:mc-runner-dev:ws-<wsid>:decompose-<initiative_id>` |
| decompose_story | `agent:mc-runner-dev:ws-<wsid>:decompose-story-<task_id>` |
| notes intake (one-shot) | `agent:mc-runner-dev:ws-<wsid>:notes-<correlation_id>` |
| Coordinator (optional, per task) | `agent:mc-runner-dev:ws-<wsid>:task-<task_id>:coord` |
| Builder, attempt N | `agent:mc-runner-dev:ws-<wsid>:task-<task_id>:builder:<n>` |
| Tester, attempt N | `agent:mc-runner-dev:ws-<wsid>:task-<task_id>:tester:<n>` |
| Reviewer, attempt N | `agent:mc-runner-dev:ws-<wsid>:task-<task_id>:reviewer:<n>` |
| Recurring job, run N | `agent:mc-runner-dev:ws-<wsid>:recurring-<job_id>` (reuse) or `:run-<n>` (fresh) |
| Heartbeat coordinator (optional) | `agent:mc-runner-dev:ws-<wsid>:task-<task_id>:heartbeat` |

`<wsid>` is the workspace UUID with hyphens preserved (36 chars, fits
the 64-char segment limit). `<task_id>`, `<initiative_id>` likewise.
The `mc-runner-dev` host name is the only org-wide gateway identifier;
nothing else collides because everything else lives in the scope tail.

### 1.2 Attempt-key strategies (Q3 A/B)

For roles with retry semantics (builder, tester, reviewer), MC supports
two strategies, pick-per-role at config time:

- **`fresh`** — increment `:N` on each attempt. Each retry is a clean
  session with a brand-new trajectory. Briefing carries forward via
  notes from prior attempts.
- **`reuse`** — same `:1` segment forever. Trajectory accumulates;
  agent sees its own prior reasoning. Eventually compacts.

Default per role:
- `builder`, `tester`, `reviewer`: **fresh** (clean retries, no
  fixation on prior failed approach).
- `researcher`, `learner`: **reuse** (continuity is the value).
- `coordinator` (when enabled): **reuse** for the duration of the task.

The choice is a column on `agent_role_overrides`; per-workspace
operator override is allowed.

**Q3 validation harness** (defer real choice to data, not opinion):
build a sweep that runs the same 6 synthetic tasks under both strategies
against `spark-lb/agent`, scores via LLM-as-judge on a rubric (resume
fidelity, hallucination rate, time-to-deliverable). Lock defaults from
the result before declaring done.

### 1.3 Lifecycle and the `mc_sessions` table

```sql
CREATE TABLE mc_sessions (
  scope_key      TEXT PRIMARY KEY,             -- the openclaw sessionKey
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role           TEXT NOT NULL,                -- builder, tester, ..., pm
  scope_type     TEXT NOT NULL CHECK (scope_type IN (
                   'pm_chat','plan','decompose','decompose_story',
                   'notes_intake','task_coord','task_role',
                   'recurring','heartbeat')),
  task_id        TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  initiative_id  TEXT REFERENCES initiatives(id) ON DELETE CASCADE,
  recurring_job_id TEXT REFERENCES recurring_jobs(id) ON DELETE CASCADE,
  attempt        INTEGER DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
                   'active','idle','closed','failed')),
  last_used_at   TEXT NOT NULL DEFAULT (datetime('now')),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at      TEXT
);
CREATE INDEX idx_mc_sessions_task ON mc_sessions(task_id);
CREATE INDEX idx_mc_sessions_workspace ON mc_sessions(workspace_id, status);
CREATE INDEX idx_mc_sessions_role ON mc_sessions(role, status);
```

The row exists for **bookkeeping only**. Openclaw owns the trajectory
file; MC owns the metadata. On every dispatch:

1. Upsert the `mc_sessions` row by `scope_key` (insert if new, bump
   `last_used_at` if existing).
2. Send the briefing via `chat.send`.
3. Listen for tool calls and final frame as today.
4. On task terminal status (done/cancelled), set `status='closed'`,
   `closed_at=now()` for all sessions where `task_id` matches. Don't
   delete; the row is the audit trail.

### 1.4 Removing the durable agent rows

Post-migration, the `agents` table contains only:

- `mc-runner` and `mc-runner-dev` rows in workspace `default` (the
  gateway hosts; `is_active=1`, `gateway_agent_id` set, no `is_pm`).
- One PM row per workspace (the existing `is_pm=1` placeholder, now
  *also* without `gateway_agent_id` — PM is just another role-templated
  scope, see §2.4).

All other `gateway_agent_id` values get nulled out. The existing
catalog sync ([agent-catalog-sync.ts:114](../src/lib/agent-catalog-sync.ts:114))
becomes a thin "ensure mc-runner-dev exists" check.

## 2. Agent Templates

### 2.1 Directory layout

```
agent-templates/
├── README.md                     # Authoring guide
├── _shared/
│   ├── notetaker.md              # Appended to every role's briefing
│   ├── messaging-protocol.md     # MC-side mirror of openclaw shared doc
│   └── shared-rules.md           # Mirror of openclaw SHARED-RULES.md
├── pm/
│   ├── SOUL.md
│   ├── AGENTS.md
│   └── IDENTITY.md
├── coordinator/
├── builder/
├── researcher/
├── tester/
├── reviewer/
├── writer/
├── learner/
└── runner-host/                  # The neutral host docs for mc-runner-dev itself
    ├── SOUL.md                   # "You assume whatever role the briefing assigns"
    ├── AGENTS.md
    └── IDENTITY.md
```

Initial seed: import via a one-shot script
(`scripts/import-agent-templates.ts`) from
`~/.openclaw/workspaces/mc-{role}-{env}/`, then the files are
source-controlled and the openclaw workspaces become functionally dead.

### 2.2 Per-workspace overrides

```sql
CREATE TABLE agent_role_overrides (
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role           TEXT NOT NULL,
  soul_md        TEXT,
  agents_md      TEXT,
  identity_md    TEXT,
  attempt_strategy TEXT CHECK (attempt_strategy IN ('fresh','reuse')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, role)
);
```

Empty by default. Operator edits via the existing live agent prompt
preview from PR #142 — but the editor now scopes to a *role* in a
workspace, not a per-agent row.

### 2.3 Briefing builder

New module `src/lib/agents/briefing.ts` exposing:

```ts
function buildBriefing(input: {
  workspace_id: string;
  role: 'builder' | 'tester' | 'reviewer' | 'researcher' | 'writer'
       | 'learner' | 'coordinator' | 'pm';
  scope_key: string;
  task_id?: string;
  initiative_id?: string;
  trigger_text?: string;
  trigger_kind?: PmProposalTriggerKind;
  agent_id: string;                 // the runner agent's MC UUID
  gateway_agent_id: string;         // 'mc-runner-dev'
  run_group_id: string;             // for note grouping
  is_resume: boolean;               // whether this scope_key has prior trajectory
}): string;
```

Composition order:

1. **Identity preamble** (the [pm-dispatch.ts:140](../src/lib/agents/pm-dispatch.ts:140) header — `Your agent_id is: …`, `Your gateway_agent_id is: …`).
2. **Role section.** From `agent_role_overrides` if a row exists for
   `(workspace_id, role)`, else from `agent-templates/<role>/SOUL.md`.
   Also load `AGENTS.md`, `IDENTITY.md` from same source.
3. **Notetaker addendum** (`_shared/notetaker.md`).
4. **Task context** (when `task_id` set):
   - Title, description, acceptance criteria.
   - Workspace snapshot summary (existing
     `buildSnapshotSummary` in [pm-dispatch.ts:357](../src/lib/agents/pm-dispatch.ts:357)).
   - Prior deliverables on this task.
   - **Notes from prior stages** for this task and audience (see §3.4).
5. **Prescribed verification commands** (existing
   `getPrescribedCommandsForRole` from
   [dispatch/route.ts:478](../src/app/api/tasks/[id]/dispatch/route.ts:478)).
6. **Trigger payload** (the operator's actual ask, the scheduled job's
   prompt, etc.).
7. **Resume hint** if `is_resume`: a one-line "you may have prior
   reasoning in this session; re-read recent turns before acting."

This function replaces ad-hoc message construction in
`runDisruptionDispatchInBackground`, `runNamedAgentDispatchInBackground`,
and the existing dispatch route's prompt assembly.

### 2.4 PM as a role, not a special agent

The PM placeholder row stays (one per workspace, with `is_pm=1`) so
existing UI queries that look up "the PM" still work. But it has no
`gateway_agent_id`. Dispatching to the PM is now: pick role `'pm'`,
build briefing from `agent-templates/pm/`, send to scope key
`agent:mc-runner-dev:ws-<id>:pm-chat-<thread_id>`.

This collapses the PM's special-case dispatch path. `dispatchPm` and
`dispatchPmSynthesized` become thin wrappers around the same generic
`dispatchScope()` primitive.

## 3. The Notes Spine

### 3.1 Schema

```sql
CREATE TABLE agent_notes (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id        TEXT REFERENCES agents(id) ON DELETE SET NULL,
  task_id         TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  initiative_id   TEXT REFERENCES initiatives(id) ON DELETE CASCADE,
  scope_key       TEXT NOT NULL,
  role            TEXT NOT NULL,
  run_group_id    TEXT NOT NULL,             -- groups notes from one run/stage
  kind            TEXT NOT NULL CHECK (kind IN (
                    'discovery','blocker','uncertainty','decision',
                    'observation','question','breadcrumb')),
  audience        TEXT,                       -- 'pm'|'reviewer'|'next-stage'|'tester'|NULL
  body            TEXT NOT NULL,              -- max 3000 chars
  attached_files  TEXT,                       -- JSON array of paths
  importance      INTEGER NOT NULL DEFAULT 0 CHECK (importance IN (0,1,2)),
  consumed_by_stages TEXT,                    -- JSON array of stage_slugs
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_agent_notes_task ON agent_notes(task_id, created_at);
CREATE INDEX idx_agent_notes_initiative ON agent_notes(initiative_id, created_at);
CREATE INDEX idx_agent_notes_workspace ON agent_notes(workspace_id, created_at);
CREATE INDEX idx_agent_notes_run_group ON agent_notes(run_group_id);
CREATE INDEX idx_agent_notes_importance ON agent_notes(workspace_id, importance, created_at);
```

### 3.2 MCP tool family

Four tools, all under the `sc-mission-control` server:

- `take_note(agent_id, kind, body, task_id?, initiative_id?, audience?, attached_files?, importance?)` →
  inserts a row, broadcasts `agent_note_created` SSE, returns the note id.
  No evidence-gate side-effects. Cheap and spammable.
- `read_notes(agent_id, task_id?, initiative_id?, audience?, kinds?, limit?)` →
  query notes the agent can see. Used during work, not just at briefing
  time. Ordered by importance DESC, created_at ASC.
- `mark_note_consumed(agent_id, note_id)` → records that this stage has
  read this note (appends to `consumed_by_stages`). Used by briefing
  builder to suppress already-shown notes on the next briefing.
- `archive_note(agent_id, note_id, reason?)` → soft-delete; the note
  stays in DB but won't surface in future briefings or feeds. For
  resolved blockers, stale observations.

The `agent_id` argument follows the existing FK convention. Since the
`agents` table only has `mc-runner-dev` + per-workspace PM rows, every
non-PM scope-keyed session passes the `mc-runner-dev` UUID. This is
fine — `agent_notes.role` carries the role-of-the-moment.

### 3.3 SSE broadcast on `take_note`

```ts
broadcast({
  type: 'agent_note_created',
  payload: {
    workspace_id, note_id, agent_id, role,
    task_id, initiative_id, scope_key,
    kind, audience, importance, body, attached_files,
    run_group_id, created_at,
  }
});
```

If `importance === 2`, also post to PM Chat as an assistant-style
message (existing `postPmChatMessage` from
[pm-dispatch.ts:174](../src/lib/agents/pm-dispatch.ts:174)) so the
operator sees high-stakes findings in their primary chat surface.

### 3.4 Briefing integration

Inside `buildBriefing()` step 4, query notes:

```sql
SELECT id, kind, role, body, audience, attached_files, importance, created_at
  FROM agent_notes
 WHERE (task_id = :task_id OR (task_id IS NULL AND initiative_id = :initiative_id))
   AND archived_at IS NULL
   AND (audience IS NULL OR audience = :next_role OR audience = 'next-stage')
   AND (consumed_by_stages IS NULL OR :stage_slug NOT IN consumed_by_stages)
 ORDER BY importance DESC, created_at ASC
 LIMIT 50;
```

Format as a "Notes from prior work" section in the briefing, grouped by
`run_group_id`. The agent is instructed (via the notetaker addendum) to
call `mark_note_consumed` for each one as it processes them so the next
session doesn't re-show it.

### 3.5 Role-soul addendum (`agent-templates/_shared/notetaker.md`)

```markdown
# You are an obsessive notetaker

Notes are free; forgotten reasoning is not. Every meaningful moment of
your work should leave a trail in `take_note`.

## When to call `take_note`

- You read something non-obvious in the code → `kind: discovery`
- You're stuck or unsure about an approach → `kind: uncertainty` or `blocker`
- You chose A over B → `kind: decision` (name *both* alternatives in the body)
- Something surprised you → `kind: observation`
- You have a question you can't answer here → `kind: question` (set `audience: 'pm'`)
- You're about to hand off → `kind: breadcrumb`, `audience: 'next-stage'`

## How to write a good note

- Concrete > aspirational. "Updated `migrations.ts:063` to add `role` column" beats "Made schema changes".
- Reference file paths in `attached_files` so the next session can navigate without re-reading the world.
- One thought per note. Ten short notes beat one long essay.
- Set `importance: 2` only for genuinely high-stakes findings (security issues, broken assumptions, unrecoverable choices). The PM sees these in real time.

## When to call `read_notes`

Before you commit to an approach, check:
- `read_notes(task_id: <self>, audience: 'next-stage')` — what did the prior stage want me to know?
- `read_notes(task_id: <self>, kinds: ['decision','blocker'])` — what's already been decided or stuck?

After you make progress, scan for any `kind: question` you can now answer.

## Closing a note

When a `blocker` is resolved or an `uncertainty` clarified, call
`archive_note(note_id, reason: '<one line>')`. Don't leave stale
worries in the feed.
```

### 3.6 UI surfaces (the observability win)

Five subscribers to the SSE stream, each filtering differently:

1. **Task detail panel** — filter `task_id === current.id`. New "Notes"
   rail next to deliverables, grouped by `run_group_id`, reverse-chrono,
   importance-pinned.
2. **Initiative detail panel** — filter `initiative_id === current.id`
   OR `task_id IN getInitiativeTaskIds(current.id)`. Rollup view of
   activity across all child tasks.
3. **Cards in lists** — small dot-badge with note count + most-recent
   timestamp; hover shows latest body excerpt. Live-updates when SSE
   arrives for a card on screen.
4. **Workspace live feed** (new page at `/feed`) — full unfiltered
   stream, filter chips by kind/role/agent/importance, "Follow" toggle
   to subscribe to a specific task or recurring job.
5. **PM Chat** — `importance: 2` notes auto-post (existing wire-up).

Implementation: shared SSE hook `useAgentNotes(filter)` that any
component can use. Notes Rail component is reused across Task and
Initiative detail panels.

## 4. Recurring Jobs

### 4.1 Schema

```sql
CREATE TABLE recurring_jobs (
  id                   TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,                    -- "Watch DGX Spark forum"
  role                 TEXT NOT NULL,                    -- 'researcher', 'builder', etc.
  scope_key_template   TEXT NOT NULL,                    -- substitutes {wsid}, {job_id}, {run_n}
  briefing_template    TEXT NOT NULL,                    -- prompt body, can interpolate MC state
  initiative_id        TEXT REFERENCES initiatives(id) ON DELETE CASCADE,
  task_id              TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  cadence_seconds      INTEGER NOT NULL,                 -- 172800 = 2 days
  attempt_strategy     TEXT NOT NULL DEFAULT 'reuse' CHECK (attempt_strategy IN ('reuse','fresh')),
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','done')),
  last_run_at          TEXT,
  last_run_scope_key   TEXT,
  next_run_at          TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  run_count            INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  created_by_agent_id  TEXT REFERENCES agents(id) ON DELETE SET NULL
);
CREATE INDEX idx_recurring_jobs_next_run ON recurring_jobs(next_run_at, status);
CREATE INDEX idx_recurring_jobs_workspace ON recurring_jobs(workspace_id, status);
```

### 4.2 Scheduler

Add to `instrumentation.ts` alongside the existing `pm_pending_notes`
drain. 60-second `setInterval`:

```ts
function dispatchRecurringJobs(): void {
  const now = new Date().toISOString();
  const due = queryAll<RecurringJob>(
    `SELECT * FROM recurring_jobs
      WHERE status = 'active' AND next_run_at <= ?
      ORDER BY next_run_at ASC LIMIT 50`,
    [now]
  );
  for (const job of due) {
    void dispatchRecurringJobOnce(job).catch(err =>
      console.error(`[recurring] job ${job.id} failed:`, err)
    );
  }
}
```

Each dispatch:
1. Render `scope_key_template` with current `run_count`.
2. Build briefing via the same `buildBriefing()`, passing the
   `briefing_template` as `trigger_text`.
3. Send via `chat.send`. Same SSE / note flow.
4. On agent's final frame: bump `last_run_at`, `next_run_at = now() +
   cadence_seconds`, `run_count++`, `consecutive_failures = 0`.
5. On error or timeout: `consecutive_failures++`. If > 3, flip
   `status='paused'` and post an `importance: 2` note for the operator.

### 4.3 Notes-back semantics for recurring jobs

The researcher example: every 2 days, check the DGX Spark forum,
report what's new.

- Each run takes 1–N notes via `take_note(kind: 'observation' or
  'discovery', task_id: <linked>, audience: 'pm')`.
- Same `run_group_id` across all notes from one run; UI groups them.
- If the researcher concludes the roadmap should change, *also* call
  `propose_changes` to draft a `pm_proposals` row.
- "Nothing new this time" is still a note (`kind: 'observation'`,
  `body: 'No new posts since last check'`). Silence is signal too.

## 5. Optional Heartbeat Coordinator

### 5.1 Opt-in per task or per workspace

Workspace setting + per-task override: `coordinator_mode: 'off' |
'reactive' | 'heartbeat'`. Reactive (today) = coordinator dispatches on
stage transitions only. Heartbeat = additionally, every N minutes the
coordinator checks in on its tasks.

### 5.2 Schema (additive)

```sql
ALTER TABLE workspaces ADD COLUMN coordinator_mode TEXT NOT NULL DEFAULT 'reactive'
  CHECK (coordinator_mode IN ('off','reactive','heartbeat'));
ALTER TABLE workspaces ADD COLUMN coordinator_heartbeat_seconds INTEGER NOT NULL DEFAULT 1800;

ALTER TABLE tasks ADD COLUMN coordinator_mode TEXT
  CHECK (coordinator_mode IN ('off','reactive','heartbeat')); -- NULL = inherit workspace
```

### 5.3 Behavior

When heartbeat is enabled for a task: a `recurring_jobs` row is
auto-created at task assignment with:
- `role: 'coordinator'`
- `scope_key_template: 'agent:mc-runner-dev:ws-{wsid}:task-{task_id}:heartbeat'`
- `cadence_seconds: <coordinator_heartbeat_seconds>`
- `attempt_strategy: 'reuse'` (continuity is the value)
- `briefing_template: 'Check on task {task_id}. Read recent notes via
  read_notes. If there's a blocker that needs escalation, take_note
  with audience=pm and importance=2. If a stage is stalled or going
  off-track, take_note with audience=next-stage. If everything is fine,
  take_note kind=observation body="ok".'`

Auto-deleted on task terminal status. The coordinator becomes "the
agent that watches the watchers" — purely observational, never writes
deliverables, never moves status.

This isn't a separate code path — it's `recurring_jobs` with a special
template. Confirms the design: the recurring jobs primitive subsumes
all "scheduled agent work".

## 6. Migration Plan

### 6.1 Phases (each independently deployable)

**Phase A — Foundations (no behavioral change):**
- A1. Add `agent-templates/` directory + import script + seed contents from openclaw workspaces.
- A2. Add `agent_role_overrides`, `agent_notes`, `mc_sessions`, `recurring_jobs` tables (new migrations).
- A3. Add MCP tools: `take_note`, `read_notes`, `mark_note_consumed`, `archive_note`. No agents call them yet.
- A4. Add SSE event type `agent_note_created`. Add `useAgentNotes` hook (unused).

Ships behind a feature flag. Tests pass; nothing user-facing changes.

**Phase B — Briefing builder + scope-keyed dispatch primitive:**
- B1. Implement `buildBriefing()` from `agent-templates/` + overrides.
- B2. Add `dispatchScope()` primitive that takes a sessionKey and role, builds briefing, sends. Wraps existing `sendChatAndAwaitReply`.
- B3. Add `mc_sessions` upsert in `dispatchScope`.
- B4. Wire PM dispatch (disruption, plan, decompose, notes-intake) to use the new primitive. Verify behavior matches today via the existing `pm.test.ts` suite.

**Phase C — Workers via scope-keyed dispatch:**
- C1. Add the `runner-host/` template + neutralize `~/.openclaw/workspaces/mc-runner-dev/` SOUL/AGENTS/IDENTITY.
- C2. Switch task dispatch ([dispatch/route.ts:42](../src/app/api/tasks/[id]/dispatch/route.ts:42)) to compute scope keys against `mc-runner-dev` and call `dispatchScope`. Keep the legacy path behind a feature flag for one PR's worth of testing.
- C3. Update agent role-souls to include the notetaker addendum. Run real-agent eval against `spark-lb/agent` to verify notes are produced at expected rate.

**Phase D — Observability surfaces:**
- D1. Notes Rail component (Task detail).
- D2. Notes Rail on Initiative detail (rollup query).
- D3. Card badges in list views.
- D4. Workspace `/feed` page.
- D5. `importance: 2` auto-post to PM Chat.

**Phase E — Recurring jobs + optional heartbeat coordinator:**
- E1. Recurring jobs scheduler + UI (create/pause/resume).
- E2. Workspace + task `coordinator_mode` setting + auto-create heartbeat job.
- E3. Real-agent smoke for both: 2-day cadence forum-watcher (compressed to 5min in test), and a heartbeat coord that tests escalation.

**Phase F — Decommission durable workers:**
- F1. Run a script that nulls `gateway_agent_id` on all worker rows
  (everything except the runner agents and PM placeholders).
- F2. Drop the catalog sync's worker discovery path (it now only ensures `mc-runner-dev`).
- F3. Update settings UI: "Agents" tab becomes "Roles", scoped to `agent_role_overrides`.
- F4. Run another script to mark old worker `~/.openclaw/workspaces/mc-{role}-{env}/` as archived (move to `~/.openclaw/workspaces/.archive/`). Openclaw's 30-day pruner handles the rest.

### 6.2 Rollback

Each phase has a feature flag. Disable the flag = old path resumes. The
schema additions are all additive (new tables, nullable columns); no
destructive migrations until F1, which is reversible by re-running the
agent catalog sync.

### 6.3 What's removed

After Phase F:
- The promotion UI (operator-promotes-PM-to-gateway flow) goes away.
- `cloneAgentsFromWorkspace` ([bootstrap-agents.ts:123](../src/lib/bootstrap-agents.ts:123)) becomes a no-op (only PM is per-workspace; PM is auto-seeded).
- The `is_pm` resolver fallback path ([pm-resolver.ts:30](../src/lib/agents/pm-resolver.ts:30)) — the `LOWER(role)='pm'` branch — can be deleted once PM is universally `is_pm=1`.
- The "AVAILABLE PERSISTENT AGENTS" roster in coordinator dispatches ([dispatch/route.ts:494](../src/app/api/tasks/[id]/dispatch/route.ts:494)) — coordinators now fan out via the scope-key dispatcher, not by enumerating peers.
- The dispatch-message preamble fix from this morning ([pm-dispatch.ts:140](../src/lib/agents/pm-dispatch.ts:140)) becomes universal (every briefing has it).

## 7. Validation Strategy

### 7.1 Per-slice gates

Every phase's PR must pass:
- `yarn tsc --noEmit` (zero errors; pre-existing pm-decompose.test.ts errors are tracked and unrelated).
- `yarn test` (existing suite + new tests for the slice).
- `yarn mcp:smoke` (extended with new tools in Phase A).
- For UI phases: `preview_*` smoke run with the browser tooling.
- For dispatch phases: real-agent round-trip against `spark-lb/agent`,
  asserting the agent reaches the expected terminal state in the DB.

### 7.2 New test additions

- `briefing.test.ts` — pure function tests for `buildBriefing()` over a synthetic snapshot. Asserts the role section, notes section, and identity preamble all appear.
- `scope-key.test.ts` — round-trips parsing/formatting; asserts no legal scope exceeds the 64-char segment limit.
- `agent-notes.test.ts` — schema CRUD, SSE broadcast, FK behavior on workspace deletion, filter queries.
- `recurring-jobs.test.ts` — scheduler picks due jobs; updates `next_run_at`; trips into `paused` after 3 failures; correctly renders `scope_key_template`.
- `dispatch-scope.test.ts` — uses existing `__setOpenClawClientForTests` to assert the briefing reaches the agent and the agent's tool calls are routed correctly.
- `pm-eval.ts` (new harness) — runs synthetic disruptions through `dispatchScope` against `spark-lb/agent`, scores via LLM-as-judge.

### 7.3 LLM-as-judge eval harness

Built in Phase B, run automatically in CI for Phase C+:

```
specs/evals/scope-keyed-sessions/
├── tasks/
│   ├── 01-builder-add-feature.json
│   ├── 02-tester-find-regression.json
│   ├── 03-researcher-watch-forum.json
│   └── ...
├── rubrics/
│   ├── note-quality.md          # does the agent take well-structured notes?
│   ├── briefing-fidelity.md     # does the agent ingest prior notes correctly?
│   └── handoff-cohesion.md      # does next-stage build on prior-stage notes?
└── runner.ts                    # invokes spark-lb/agent, scores, prints table
```

Halt criteria (stop the autonomous build, surface to operator):
- Type errors on any phase.
- Test regressions in any phase.
- Real-agent smoke fails with non-flake error.
- LLM-as-judge rubric scores fall below threshold (define per rubric).
- A phase's PR has no CHANGELOG entry.

### 7.4 Q3 attempt-strategy decision

The `fresh` vs `reuse` defaults are codified after running the harness
against both strategies on each role's synthetic tasks. The defaults
land in `agent_role_overrides` seed data. Document the win-rate per
strategy per role in the spec's appendix when the data lands.

## 8. Open Questions and Risks

### 8.1 Open

- **Coordinator collapse into PM?** Today coordinator and PM have
  separate role definitions. With workers ephemeral and MC owning
  convoy state, the coordinator's job is mostly thin orchestration. We
  could either (a) keep the role definition for cases where mid-task
  judgment matters, or (b) fold "decompose + dispatch + react" into
  the PM at planning time. This spec keeps coordinator as a role for
  Phase E flexibility; revisit after Phase E validation.

- **Note retention.** Notes never delete. For a busy workspace running
  for years, this is a lot of rows. Add a 90-day archival pass (move
  to `agent_notes_archive`) in a follow-up if it becomes an issue.
  Indexes are designed to keep recent-time queries fast regardless.

### 8.2 Risks

- **Briefing length.** Concatenating role-soul + AGENTS.md + IDENTITY
  + notetaker addendum + task context + N notes can balloon. The
  briefing builder caps notes at 50 and the addendum at 1500 chars; if
  total exceeds 12,000 chars, truncate the notes block first (oldest
  first). Add a metric: median + p95 briefing size per role.

- **Trajectory file growth.** A long-lived recurring researcher session
  with `attempt_strategy: 'reuse'` could grow large over months.
  Openclaw's 30-day prune doesn't trigger if the session is touched
  every 2 days. Mitigation: when `compactionCount > 5`, mint a new
  attempt key (`run-N+1`) and start fresh, briefing from notes. Add as
  Phase E2.5.

- **Note spam.** Roles instructed to be "obsessive notetakers" might
  fire too many `take_note` calls. The harness in Phase C will measure
  notes-per-minute; if pathological, tighten the addendum guidance and
  potentially rate-limit at the MCP layer.

- **Operator note-fatigue.** Five notes per task across five tasks =
  the live feed becomes noise. Mitigation: importance levels are real
  (importance 0 doesn't surface in feed by default; importance 2 pings
  PM Chat). Filter chips on `/feed` make the firehose tractable.

## Appendix A — Where the bug we just fixed lives in the new model

The [pm-dispatch.ts:140](../src/lib/agents/pm-dispatch.ts:140)
`buildIdentityPreamble` becomes part of the universal briefing builder
(§2.3 step 1). Every dispatch — PM, worker, coordinator, recurring —
opens with the agent's UUID. The `whoami` ambiguity case
([tools.ts:166](../src/lib/mcp/tools.ts:166)) becomes unreachable in
practice because no two `agents` rows share a `gateway_agent_id` after
Phase F (only `mc-runner-dev` carries one). The error path stays as
defense-in-depth.

## Appendix B — File inventory

New files:
- `agent-templates/` (directory + `_shared/` + 8 role subdirectories)
- `scripts/import-agent-templates.ts`
- `src/lib/agents/briefing.ts`
- `src/lib/agents/dispatch-scope.ts`
- `src/lib/db/migrations/064-agent-role-overrides.ts` (or next available)
- `src/lib/db/migrations/065-agent-notes.ts`
- `src/lib/db/migrations/066-mc-sessions.ts`
- `src/lib/db/migrations/067-recurring-jobs.ts`
- `src/lib/db/migrations/068-coordinator-mode.ts`
- `src/lib/db/agent-notes.ts`
- `src/lib/db/recurring-jobs.ts`
- `src/lib/agents/recurring-scheduler.ts`
- `src/components/notes/NotesRail.tsx`
- `src/components/notes/NoteCard.tsx`
- `src/components/notes/useAgentNotes.ts`
- `src/app/feed/page.tsx`
- `specs/evals/scope-keyed-sessions/`
- Tests for each.

Modified files:
- [pm-dispatch.ts](../src/lib/agents/pm-dispatch.ts) — wraps `dispatchScope`
- [dispatch/route.ts](../src/app/api/tasks/[id]/dispatch/route.ts) — uses `dispatchScope`
- [agent-catalog-sync.ts](../src/lib/agent-catalog-sync.ts) — only ensures runner exists
- [bootstrap-agents.ts](../src/lib/bootstrap-agents.ts) — `cloneAgentsFromWorkspace` becomes no-op
- [pm-resolver.ts](../src/lib/agents/pm-resolver.ts) — drops legacy fallback (Phase F)
- [tools.ts](../src/lib/mcp/tools.ts) — adds notes family
- [instrumentation.ts](../instrumentation.ts) — adds recurring scheduler

Removed (Phase F):
- The `gateway_agent_id` column on most `agents` rows (data, not schema).
- Coordinator dispatch's "AVAILABLE PERSISTENT AGENTS" roster section.
- Older per-role openclaw workspaces archived (filesystem move only).

## Status

- [x] Audit complete (openclaw session internals + MC planning flows)
- [x] Architecture locked
- [x] Spec drafted (this document)
- [x] Phase A — foundations (agent-templates, notes spine, SSE) — PR #148
- [x] Phase B — buildBriefing() + dispatchScope() primitive — PR #149
- [x] Phase C — workers via scope-keyed dispatch (feature-flagged) — PR #150
- [x] Phase D — observability surfaces (NotesRail, /feed, badges, PM Chat) — PR #151
- [x] Phase E — recurring jobs scheduler + heartbeat coordinator — PR #152
- [x] Phase F — decommission durable workers, flip flag default — PR #153
- [x] Phase G — PM is the workspace's only required agent (PM+master flags) — PR #154
- [x] Phase H — runner IS the PM (singleton runner with PM flags) — PR #155
- [x] Phase I — per-workspace PMs (mc-pm-<slug>-*) — current PR; **supersedes Phase H**

### Architectural correction in Phase I

Phase H concentrated all PM duties on a singleton org-wide runner. Subsequent
audit of openclaw's memory subsystem (per-agent SQLite + LanceDB at
`~/.openclaw/memory/<agentId>.sqlite`) revealed that one runner serving
multiple workspaces leaks memory (`memory_search`, vector recall, heartbeat
writes) across workspace boundaries — the QMD scope filter is opt-in and
default-allow.

Phase I splits that out:

- **Per-workspace PM** (`mc-pm-<slug>-(dev)?`) — one openclaw agent per MC
  workspace. Memory storage is per-agent → workspace-scoped by construction.
  Carries `is_pm=1, is_master=1, workspace_id=<workspace>`.
- **Org-wide runner** (`mc-runner` / `mc-runner-dev`) — stays in the catalog
  as a session host but is no longer the PM. Operators can still use it
  for cross-workspace org-knowledge or as a personal assistant; MC doesn't
  dispatch workspace work through it.

Operator-side: each MC workspace gets a corresponding openclaw agent
provisioned via `yarn workspace:provision <slug>`. For 10 workspaces that's
10 openclaw agents — bounded and manageable.

### Outstanding follow-ups

- [ ] Phase J: optionally migrate worker dispatch from scope-keyed sibling
      sessions on the workspace PM to openclaw `subagent_spawn` for cleaner
      coordinator semantics
- [ ] Run full validation pack (specs/scope-keyed-sessions-validation/)
      end-to-end against spark-lb/agent
- [ ] Run scripts/decommission-durable-workers.ts in production
- [ ] Run scripts/archive-old-worker-workspaces.ts in production
- [ ] Run scripts/neutralize-runner-host.ts in production
- [ ] Remove MC_USE_SCOPE_KEYED_DISPATCH env lever after a release cycle
