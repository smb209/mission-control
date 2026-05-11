---
status: current
last-verified: 2026-05-11
audience: ai-subagents-primary, operator-secondary
code-anchors:
  - src/lib/research/run-brief.ts
  - src/lib/research/suggest.ts
  - src/lib/db/briefs.ts
  - src/lib/db/topics.ts
  - src/lib/db/agent-runs.ts
  - src/lib/db/recurring-jobs.ts
  - src/lib/db/research-suggestions.ts
  - src/lib/db/agent-notes.ts
  - src/lib/mcp/groups/read.ts
  - src/lib/mcp/groups/core.ts
  - src/lib/agents/recurring-scheduler.ts
  - src/lib/research/eval/runner.ts
migrations:
  - "075 research_area_phase_1 (agent_runs + topics + briefs) — migrations.ts:4065"
  - "076 research_suggestions — migrations.ts:4160"
  - "077 recurring_jobs_research_columns — migrations.ts:4208"
  - "080 extend_agent_runs (kind enum widen + attribution) — migrations.ts:4317"
  - "081 agent_runs_trigger_body_and_proposal_link — migrations.ts:4407"
  - "085 agent_runs_run_group_id — migrations.ts:4498"
  - "089 initiative_research_loop (briefs.initiative_id/summary/source_ref, agent_notes.source_kind/source_ref) — migrations.ts:4615"
  - "090 briefs_source_ref_followup — migrations.ts:4660"
mcp-tools: [read_brief, read_notes, take_note]
db-tables: [topics, briefs, agent_runs, research_suggestions, recurring_jobs (research subset), agent_notes (research subset)]
related-specs:
  - docs/archive/research-area-build-plan.md — phase 1 (shipped)
  - docs/archive/research-phase-2-schedules-build-plan.md — phase 2 (shipped)
  - docs/archive/initiative-research-loop.md — initiative-scoped briefs (shipped)
  - docs/archive/initiative-investigate.md — audit/investigate pipeline (consumer)
  - docs/archive/dedupe-investigations.md — PR #1 shipped, #2/#3 open
  - specs/foia-pipeline.md — aspirational downstream consumer
  - docs/archive/subtree-audit-proposals-spec.md — audit pipeline writing structured notes
---

# Research Area

Comprehensive reference for the research capability — topics, briefs, the suggest pipeline, scheduling, initiative integration, and the hand-off to audit and PM workflows. This document is what's actually live as of 2026-05-11; deferred work is corralled in §14.

## 1. Overview

Research in Mission Control means **dispatching a researcher agent to produce a structured markdown brief with citations**, optionally on a recurring cadence, optionally scoped to a planning initiative so the result flows back into PM decision-making.

The system has three load-bearing surfaces:

1. **Topics** — long-lived areas of interest, workspace-scoped. A topic groups briefs over time and can carry a recurring schedule. (`src/lib/db/topics.ts`)
2. **Briefs** — single research outputs. A brief always belongs to a workspace; it may attach to a topic and/or to an initiative. Each brief owns a 1:1 `agent_runs` row that carries lifecycle state. (`src/lib/db/briefs.ts`, `src/lib/research/run-brief.ts`)
3. **Schedules** — `recurring_jobs` rows extended with `topic_id` + `brief_template` (migration 077) so the recurring sweep can dispatch via `runBrief` instead of the generic scope-keyed path. (`src/lib/db/recurring-jobs.ts:174-226`, `src/lib/agents/recurring-scheduler.ts:60-146`)

Execution does **not** go through the task pipeline (coordinator/builder/tester/reviewer/ship). Briefs are single-stage role-scoped sessions dispatched via `dispatchScope({ role: 'researcher', agent: runner, ... })` — the runner is the workspace's gateway-bound master and `researcher` is a role-only roster marker that triggers the persona briefing. See `src/lib/research/run-brief.ts:9-35` for the design rationale.

Output flows back into the wider system in two ways:

- **Initiative-scoped briefs** auto-write an `agent_notes` row with `kind='discovery'`, `audience='pm'`, `importance=2`, `source_kind='brief'`, so refine/decompose/audit code that already reads PM-audience notes picks them up with no special integration. (`src/lib/research/run-brief.ts:600-635`)
- **`read_brief` MCP tool** lets the PM (during refine/decompose) and the researcher (during a follow-up brief on the same initiative) fetch the full body of a prior brief. (`src/lib/mcp/groups/read.ts:187-223`)

The `/research` route is the operator-facing hub. The `InitiativeResearchSection` component embeds the same surfaces on each initiative detail page.

## 2. Data model

### 2.1 `topics` — migration 075 at `src/lib/db/migrations.ts:4117-4130`

Long-lived research interest. Workspace-scoped, soft-deleted via `archived_at`.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `workspace_id` | TEXT NOT NULL | FK → `workspaces(id)` ON DELETE CASCADE |
| `name` | TEXT NOT NULL | display label |
| `description` | TEXT NOT NULL DEFAULT '' | framing for the researcher |
| `tags_json` | TEXT NOT NULL DEFAULT '[]' | JSON string[]; round-tripped by `parseTags` (`topics.ts:47-54`) |
| `default_brief_template` | TEXT NULL | reserved; not used by dispatch today |
| `archived_at` | TEXT NULL | soft-delete; archiving auto-pauses schedules (`topics.ts:174-180`) |
| `created_at` / `updated_at` | TEXT NOT NULL | ISO; `datetime('now')` default |

Index: `idx_topics_workspace ON topics(workspace_id, archived_at)` (migrations.ts:4130).

DAO: `createTopic` / `getTopic` / `listTopics` / `updateTopic` / `archiveTopic` / `unarchiveTopic` — `src/lib/db/topics.ts:78-191`. `archiveTopic` calls `pauseSchedulesForTopic(id)` (`recurring-jobs.ts:384-392`).

### 2.2 `agent_runs` — migration 075 at `migrations.ts:4088-4115`, extended in 080/081/085

Shared dispatch envelope for non-task agent work. Briefs were the first kind; jobs-in-progress (PR `c77ecb9`) widened the enum to also cover `pm_chat`, `plan`, `decompose`, `initiative_audit`, `recurring`, `task_coord`, `task_role`.

Current kind enum (per migration 080 at `migrations.ts:4345-4354`):

```
brief | pm_chat | plan | decompose | initiative_audit | recurring | task_coord | task_role
```

