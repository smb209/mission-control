# Research Phase 2 — Schedules / Recurring Briefs

**Status:** Draft, awaiting operator OK before any code.
**Spec source:** [docs/reference/research-area.md](research-area.md) §"Schedule".
**Phase 1 reference:** [docs/archive/research-area-build-plan.md](research-area-build-plan.md).
**Workflow contract:** [docs/reference/long-unattended-feature-dev.md](long-unattended-feature-dev.md).
**Validation directory:** [docs/archive/research-phase-2-validation/](research-phase-2-validation/).

## 1. Goal

Operator can attach a recurring schedule to a topic that fires briefs on a cadence ("daily", "weekly", or every N hours) without operator action. The "Upcoming" lane on `/research` populates from due jobs. A topic detail page shows its active schedules with last/next run + enable/disable.

**Non-goals (deferred):**
- Cron expressions (use a simple cadence dropdown — see §3.2).
- Event-driven triggers like `event:initiative.status_changed` (phase 2.5+).
- Diff view across recurring runs (phase 5 per phase-1 plan).
- New brief templates beyond `general_brief` (phase 3).

## 2. Audit — what already exists

- **`recurring_jobs` table** (migration 067, dispatched 2026-01-xx via scope-keyed-sessions phase E1) — generic recurring runner with `cadence_seconds`, `next_run_at`, `consecutive_failures`, `status` (active/paused/done), workspace + initiative + task FKs, sweep index. Already cascade-deletes with workspace.
- **`src/lib/agents/recurring-scheduler.ts`** — 60s sweep loop calling `listDueJobs` → `dispatchScope` → `markRunSuccess`/`markRunFailure`. Pauses after 3 consecutive failures. Boots from `instrumentation.ts` like the DB-backup loop.
- **`src/lib/research/run-brief.ts`** — brief execution entrypoint. Already calls `dispatchScope({ role: 'researcher', ... })`, parses citations, emits `brief_*` SSE events, handles preflight (researcher roster + runner present).
- **Topic + brief CRUD** — `src/lib/db/topics.ts`, `src/lib/db/briefs.ts`, full API surface, hub UI lanes including the "Upcoming" placeholder.
- **`ResearchSideRail`** — has Schedule-shaped slot already (Topics/Briefs sections + per-section actions); a "Schedules" section can slot in alongside.

**What's missing:**
- Binding a recurring_jobs row to `topic_id` + `brief_template` so the scheduler knows to invoke `run-brief` instead of (or in addition to) the generic `dispatchScope` flow.
- API + UI for creating/listing/toggling research schedules.
- Populating the hub's "Upcoming" lane from the next ~10 due research-bound jobs.

## 3. Design decisions

### 3.1 Reuse `recurring_jobs` vs. new `research_schedules` table

**Decision: extend `recurring_jobs` with optional `topic_id` + `brief_template` columns.**

| Option | Pros | Cons |
|---|---|---|
| **A. Extend `recurring_jobs`** ✅ | Reuse sweep loop, retry/backoff, indexes, workspace cascade. One scheduler to reason about. Cheap migration. | Mixes "research brief schedule" semantics with "scope-keyed coordinator session" semantics in one table. |
| B. New `research_schedules` table | Cleaner domain match to spec vocabulary. Topic-scoped queries trivial. | Two scheduler loops; duplicated retry/backoff. More code. Spec calls the entity "Schedule" but doesn't require its own table. |

A wins on YAGNI: the existing table already has every column we need except the two new optional FKs, and we're dispatching against the same `runner` agent through the same `dispatchScope` primitive. Reversibility: trivial — if research schedules outgrow the shared table later, a follow-up migration can split.

**Schema delta (migration ~076):**
```sql
ALTER TABLE recurring_jobs ADD COLUMN topic_id TEXT REFERENCES topics(id) ON DELETE CASCADE;
ALTER TABLE recurring_jobs ADD COLUMN brief_template TEXT; -- e.g. 'general_brief'
CREATE INDEX idx_recurring_jobs_topic ON recurring_jobs(topic_id) WHERE topic_id IS NOT NULL;
```

When `topic_id IS NOT NULL`, the scheduler invokes `run-brief` for that topic with the named template. When NULL, the existing scope-keyed dispatch path runs unchanged.

### 3.2 Cadence model

**Decision: simple cadence dropdown stored as `cadence_seconds`.**

The spec calls for "cron expr or `event:<name>`". Cron is overkill for the operator's expected use ("survey this topic weekly"); a fixed dropdown covers 90% of cases without a parser, timezone-handling, or DST surface area:

| Label | `cadence_seconds` |
|---|---|
| Hourly | 3600 |
| Every 4 hours | 14400 |
| Daily | 86400 |
| Every 2 days | 172800 |
| Weekly | 604800 |
| Bi-weekly | 1209600 |
| Monthly (28d) | 2419200 |