Status enum: `queued | running | complete | failed | cancelled`. Transitions enforced in DAO (`src/lib/db/agent-runs.ts:110-116`):

```
queued    → running | cancelled | failed
running   → complete | failed | cancelled
complete  → (terminal)
failed    → (terminal)
cancelled → (terminal)
```

Selected columns relevant to research (`agent-runs.ts:32-68`):

| Column | Type | Where set | Used for |
|---|---|---|---|
| `kind` | enum | `createAgentRun` (`createBriefWithRun`) | `'brief'` for briefs |
| `source_kind` | manual / schedule / event / fanout | `createAgentRun` | distinguishes operator vs scheduled briefs |
| `source_ref` | TEXT | createAgentRun | for `source_kind='schedule'`, holds `recurring_jobs.id`; used by `recordBriefOutcome` (`recurring-jobs.ts:416-462`) |
| `model_used` | TEXT | `markRunning` | populated from `runner.model` |
| `cost_cents` | INTEGER NULL | `markComplete`/`markFailed` | not populated by run-brief today |
| `run_group_id` | TEXT NULL (mig 085) | `dispatch-scope` (not set by run-brief; see §9) | join key for take_note guard |
| `trigger_body` | TEXT NULL (mig 081) | not set by run-brief (managed externally) | jobs drill-down |
| `started_at` / `completed_at` | TEXT NULL | lifecycle transitions | jobs UI, telemetry |

Indexes (migrations.ts:4113-4115, 4394-4401, 4512-4515):
- `idx_agent_runs_workspace_status`, `idx_agent_runs_kind_status`, `idx_agent_runs_created`
- `idx_agent_runs_run_group` (partial)

DAO: `createAgentRun`, `getAgentRun`, `markRunning`, `markComplete`, `markFailed`, `markCancelled`, `getRunByGroupId`, `cancelAgentRun`, `listJobs` (the `/jobs` aggregator). Source at `src/lib/db/agent-runs.ts`.

### 2.3 `briefs` — migration 075 at `migrations.ts:4132-4153`, extended in 089/090

A single research output, optionally attached to a topic and/or an initiative.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `workspace_id` | TEXT NOT NULL | FK → workspaces ON DELETE CASCADE |
| `agent_run_id` | TEXT NOT NULL UNIQUE | FK → agent_runs ON DELETE CASCADE (delete-cascades the brief) |
| `topic_id` | TEXT NULL | FK → topics ON DELETE SET NULL |
| `initiative_id` | TEXT NULL (mig 089) | FK → initiatives ON DELETE SET NULL; partial idx `briefs_initiative_id_idx` |
| `template` | TEXT NOT NULL CHECK | currently only `'general_brief'`; CHECK at migrations.ts:4138-4140 |
| `title` | TEXT NOT NULL | display |
| `prompt` | TEXT NOT NULL | the question sent to the researcher |
| `requested_by` | TEXT NOT NULL DEFAULT 'manual' | `'manual'` / `'schedule'` |
| `source_ref` | TEXT NULL (mig 089/090) | for reruns: `'brief:<original_id>'` |
| `result_md` | TEXT NULL | populated on completion |
| `citations_json` | TEXT NULL | JSON `BriefCitation[]` (`briefs.ts:28-33`) |
| `error_md` | TEXT NULL | populated on failure |
| `summary` | TEXT NULL (mig 089) | first-sentence one-liner, set at completion (`run-brief.ts:577-589`) |
| `created_at` / `updated_at` | TEXT NOT NULL | ISO |

Indexes (migrations.ts:4151-4153, 4644): `idx_briefs_workspace`, `idx_briefs_topic` (partial), `idx_briefs_agent_run`, `briefs_initiative_id_idx` (partial).

**Cascade behavior** (`briefs.ts:262-268`): `deleteBrief(id)` deletes the `agent_runs` row, which CASCADE-deletes the brief. Topic deletion is soft (`archived_at`); a hard topic delete would SET NULL on `briefs.topic_id`.

DAO surface (`src/lib/db/briefs.ts`):
- `createBriefWithRun(input)` — transactional create (`briefs.ts:129-187`); validates `topic_id` belongs to the same workspace and is not archived.
- `getBrief`, `getBriefByAgentRun`, `listBriefs(workspaceId, { topic_id?, initiative_id?, limit })`
- `setBriefResult`, `setBriefError`, `setBriefSummary`
- `deleteBrief`
- `findBriefChainRoot(id)` (`briefs.ts:305-322`) — walks `source_ref` back to the original brief; cycle-safe (32 steps).

### 2.4 `research_suggestions` — migration 076 at `migrations.ts:4181-4204`

Pending PM-generated candidates for new topics or briefs.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `workspace_id` | TEXT NOT NULL | FK → workspaces CASCADE |
| `kind` | `'topic' \| 'brief' \| 'recurring_brief'` | last value reserved |
| `payload_json` | TEXT NOT NULL | per-kind shape (see `research-suggestions.ts`) |
| `rationale` | TEXT NULL | PM's one-line "why" |
| `status` | `'pending' \| 'accepted' \| 'rejected' \| 'dismissed'` | |
| `source_run_id` | TEXT NULL | the suggest agent_run that produced it |
| `accepted_as_id` | TEXT NULL | id of the topic/brief created on accept |
| `decided_at` | TEXT NULL | |
| `created_at` / `updated_at` | TEXT NOT NULL | |

DAO: `src/lib/db/research-suggestions.ts`. Payload types: `TopicSuggestionPayload`, `BriefSuggestionPayload` (which now carries an optional `initiative_id` per slice 2 of the loop).

### 2.5 `recurring_jobs` — research subset (migration 067 base + 077 columns)

Migration 077 (`migrations.ts:4208-4231`) adds two nullable columns to the existing `recurring_jobs` table:

| Column | Type | Notes |
|---|---|---|
| `topic_id` | TEXT NULL | FK → topics (no ON DELETE clause; topics are soft-deleted via archived_at) |
| `brief_template` | TEXT NULL | e.g. `'general_brief'` |

Partial index: `idx_recurring_jobs_topic ON recurring_jobs(topic_id) WHERE topic_id IS NOT NULL`.

When `topic_id IS NOT NULL`, the row is a **research schedule** and the scheduler dispatches via `runBrief` (`recurring-scheduler.ts:60-146`). When NULL, the existing scope-keyed dispatch (`dispatchScope`) runs unchanged.

**Invariant** (enforced in `recurring-jobs.ts:93-98`): `topic_id` and `brief_template` are both set or both null. `createRecurringJob` throws `RecurringJobValidationError` otherwise.

Research-specific DAO surface (`src/lib/db/recurring-jobs.ts`):
- `createResearchSchedule(input)` (`recurring-jobs.ts:210-226`) — convenience constructor; fills the NOT-NULL `scope_key_template`/`briefing_template` columns that research dispatch ignores.
- `listResearchSchedulesForTopic(topicId)` (`recurring-jobs.ts:162-167`)
- `listUpcomingResearch(workspaceId, limit=10)` (`recurring-jobs.ts:174-185`) — active topic-bound rows ordered by `next_run_at ASC`; drives the hub "Upcoming" lane.
- `pauseSchedulesForTopic(topicId)` (`recurring-jobs.ts:384-392`)
- `recordBriefOutcome(agentRunId, outcome)` (`recurring-jobs.ts:416-462`) — async outcome write-back: resolves `recurring_jobs` from `agent_runs.source_ref`, bumps `consecutive_failures` on failure, pauses at threshold.

### 2.6 `agent_notes` — research subset (mig 089 fields)

The research-relevant additions to the existing notes table (`migrations.ts:4615-4656`):

| Column | Notes |
|---|---|
| `source_kind` | TEXT NULL — `'brief'` when written by the auto-note path |
| `source_ref` | TEXT NULL — the brief chain-root id |
| `kind` | enum widened over time; relevant value: `'discovery'` (also used by other discovery flows) |
| `audience` | `'pm'` is the value the auto-note writes |
| `importance` | `2` for auto-notes so refine/decompose/audit pick them up |

Partial index `agent_notes_source_idx ON agent_notes(source_kind, source_ref)` powers the rerun dedupe lookup.

DAO additions (`src/lib/db/agent-notes.ts:120-181, 307-…`):
- `createNote` accepts `source_kind` / `source_ref`.
- `findNotesBySource(source_kind, source_ref)` — used by `writeBriefAutoNote` to soft-archive prior auto-notes when a brief is rerun.
- `archiveNote(id, reason)` — soft-delete via `archived_at` / `archived_reason='superseded_by_rerun'`.

## 3. Brief lifecycle

`src/lib/research/run-brief.ts` is the orchestrator. End-to-end:

1. **Create** — `createBriefWithRun(input)` (`briefs.ts:129-187`) opens a transaction, calls `createAgentRun({ kind: 'brief', source_kind })`, then INSERTs the `briefs` row. Returns `{ brief, agent_run }`.
2. **Dispatch entry** — `POST /api/briefs` (`src/app/api/briefs/route.ts:43`) creates the brief; `POST /api/briefs/[id]/run` (`src/app/api/briefs/[id]/run/route.ts:13`) invokes `runBrief(briefId)`. `POST /api/briefs/[id]/rerun` (`src/app/api/briefs/[id]/rerun/route.ts:24`) creates a new brief carrying `source_ref='brief:<original_id>'` and the original's `initiative_id`, then dispatches it.
3. **Preflight** — `runBrief` (`run-brief.ts:648-690`) validates the brief exists and the agent_run is `queued`. `runBriefInternal` (`run-brief.ts:354-569`) then:
   - Verifies the workspace has a `researcher` roster entry (`resolveResearcherRosterEntry`, `run-brief.ts:107-116`). If not → setBriefError + markFailed + emit `brief_failed`.
   - Verifies a runner agent is registered via `getRunnerAgent()`. If not → fail.
4. **Prompt build** — `buildBriefPrompt({ template, title, prompt, topicContext })` (`run-brief.ts:138-187`). Stacks: `# Research Brief request: <title>` → an explicit **"How to deliver this brief"** override that tells the researcher NOT to call `register_deliverable` / `update_task_status` / `log_activity` (the researcher persona's `AGENTS.md` defaults to task-shaped completion which doesn't apply to briefs) → topic context if any → the operator's question → template-specific output instructions from `TEMPLATE_INSTRUCTIONS` (`run-brief.ts:123-129`) → a `## Sources (REQUIRED)` section instructing the researcher to end with a markdown source list.
5. **markRunning + broadcast** — `markRunning(agent_run_id, { model_used })`, emit `brief_started` (`run-brief.ts:411-414`).
6. **dispatchScope** — `dispatchScope({ workspace_id, role: 'researcher', agent: runner, session_suffix: 'brief-<id>', trigger_body, timeoutMs, attempt_strategy: 'fresh', skip_run_row: true })` (`run-brief.ts:443-456`). The `skip_run_row: true` flag is load-bearing: run-brief manages its own `agent_runs` row externally, so dispatch-scope must not double-write one. **Consequence**: brief runs do not get a `run_group_id` persisted on `agent_runs` (see §9).
7. **no-session retry loop** (`run-brief.ts:437-480`) — when `dispatchScope` returns `reply.reason === 'no_session'` (gateway mid-reconnect during HMR or dev restart), back off `NO_SESSION_RETRY_DELAY_MS` (1500ms) and retry up to `NO_SESSION_MAX_RETRIES` (5). A `brief_progress` event with `state: 'awaiting_gateway'` fires each attempt.
8. **Progress events** — `onEvent` callback throttles `brief_progress` emits to `PROGRESS_BROADCAST_INTERVAL_MS` (750ms, `run-brief.ts:66-67`).
9. **Reply capture** — `extractReplyText(reply.reply, reply.doneEvent)` (`run-brief.ts:288-308`) prefers the **longest assistant message containing a markdown heading**, falling back to the `done` event text, then to concatenation. This handles the failure mode where a researcher narrates around a `register_deliverable` call and the `done` event carries only the narration.
10. **Citation parsing** — `parseCitations(body)` (`run-brief.ts:204-243`): two-pass — extracts the `## Sources` (or `## References`) section first, then sweeps inline `[label](url)` links for any URL not already captured.
11. **Persist result** — `setBriefResult(briefId, { result_md, citations })`, then `setBriefSummary(briefId, extractBriefSummary(body))` (`run-brief.ts:533-539`). Summary is set BEFORE `markComplete` so any SSE consumer waking on `brief_completed` sees it populated.
12. **markComplete** — `markComplete(agent_run_id)`.
13. **Auto-note** — if `brief.initiative_id` is non-null, call `writeBriefAutoNote(brief, body)` (`run-brief.ts:600-635`):
    - `findBriefChainRoot(brief.id)` — walk `source_ref` back to the original brief.
    - `findNotesBySource('brief', chainRoot)` → `archiveNote(prior.id, 'superseded_by_rerun')` for each.
    - `createNote({ kind: 'discovery', audience: 'pm', importance: 2, source_kind: 'brief', source_ref: chainRoot, body: "**Research: <title>**\n\n<excerpt>\n\n[Full brief](/research/briefs/<id>)", role: 'researcher', run_group_id: agent_run_id })`.
    - Failures are caught and logged; the brief itself is not failed by an auto-note write error.