`recurring_jobs.cadence_seconds INTEGER` already exists; no migration needed for cadence. The dropdown is a UI-side affordance that round-trips to/from seconds. Custom integers stay legal (operator can set any value via API).

Cron support, if ever needed, can land as a separate `cadence_cron TEXT` column later without breaking phase 2.

### 3.3 `next_run_at` computation

After a successful run, `next_run_at = max(now(), prev_next_run_at) + cadence_seconds` so a paused-then-resumed job doesn't fire all the missed runs at once. After a failure, exponential backoff up to one cadence window (already implemented in `markRunFailure` per scope-keyed-sessions phase).

Schedule creation seeds `next_run_at` to either `now()` (run immediately on first sweep) or `now() + cadence_seconds` (wait one full cadence). UI default: **wait one cadence** with a "Run now" button on the schedule row that the operator can hit on demand.

### 3.4 Pause-on-failure UX

The existing `consecutive_failures >= 3 ⇒ status='paused'` semantic stays. UI surfaces a paused schedule with an amber pill + "Resume" action that resets failures and bumps `next_run_at = now()`.

### 3.5 Cost ceiling

Per `project_openclaw_model.md`, the model is self-hosted — no per-brief cap enforced. Schedule creation does NOT take a cost arg. If the model picture changes, add `cost_ceiling_cents` later.

### 3.6 Concurrency

Recurring sweeps fire one job at a time (sweep loop is sequential). A long-running brief therefore delays the next sweep but never overlaps itself. Operator-driven briefs (`/api/briefs` POST) and scheduled briefs share the same `dispatchScope` queue — no special mutual-exclusion needed for phase 2.

## 4. Slice plan

Stacked PRs, each targeting the previous slice's branch. Per `feedback_stacked_pr_merges.md`: retarget children to `main` BEFORE merging the parent with `--delete-branch`.

| # | Branch | Scope | Files | Becomes testable |
|---|---|---|---|---|
| 1 | `feat/research-phase-2/schema` | Migration: add `topic_id`/`brief_template` columns + index. DAO updates: `createRecurringJob` accepts optional research fields; new helpers `listResearchSchedulesForTopic`, `listUpcomingResearch`. Unit tests. | `src/lib/db/migrations.ts`, `src/lib/db/recurring-jobs.ts`, `src/lib/db/recurring-jobs.test.ts` | DAO CRUD + workspace cascade + listing |
| 2 | `feat/research-phase-2/scheduler-branch` | Scheduler branch: when `topic_id IS NOT NULL`, dispatch via `run-brief` instead of `dispatchScope`. Fail-and-mark on missing researcher / runner (uses same preflight as manual run). Unit tests with stubbed `run-brief`. | `src/lib/agents/recurring-scheduler.ts`, `recurring-scheduler.test.ts` | Sweep emits a brief row + advances `next_run_at` |
| 3 | `feat/research-phase-2/api` | REST surface: `POST /api/topics/[id]/schedules`, `GET /api/topics/[id]/schedules`, `PATCH /api/schedules/[id]` (enable/pause/resume + cadence change), `DELETE /api/schedules/[id]`, `POST /api/schedules/[id]/run-now` (forces `next_run_at=now()`). Workspace-scoped. | `src/app/api/topics/[id]/schedules/...`, `src/app/api/schedules/...` | curl smoke covers the lifecycle |
| 4 | `feat/research-phase-2/ui` | `ScheduleDrawer` for create/edit. Topic detail page gains a "Schedules" section (list + actions). Hub "Upcoming" lane populates from `listUpcomingResearch(workspace, limit=10)` with topic + cadence + next-run timestamp. Rail gains optional Schedules count badge. | `src/components/research/ScheduleDrawer.tsx`, `src/app/(app)/research/topics/[id]/page.tsx`, `src/app/(app)/research/page.tsx`, `src/components/research/ResearchSideRail.tsx` | Manual UI walkthrough; SSE keeps Upcoming live |
| 5 | `feat/research-phase-2/eval` | Extend `yarn research:eval` to include a "scheduled run" scenario that creates a job with cadence_seconds=1, observes the sweep firing, and asserts brief produced. | `src/lib/research/eval/...`, `package.json` script | Validation scenario `RP2.S6.1` automatable |

Per-slice PR body uses the standard `## Summary / ## Changes / ## Test plan` shape. Each PR links this build plan and lists which `02-test-plan.md` scenarios are now exercisable.

## 5. Test strategy per slice