14. **Emit `brief_completed`** — payload includes `citation_count`, `scope_key`, `briefing_bytes`.
15. **Schedule outcome write-back** — `emit` (`run-brief.ts:326-352`) calls `recordBriefOutcome(agent_run_id, 'completed'|'failed')` on terminal events. This is a no-op for non-schedule briefs (`source_kind != 'schedule'`).

Failure modes write `setBriefError(briefId, msg)` + `markFailed(agent_run_id, { error_md })` + emit `brief_failed`. Reasons surfaced in the event payload include: `no_researcher_in_roster`, `no_runner`, `dispatch_threw`, `no_result`, `no_reply`, `no_session`, `send_failed`, `timeout`, `empty_reply`, `orchestrator_crash`.

Default timeout: `DEFAULT_BRIEF_TIMEOUT_MS = 5 * 60 * 1000` (`run-brief.ts:65`). SSE event family: `brief_started`, `brief_progress`, `brief_completed`, `brief_failed` (broadcast via `src/lib/events.ts`).

## 4. Suggest pipeline

`src/lib/research/suggest.ts` — dispatches the workspace **PM** (not researcher) to propose 1–6 candidate topics OR briefs. Synchronous from the API caller's perspective; default timeout `DEFAULT_TIMEOUT_MS = 3 * 60 * 1000` (`suggest.ts:38`).

Public entry: `generateSuggestions(opts: SuggestOptions): SuggestResult` (`suggest.ts:588-695`).

`SuggestOptions` (`suggest.ts:41-55`):
- `workspace_id` (required)
- `kind: 'topic' | 'brief'` — `recurring_brief` is reserved in the schema CHECK but not generated today.
- `initiative_id?` — when set, scope context to a single initiative (slice 2 of the loop).
- `timeoutMs?`

**Branches**:

- **Workspace-scoped** (`initiative_id` absent): `gatherWorkspaceContext(workspaceId)` (`suggest.ts:143-195`) collects up to 30 initiatives, blocked/in-flight tasks (15 per bucket), 20 recent briefs, 30 topics. Built into the prompt by `buildSuggestPrompt(kind, ctx)` (`suggest.ts:391-497`).

- **Initiative-scoped** (`initiative_id` present): `gatherInitiativeContext(workspaceId, initiativeId)` (`suggest.ts:220-288`) returns `{ initiative, parent_chain (≤4 deep), recent_notes (audience='pm', min_importance=1, limit=10, body truncated to 400 chars), prior_briefs (≤25 of `{id, title, summary, status}`), topics (≤30) }`. Built into the prompt by `buildInitiativeSuggestPrompt(kind, ctx)` (`suggest.ts:292-389`). The prompt tells the PM to call `read_brief({brief_id})` on any prior brief whose summary hints at relevance.

**Dispatch**: `dispatchScope({ role: 'pm', agent: pm, session_suffix: 'research-suggest-<kind>-<sessionTag>-<ts>', trigger_body, timeoutMs, attempt_strategy: 'fresh' })` (`suggest.ts:622-632`). Session tag is `workspace` or `init-<8-char-init-id>`.

**Reply parse**: `extractReplyText` (re-exported from run-brief) → `parseSuggestionsResponse(body, kind, validTopicIds)` (`suggest.ts:525-585`). Looks for a `` ```json `` fence first; falls back to bare-object span. Drops candidates missing required fields. Caps at `MAX_SUGGESTIONS_PER_RUN = 6` (`suggest.ts:39`).

**Persist**: `dismissPendingForWorkspaceKind(workspace_id, kind)` clears any prior pending batch (`suggest.ts:677`); then `createSuggestion` per candidate. For initiative-scoped brief suggestions, `payload.initiative_id` is stamped on so accept-flow propagates it (`suggest.ts:683-685`).

**Accept flow**: `POST /api/research/suggestions/[id]` (`src/app/api/research/suggestions/[id]/route.ts:30`) — accept creates the real topic/brief from `payload_json`, sets `status='accepted'`, fills `accepted_as_id`.

## 5. Brief templates

Currently shipped: **`general_brief` only**. Defined in `TEMPLATE_INSTRUCTIONS` at `src/lib/research/run-brief.ts:123-129`:

```
general_brief: Produce a research brief in your standard output format
  (executive summary → key findings with citations → gaps and open
  questions → recommended next steps). Cite sources inline as markdown
  links. Keep the brief between 200 and 2000 words.
```

The template enum is enforced at three levels:

1. TypeScript: `BriefTemplate = 'general_brief'` (`briefs.ts:26`).
2. Schema CHECK: `briefs.template CHECK (template IN ('general_brief'))` at migrations.ts:4138-4140.
3. API allow-list: schedule creation route at `src/app/api/topics/[id]/schedules/route.ts:23-28`.

Adding a template requires widening all three. The PM's reply format in `buildSuggestPrompt` also hard-codes `"template": "general_brief"` in the JSON shape (`suggest.ts:578`).

## 6. Scheduling (recurring research)

### 6.1 Substrate

Migration 077 extends the existing `recurring_jobs` table (originally migration 067, `migrations.ts:3826-3859`) with `topic_id` + `brief_template` instead of creating a new `research_schedules` table. The recurring-scheduler then branches at dispatch on `job.topic_id`. See §2.5 for the data model.

### 6.2 Scheduler branch

`src/lib/agents/recurring-scheduler.ts` runs a sweep every `SWEEP_INTERVAL_MS = 60_000` (line 30) bootstrapped from `instrumentation.ts`. Per-tick:

1. `listDueJobs({ now, limit: 50 })` (`recurring-jobs.ts:232-242`).
2. For each due job, `dispatchRecurringJobOnce(job)` (`recurring-scheduler.ts:177-…`).
3. If `job.topic_id` is set → `dispatchResearchScheduleOnce(job)` (`recurring-scheduler.ts:60-146`); otherwise fall through to the existing scope-keyed `dispatchScope` path.

`dispatchResearchScheduleOnce`:

1. Look up the topic; fail-and-pause if missing or archived.
2. Preflight: workspace must have a researcher roster entry and a runner agent.
3. `markRunInFlight(job.id)` (`recurring-jobs.ts:256-262`) advances `next_run_at` by one full cadence immediately so a slow brief or mid-run restart can't be re-picked.
4. Build the auto-prompt: `<topic.name> · <YYYY-MM-DD>` title; an ASK-shaped prompt that explicitly tells the researcher to reply with the body and not call `register_deliverable` (`recurring-scheduler.ts:96-114`).
5. `createBriefWithRun({ requested_by: 'schedule', source_kind: 'schedule', source_ref: job.id, ... })`.
6. `await runBrief(brief.id)` — but the runBrief promise returns once dispatch has *started*, not on completion (fire-and-forget; the brief surfaces its own outcome via SSE events).
7. On state `'rejected'` → `failResearchSchedule(job, reason)` which calls `markRunFailure` (`recurring-jobs.ts:297-316`) — bumps `consecutive_failures`, pauses at `PAUSE_THRESHOLD = 3` (line 31), backoff = `min(cadence, 600s)`.
8. On started → `markRunSuccess(job.id, scopeKey)` (`recurring-jobs.ts:269-290`).
9. **Async outcome** — when the brief eventually completes/fails, `run-brief.ts:emit()` calls `recordBriefOutcome(agent_run_id, outcome)` (`recurring-jobs.ts:416-462`) which finds the schedule via `agent_runs.source_ref` and resets failures on success or bumps them on failure (paused at `pauseThreshold=3`).

`failResearchSchedule` also writes a high-importance (`importance: 2`) `kind: 'blocker'` PM-audience note when the auto-pause fires, so the operator sees it in PM Chat (`recurring-scheduler.ts:148-175`).

### 6.3 Cadence model

Stored as `recurring_jobs.cadence_seconds INTEGER`. The UI offers a fixed dropdown (`ScheduleDrawer` at `src/components/research/ScheduleDrawer.tsx`); custom integers stay legal via API. Default first-run timing: `now() + cadence_seconds` (wait one cadence) per `createResearchSchedule` (`recurring-jobs.ts:211`); operator can override with `first_run_at` or hit "Run now" which calls `setJobRunNow` (`recurring-jobs.ts:365-370`).

### 6.4 API surface

- `GET  /api/topics/[id]/schedules` — list (any status), returns full RecurringJob rows.
- `POST /api/topics/[id]/schedules` — create research schedule. Body: `{ brief_template, cadence_seconds, name?, first_run_at? }`. Source: `src/app/api/topics/[id]/schedules/route.ts`.
- `GET  /api/schedules/[id]` — single schedule.
- `PATCH /api/schedules/[id]` — body: `{ cadence_seconds?, status? }` where status is `'active' | 'paused'`. Resuming from paused clears `consecutive_failures` and bumps `next_run_at = now()`. Source: `src/app/api/schedules/[id]/route.ts`.
- `DELETE /api/schedules/[id]`.
- `POST /api/schedules/[id]/run-now` — sets `next_run_at = now()` so the next sweep picks it up. Refuses when status is paused (`src/app/api/schedules/[id]/run-now/route.ts:26-31`).
- `GET /api/schedules?workspace_id=…` — list across topics for a workspace.

### 6.5 UI

- `ScheduleDrawer` (`src/components/research/ScheduleDrawer.tsx`, 175 lines) — create/edit form, cadence dropdown.
- `ScheduleRow` (`src/components/research/ScheduleRow.tsx`, 253 lines) — list-row component: shows cadence label, last/next run, paused chip, Run-now / Resume / Delete actions. Exports `ScheduleSummary` type.
- Hub "Upcoming" lane (`src/app/(app)/research/page.tsx:51-92`) — populates from `listUpcomingResearch(workspace, 10)` via `/api/schedules?workspace_id=…`.
- Topic detail page `src/app/(app)/research/topics/[id]/page.tsx` — embeds Schedules section.

## 7. Initiative integration

Couples briefs to initiatives so research output flows back into PM/Roadmap decision-making without a special integration channel.

### 7.1 DB shape

- `briefs.initiative_id` (mig 089) — FK → initiatives ON DELETE SET NULL.
- `briefs.summary` (mig 089) — populated at completion by `extractBriefSummary` (`run-brief.ts:577-589`); first sentence ≤ 160 chars.
- `briefs.source_ref` (mig 089 + 090 fixup) — `'brief:<original_id>'` for reruns.
- `agent_notes.source_kind` + `source_ref` (mig 089) — for the rerun-dedupe lookup.

### 7.2 Suggest → Brief → Auto-note

1. Operator clicks **Suggest research** on InitiativeDetailView → `POST /api/research/suggestions { kind: 'brief', initiative_id }` → PM proposes 1–6 candidates with initiative-scoped context.
2. Operator accepts via `SuggestPickerDrawer` → `POST /api/research/suggestions/[id]` → `createBriefWithRun({ initiative_id, ... })` from the suggestion payload.
3. `runBrief` dispatches researcher; on completion `writeBriefAutoNote` writes a `discovery` note (see §3 step 13). The note format:

   ```
   **Research: <brief.title>**

   <excerpt of result_md, ~600 chars, sentence-aligned>

   [Full brief](/research/briefs/<brief.id>)
   ```

4. Refine (`POST /api/pm/plan-initiative`) and decompose (`POST /api/pm/decompose-initiative`) already prompt the PM to call `read_notes({ initiative_id, audience: 'pm', min_importance: 2, limit: 5 })`. With `importance=2`/`audience='pm'`, the auto-note shows up in that channel with no further integration. (See `docs/archive/initiative-research-loop.md` for the original design call.)

### 7.3 Rerun semantics

`POST /api/briefs/[id]/rerun` (`src/app/api/briefs/[id]/rerun/route.ts:24`) creates a **new brief row** with `source_ref='brief:<original_id>'` and copies the original's `initiative_id`. On completion, `writeBriefAutoNote`:

1. `findBriefChainRoot(new.id)` walks `source_ref` back to the original (cycle-safe, 32-step ceiling at `briefs.ts:305-322`).
2. `findNotesBySource('brief', chainRoot)` returns prior non-archived auto-notes.
3. `archiveNote(prior.id, 'superseded_by_rerun')` soft-deletes each.
4. New auto-note inserted with `source_ref=chainRoot`.

Soft-delete (not in-place update) preserves the audit trail. Notes rail filters out `archived_at IS NOT NULL` so the UI stays clean.

### 7.4 UI surface

`InitiativeResearchSection` (`src/components/research/InitiativeResearchSection.tsx`, 231 lines) — embedded between Description and Children on `InitiativeDetailView` (mounted at `src/components/InitiativeDetailView.tsx:911-934`). Lists briefs scoped to the initiative via `GET /api/initiatives/[id]/briefs` (`src/app/api/initiatives/[id]/briefs/route.ts`). Header buttons drive `SuggestPickerDrawer` (with `initiativeId` prop) and `RunBriefDrawer` (free-form prompt with `initiativeId`).

**Polling, not SSE**: brief status refreshes via `/api/briefs?initiative_id=…` polling (window narrows while queued/running). No new SSE channel was added for v1 of the loop.

### 7.5 API surface

- `GET /api/initiatives/[id]/briefs` — list briefs scoped to the initiative, with joined `agent_runs.status` and `completed_at`.

## 8. Audit pipeline hand-off

The audit/investigate flow (see `docs/archive/initiative-investigate.md`, `docs/archive/subtree-audit-proposals-spec.md`) does NOT directly read `briefs.result_md`. Instead it picks up the research findings via the existing notes channel:

1. `POST /api/initiatives/[id]/investigate` (narrow mode) (`src/app/api/initiatives/[id]/investigate/route.ts:324-359`) builds `priorFindings` via `listNotes({ initiative_id, audience: 'pm', min_importance: 2, limit: 5, order: 'desc' })` when `reaudit === 'build_on'`.
2. Brief auto-notes match that filter exactly (`audience='pm'`, `importance=2`), so they show up to the auditor as prior context.
3. `buildAuditPrompt(input)` (`src/lib/agents/audit-prompt.ts:164`) renders the notes verbatim into the auditor's trigger body.

The subtree-audit synthesizer (mode `'synthesis'`) similarly consumes already-rendered child findings; brief auto-notes flowing into a child initiative's audit then ride up into the parent synthesis through normal note reads.

Conversely, **the researcher's `read_brief` MCP tool** (§11) lets the PM or a follow-up researcher pull a brief's full body when the auto-note's excerpt isn't enough. This is the only direct cross-pipeline reader of `briefs.result_md` outside the brief surfaces themselves.

## 9. Dedupe & cancellation

See `docs/archive/dedupe-investigations.md`. Three components, only the first shipped:

### 9.1 Shipped (PR #1, mig 085 + take_note guard)

- **`agent_runs.run_group_id`** column (mig 085 at `migrations.ts:4498-4516`) — UUID minted in `dispatch-scope.ts`, baked into the agent's briefing, returned on every `take_note` call. Partial index `idx_agent_runs_run_group`.
- **`getRunByGroupId(run_group_id)`** (`agent-runs.ts:356-367`) — single-row lookup, `ORDER BY created_at DESC LIMIT 1`.
- **`take_note` guard** (`src/lib/mcp/groups/core.ts:413-431`) — before `createNote`, look up the owning run; if `status === 'cancelled'`, return an MCP `isError: true` with `structuredContent: { error: 'run_cancelled', message, run_id }`. This blocks orphan notes from workers whose `agent_runs` row was flipped to `cancelled` while they were still executing.

**Brief-dispatch caveat**: `run-brief.ts` passes `skip_run_row: true` to `dispatchScope`, so brief dispatches do NOT get a `run_group_id` written on `agent_runs`. The take_note guard fails open for these (lookup returns null → proceed). Brief auto-notes use `run_group_id: brief.agent_run_id` as a synthetic value (`run-brief.ts:627`).

### 9.2 Open (PR #2 — dispatch-time guard for audits)

`POST /api/initiatives/[id]/investigate` already implements an in-flight check (`src/app/api/initiatives/[id]/investigate/route.ts:74-86`, `:211-…`) and refuses with 409 unless `?supersede=1`. The generic version of that guard for other dispatch paths is not yet built.

### 9.3 Open (PR #3 — UI cooldown)

`lastCompleteAudit` query exists in the investigate route (`route.ts:88-99`) and is returned in the dry-run response, but the audit button does not yet render a "Last audited N min ago — re-audit?" confirm. Not started.

### 9.4 Generalized cancelled-run guard

`docs/archive/dedupe-investigations.md` §Future also calls for extending the `run_cancelled` guard to `register_deliverable`, `log_activity`, `propose_changes`. Not built.

## 10. UI surfaces

Hub layout: `src/app/(app)/research/layout.tsx` mounts `ResearchSideRail` as a persistent left rail; child pages render to the right.

### 10.1 `/research` hub — `src/app/(app)/research/page.tsx` (309 lines)

Three lanes plus an Upcoming lane:

- **In progress** — briefs whose `agent_runs.status` is `queued` or `running`, derived by joining the `/api/briefs?workspace_id=…&limit=20` list to `/api/agent-runs?workspace_id=…&kind=brief&limit=50`.
- **Upcoming** — top 10 due research schedules from `/api/schedules?workspace_id=…` (`listUpcomingResearch`).
- **Recent results** — completed briefs (newest first).

The page subscribes to SSE for `brief_started`, `brief_progress`, `brief_completed`, `brief_failed` (page.tsx:48).

### 10.2 Topic detail — `src/app/(app)/research/topics/[id]/page.tsx` (235 lines)

Description, schedules list (with ScheduleRow per row), brief history scoped to the topic.

### 10.3 Brief detail — `src/app/(app)/research/briefs/[id]/page.tsx` (327 lines)

Header (topic, template, status, requested_by, timestamps), rendered markdown body, citations panel, Rerun affordance.

### 10.4 Side rail — `src/components/research/ResearchSideRail.tsx` (703 lines)

Persistent rail with Topics / Briefs / Schedules sections, pin support (LocalStorage-backed), Suggest entry points. Hosts the global `SuggestPickerDrawer` for workspace-scoped suggestions.

### 10.5 Drawers

- `CreateTopicDrawer` (129 lines) — new topic.
- `RunBriefDrawer` (175 lines) — free-form brief creation; accepts optional `initiativeId`.
- `ScheduleDrawer` (175 lines) — schedule create/edit.
- `SuggestPickerDrawer` (246 lines) — list pending suggestions and multi-accept; accepts optional `initiativeId` filter.

### 10.6 Initiative-embedded section

`InitiativeResearchSection` — see §7.4.

### 10.7 Preflight hook

`src/components/research/useResearchPreflight.ts` (128 lines) — drives the "Add a researcher" / "No runner" empty states. Resolves: workspace has a `role='researcher'` agent row, workspace has a runner (`gateway_agent_id` matching `mc-runner-dev` / `mc-runner`), and gateway is connected. `ok = hasResearcher && hasRunner && gatewayConnected`.

## 11. MCP tool surface

The research capability exposes one dedicated MCP tool plus uses two shared ones:

| Tool | Group | File:line | Description |
|---|---|---|---|
| `read_brief` | read | `src/lib/mcp/groups/read.ts:187-223` | Fetch one brief by id. Returns `{ id, workspace_id, initiative_id, topic_id, template, title, prompt, result_md, summary, citations, error_md, status, completed_at, created_at, updated_at }`. Primary callers: PM (during refine/decompose) and researcher (when investigating an initiative with prior briefs). Read-only. |
| `read_notes` | core | `src/lib/mcp/groups/core.ts:556-603` | General notes read; picks up `kind='discovery'` brief auto-notes for any role with notes access. |
| `take_note` | core | `src/lib/mcp/groups/core.ts:353-553` | The researcher's own notes during a brief use this. Subject to the `run_cancelled` guard (§9.1). Importance-2 notes auto-post to PM Chat. |

There is no dedicated `research` MCP group; `read_brief` lives in `read.ts` to stay role-agnostic. See `docs/archive/initiative-research-loop-build-plan.md` §D4 for the rationale.

## 12. Configuration

Knobs the operator or an agent might tune:

| Setting | Default | Where |
|---|---|---|
| Sweep interval | 60s | `SWEEP_INTERVAL_MS` at `src/lib/agents/recurring-scheduler.ts:30` (constant; not env-tunable) |
| Pause threshold | 3 consecutive failures | `PAUSE_THRESHOLD` at `recurring-scheduler.ts:31` |
| Brief timeout | 5 min | `DEFAULT_BRIEF_TIMEOUT_MS` at `src/lib/research/run-brief.ts:65` |
| Suggest timeout | 3 min | `DEFAULT_TIMEOUT_MS` at `src/lib/research/suggest.ts:38` |
| `MAX_SUGGESTIONS_PER_RUN` | 6 | `suggest.ts:39` |
| no-session retry | 5 attempts × 1500ms | `NO_SESSION_MAX_RETRIES` / `NO_SESSION_RETRY_DELAY_MS` at `run-brief.ts:73-74` |
| Progress broadcast interval | 750ms | `PROGRESS_BROADCAST_INTERVAL_MS` at `run-brief.ts:66` |
| Researcher persona | `src/lib/agent-templates/researcher/{SOUL,AGENTS,IDENTITY}.md` | composed into briefing by dispatch-scope |
| Brief auto-note importance | 2 (`audience='pm'`) | `run-brief.ts:631` |
| Auto-note excerpt length | 600 chars | `excerptResult` at `run-brief.ts:592-598` |
| Summary cap | 160 chars | `extractBriefSummary` at `run-brief.ts:577-589` |

No environment variables are read by the research layer today; everything tunable is a code constant. Workspace-level toggles (e.g. `audit_auto_spawn_pm`) live on the `workspaces` table but do not feed into the research pipeline.

Per `project_openclaw_model.md` the dispatch model is `spark-lb/agent` (self-hosted) — no per-brief cost ceiling enforced. `agent_runs.cost_ceiling_cents` exists in the schema (mig 075) but is never populated by run-brief.

## 13. Eval harness

`src/lib/research/eval/` — deterministic regression bar for brief output quality.

| File | Purpose |
|---|---|
| `fixtures.ts` (57 ln) | Fixture briefs with optional `cannedReply` for offline runs. |
| `rubric.ts` (120 ln) | LLM-judge-style scoring across structural axes (citations present, headings, length 200–2000 words). |
| `rubric.test.ts` | Self-tests on the rubric scorer. |
| `runner.ts` (212 ln) | `runEval(opts)` — ensures workspace + researcher roster + runner, swaps in `__setSendChatClientForTests` for `cannedReply` fixtures, drives `createBriefWithRun` + `runBrief`, scores via rubric, writes per-run JSON report to `tmp/research-eval/<run_id>/`. |
| `runner.test.ts` | Smoke test against canned-reply fixtures. |
| `schedule-runner.ts` (196 ln) | Variant that creates a research schedule with a 1s cadence, observes the sweep firing a brief, asserts terminal state. Used by the phase-2 validation `RP2.S6.1` scenario. |
| `schedule-runner.test.ts` | Smoke. |

Entry point: `scripts/run-research-eval.ts` (referenced from `runner.ts:9`) → `yarn research:eval`.

## 14. Open questions / not yet built

The original `specs/research-area.md` listed phase 3+ aspirations that have not shipped. Status of each:

1. **Template expansion** — only `general_brief` is implemented. `competitive_watch`, `market_scan`, `regulatory_scan`, `decision_support`, `recurring_status` from the original spec are NOT in the code. Adding one requires (a) widening `BriefTemplate` in `briefs.ts:26`, (b) the migration 075 CHECK constraint, (c) a `TEMPLATE_INSTRUCTIONS` entry in `run-brief.ts:123-129`, (d) the schedule API allow-list at `topics/[id]/schedules/route.ts:23-28`, and (e) the suggest PM's reply-shape hint.

2. **Proposals from briefs** — the design called for `regulatory_scan → Calendar`, `competitive_watch → Risks`, `decision_support → Decisions log`, `general_brief → Tasks/Initiatives`. None of these explicit proposal pipelines exist. The closest thing in production is the `agent_notes` auto-note path (§3 step 13) which lets refine/decompose surface a brief's findings as PM proposals via the existing notes-intake flow — that's an indirect, single-channel substitute, not the templated proposal pipeline the original spec described.

3. **Diff view across recurring briefs** — not started. `recurring_status` template doesn't exist; no schema for `last_run_brief_id` linkage; no UI.

4. **Memory layer integration** — briefs do not write to a Memory layer (that layer itself is a separate spec, `specs/memory-layer.md`).

5. **Cost ceilings** — `agent_runs.cost_ceiling_cents` column exists but is never populated or enforced.

6. **Phase tracking / heartbeat on briefs** — flagged as a deferred lift from autopilot in `docs/archive/initiative-research-loop.md` §"Lift from autopilot". Not started.

7. **PR #2 dispatch-time guard for cancelled-run cleanup beyond `take_note`** — `register_deliverable`, `log_activity`, `propose_changes` are still ungated. See `docs/archive/dedupe-investigations.md` §Future.

8. **PR #3 UI cooldown** for repeated audit clicks — not built. (`lastCompleteAudit` data is returned by the dry-run endpoint, ready to drive UI.)

9. **FOIA pipeline** — `specs/foia-pipeline.md` is aspirational. It would be a downstream consumer of the research capability (agency profile briefs feeding a discovery/draft/submit/track loop) but no code exists yet.

10. **Event triggers for schedules** (`event:initiative.status_changed`) — original spec called for cron OR event. Phase 2 shipped cadence-only; event triggers are out of scope.

11. **Workspace-level "research watch" auto-loop** — fires briefs when an initiative changes status. Explicitly out of scope for the initiative-research-loop slice; not started.

12. **Hierarchical context rollup** — a parent initiative's suggest/refine pulling its children's briefs into context. Out of scope; the existing notes channel handles it indirectly.

13. **LLM-generated `briefs.summary`** — currently first-sentence-of-result_md; the build-plan called out LLM-summarization as a deferred follow-up.

## 15. Appendix: file index

### DB / DAO
- `src/lib/db/topics.ts` — Topic CRUD; archive auto-pauses schedules.
- `src/lib/db/briefs.ts` — Brief CRUD; `createBriefWithRun`, `findBriefChainRoot`, `setBriefSummary`.
- `src/lib/db/agent-runs.ts` — Run envelope; `cancelAgentRun`, `getRunByGroupId`, jobs aggregator `listJobs`.
- `src/lib/db/research-suggestions.ts` — Suggestion CRUD; `dismissPendingForWorkspaceKind`.
- `src/lib/db/recurring-jobs.ts` — Schedule CRUD; `createResearchSchedule`, `listUpcomingResearch`, `recordBriefOutcome`, `pauseSchedulesForTopic`, `markRunInFlight`/`Success`/`Failure`.
- `src/lib/db/agent-notes.ts` — Notes CRUD; `findNotesBySource`, `archiveNote`.
- `src/lib/db/migrations.ts` — 075 (4065+), 076 (4160+), 077 (4208+), 080 (4317+), 081 (4407+), 085 (4498+), 089 (4615+), 090 (4660+).

### Service / orchestrators
- `src/lib/research/run-brief.ts` — Brief orchestrator (`runBrief`, `runBriefInternal`, `buildBriefPrompt`, `parseCitations`, `extractReplyText`, `extractBriefSummary`, `writeBriefAutoNote`).
- `src/lib/research/suggest.ts` — Suggest pipeline (`generateSuggestions`, `gatherInitiativeContext`, `gatherWorkspaceContext`, `buildSuggestPrompt`, `buildInitiativeSuggestPrompt`, `parseSuggestionsResponse`).
- `src/lib/agents/recurring-scheduler.ts` — Sweep loop; research branch `dispatchResearchScheduleOnce`.
- `src/lib/agents/dispatch-scope.ts` — Scope-keyed dispatch primitive (research uses it with `skip_run_row: true`).
- `src/lib/agents/runner.ts` — `getRunnerAgent()`.
- `src/lib/agents/pm-resolver.ts` — `getPmAgent(workspace_id)` for suggest dispatch.
- `src/lib/agents/audit-prompt.ts` — Consumer of brief auto-notes via `priorFindings`.
- `src/lib/research/eval/{fixtures,rubric,runner,schedule-runner}.ts` — Eval harness.

### MCP
- `src/lib/mcp/groups/read.ts` — `read_brief`, plus the read-only roadmap/initiative tools.
- `src/lib/mcp/groups/core.ts` — `take_note` (with run_cancelled guard), `read_notes`.

### API routes
- `src/app/api/topics/route.ts` — GET list / POST create.
- `src/app/api/topics/[id]/route.ts` — GET / PATCH / DELETE (DELETE = archive).
- `src/app/api/topics/[id]/schedules/route.ts` — GET / POST.
- `src/app/api/briefs/route.ts` — GET list (workspace + filters) / POST create.
- `src/app/api/briefs/[id]/route.ts` — GET / DELETE.
- `src/app/api/briefs/[id]/run/route.ts` — POST runBrief.
- `src/app/api/briefs/[id]/rerun/route.ts` — POST new-brief-with-source_ref-then-run.
- `src/app/api/schedules/route.ts` — GET list across topics.
- `src/app/api/schedules/[id]/route.ts` — GET / PATCH / DELETE.
- `src/app/api/schedules/[id]/run-now/route.ts` — POST.
- `src/app/api/research/suggestions/route.ts` — GET list / POST generate.
- `src/app/api/research/suggestions/[id]/route.ts` — POST accept/reject/dismiss.
- `src/app/api/initiatives/[id]/briefs/route.ts` — GET briefs scoped to an initiative.
- `src/app/api/initiatives/[id]/investigate/route.ts` — Consumer (reads brief auto-notes as `priorFindings`).

### UI
- `src/app/(app)/research/layout.tsx` — Persistent shell with `ResearchSideRail`.
- `src/app/(app)/research/page.tsx` — Hub.
- `src/app/(app)/research/topics/[id]/page.tsx` — Topic detail.
- `src/app/(app)/research/briefs/[id]/page.tsx` — Brief detail.
- `src/components/research/ResearchSideRail.tsx` — Persistent rail.
- `src/components/research/InitiativeResearchSection.tsx` — Embedded on InitiativeDetailView.
- `src/components/research/CreateTopicDrawer.tsx`
- `src/components/research/RunBriefDrawer.tsx`
- `src/components/research/ScheduleDrawer.tsx`
- `src/components/research/ScheduleRow.tsx`
- `src/components/research/SuggestPickerDrawer.tsx`
- `src/components/research/useResearchPreflight.ts`
- `src/components/InitiativeDetailView.tsx:911-934` — Mount point for `InitiativeResearchSection`.