- **Slice 1**: DAO unit tests against `test-isolation.test.ts` pattern — create with topic, list by topic, workspace cascade deletes, index used (EXPLAIN QUERY PLAN check).
- **Slice 2**: scheduler tests with a stubbed `run-brief` returning success / failure / preflight-fail; assert `next_run_at` advance, `consecutive_failures` increment, pause at 3.
- **Slice 3**: API contract tests — status codes, payload shape, workspace scoping, auth. No DB mocks.
- **Slice 4**: component smoke + preview verification (see §6).
- **Slice 5**: eval-harness self-test.

Real-agent validation runs only after slices 1–4 land — see [research-phase-2-validation/02-test-plan.md](research-phase-2-validation/02-test-plan.md). All real-agent dispatches use `spark-lb/agent` per `project_openclaw_model.md`.

## 6. Preview verification flow (standard for long unattended work)

This is the operator-facing playbook. Same pattern applies to any unattended feature whose changes are observable in the Next.js dev server.

### When to verify
After a slice lands code that is **observable in `/research` or related routes** — UI tweaks, API responses surfaced in the UI, SSE events. Type-only edits, DB-only migrations, and pure scheduler logic skip this step (they're covered by unit tests + the agent-driven `02-test-plan.md`).

### The flow

1. **Start preview** (skip if running):
   ```
   preview_start { name: "mission-control-dev" }
   ```
2. **Reach a deterministic state.** For research-phase-2 specifically: `yarn db:reset` against the dev DB, then re-seed any baseline topics from `01-pre-check-initialization.md`. The dev DB at `:4010` is fully separate from prod (`project_dev_prod_db_split.md`) so wipes are safe.
3. **Drive the scenario via real interactions, not just JS:**
   - `preview_eval window.location.href = '/research'` to navigate.
   - `preview_snapshot` to read the page (PREFERRED over screenshot for verifying text).
   - `preview_eval` only for clicks/state reads — never to **implement** UI behavior.
4. **Check signals in priority order:**
   1. `preview_console_logs { level: "error" }` — filter to errors only; stale parse errors from earlier rebases will appear and can be ignored once the file is verified clean.
   2. `preview_logs` — server side; the ground truth for SSE / API / dispatch failures (per CLAUDE.md, treat preview_logs as ground truth, not Claude's self-assessment).
   3. `preview_network` — only if an API response shape is in question.
5. **Capture proof for the operator:**
   - `preview_screenshot` — for visual changes (nav layout, drawer, lane content).
   - `preview_snapshot` — for "the right text appeared on the page".
   - For SSE-driven changes (Upcoming lane refresh), trigger the event then snapshot ~1.5s later (matches phase-1 SSE pattern).
6. **Reset viewport between slices** if you resized — `preview_resize { preset: 'desktop' }`. The screenshot tool can otherwise stick at a non-md viewport and mislead.

### Common gotchas (already-burned in this repo)
- **Stale parse errors** in `preview_console_logs` after a mid-rebase resolution. Verify `grep -n "<<<<<<<" <file>` returns nothing before trusting them.
- **Screenshot viewport drift** — the headless browser sometimes lands at a sub-`md` viewport, which hides the desktop nav. Always re-issue `preview_resize { preset: 'desktop' }` if anything looks like a mobile layout.
- **LAN dev origins** — if previewing from another machine on the LAN, that origin must be in `next.config.mjs` `allowedDevOrigins` (per `project_lan_dev_origins.md`) or HMR returns 403 and hydration silently hangs.

### What the operator sees at the end
Per the long-unattended contract, the verdict in `04-e2e-run-results.md` is the document the operator reads to decide ship/no-ship. It links the captured screenshots, snapshots, and `/tmp/mc-validation/research-phase-2/` transcripts. Do not summarize the diff — the operator can read it; summarize the outcome.

## 7. Decisions locked in (2026-05-04)

1. **Default cadence in the UI:** Weekly.
2. **First-run timing:** Wait one cadence (`next_run_at = now() + cadence_seconds`). Every schedule row has a "Run now" affordance so the operator can fire off-cadence at any time — that's a hard requirement, not optional UX polish.
3. **Topic deletion cascade:** New `recurring_jobs.topic_id` FK is `ON DELETE CASCADE` so deleting a topic removes its schedules.
4. **"Upcoming" cap:** Top 10 due-soonest.
5. **Auto-title for scheduled briefs:** `<topic.name> · <YYYY-MM-DD>`.

## 8. Out of scope

- Cron expressions / timezone-aware schedules.
- Event triggers (`event:initiative.status_changed` etc).
- New templates beyond `general_brief`.
- Diff view across recurring runs (phase 5 per phase-1 plan).
- Per-schedule cost ceiling.
- Notifications when a scheduled brief lands (will piggyback the existing `brief_completed` SSE — operator sees it in the feed already).
- Multi-workspace schedules (workspace-scoped only).
