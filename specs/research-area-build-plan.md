# Research Area — Build Plan (Phase 1)

> **Spec:** [`research-area.md`](research-area.md)
> **Validation:** [`research-area-validation/`](research-area-validation/)
> **Workflow contract:** [`long-unattended-feature-dev.md`](long-unattended-feature-dev.md)
> **Phase 1 scope:** Topics + Briefs tables, manual "run a brief" with `general_brief` template, hub dashboard skeleton. No schedules, no other templates, no proposals-from-briefs. Those are phase 2+.

---

## 1. Audit — what we lean on

| Need | Existing primitive | Notes |
|---|---|---|
| Persistence | `better-sqlite3` + `src/lib/db/migrations.ts` (additive only) + per-feature DAO files | Migration 069+ free; DAO pattern: `src/lib/db/<feature>.ts` + colocated `<feature>.test.ts` |
| Workspace scoping | `workspaces` table; `useCurrentWorkspaceId` hook on the client | Briefs/topics workspace-scoped |
| Researcher persona | `agent-templates/researcher/{SOUL,AGENTS,IDENTITY}.md` + sync into `agents` rows via `agent-catalog-sync.ts` | Already has clean output format ("Executive summary, key findings with citations, gaps, next steps") — directly usable for `general_brief` |
| Agent dispatch | Two paths exist: full-task pipeline (`/api/tasks/[id]/dispatch` via `internal-dispatch.ts`) and PM dispatch (`src/lib/agents/pm-dispatch.ts`) | Neither is a clean fit for "fire-and-forget agent run that produces a structured report" — see §2 |
| Recurring schedules | `recurring_jobs` table + `src/lib/agents/recurring-scheduler.ts` | Not used in phase 1; phase 2 schedules will plug into it |
| Streaming progress | `src/lib/events.ts` + activity log | Add a new `research.brief.*` event family |
| Cost telemetry | `src/lib/costs/` + `src/components/costs/` | Surface per-brief cost in the brief detail view |
| UI shell | `(app)/<route>/page.tsx` server components; `Drawer`, `ConfirmDialog`, `AlertDialog` per CLAUDE.md | Spec page already stubs `/research`; replace with real surface in slice 4 |
| Markdown rendering | `react-markdown` + `remark-gfm` + `prose-invert` | Brief result rendering reuses this |

## 2. Design decisions

### 2.1 Don't reuse `tasks` for non-deliverable agent work

The operator asked the meta-question: **does it make sense to widen `task_kind` to cover briefs, sweeps, calendar readiness checks, and comms drafts?**

**No.** Tasks are an opinionated five-stage pipeline (coordinator → builder → tester → reviewer → ship → deliverable) with gates, evidence, role transitions, and deliverable file output. Briefs/sweeps/etc. are categorically different: single-stage, structured-data output, no PR, no kanban presence. Forcing them into `tasks` means:
- Branching half the lifecycle code on `task_kind`
- Bloating the kanban + coordinator gates with non-task work that has to be filtered out
- Mixing "is this work" with "is this an agent invocation" — two distinct concepts

### 2.2 Introduce `agent_runs` as the shared dispatch envelope

The right factoring is one table for **the dispatch envelope** + per-kind tables for the **domain output**.

```
agent_runs                          briefs
├─ id (uuid)                        ├─ id (uuid)
├─ workspace_id                     ├─ workspace_id
├─ kind ("brief" | "sweep" |        ├─ topic_id (nullable)
│        "readiness_check" | …)     ├─ title
├─ status (queued/running/           ├─ template
│         complete/failed/            ├─ prompt
│         cancelled)                 ├─ result_md (nullable)
├─ started_at                       ├─ citations_json (nullable)
├─ completed_at                     ├─ requested_by
├─ error_md (nullable)              ├─ agent_run_id ─────► agent_runs.id (1:1)
├─ openclaw_session_id (nullable)   ├─ created_at
├─ cost_cents (nullable)            └─ updated_at
├─ model_used (nullable)
├─ source_kind ("manual" |
│               "schedule" |
│               "event" | …)
├─ source_ref (nullable)
└─ created_at
```

**What this buys us:**
- A single cross-kind "what's the agent doing right now?" surface (filters on `agent_runs.status='running'`)
- Centralized cost/model/session attribution
- Per-kind tables stay narrow and domain-specific
- New surfaces (sweeps, comms drafts, etc.) reuse the envelope without re-deriving lifecycle conventions

**What this costs us:**
- One extra `INSERT` per brief creation (in a transaction with the brief insert)
- A small amount of join cost on the brief detail view

**Reversibility:** high — additive tables, no existing data to migrate. If the abstraction proves wrong, drop `agent_runs` and inline its columns into each per-kind table.

### 2.3 Brief execution = dispatched researcher mission, no openclaw worker container

For phase 1, briefs run as a **direct openclaw `send-chat` call** to the researcher persona, NOT through the full worker-task pipeline. Rationale:
- Briefs don't need a workspace clone, git ops, deliverable storage, or a coordinator — all of that is dead weight
- The output is markdown + citations, returned in the model's response, parsed and persisted
- Using `send-chat` means we get streaming via the existing event surface for free

Implementation: `src/lib/research/run-brief.ts` — orchestrator that:
1. Inserts `agent_runs` row (status `queued`)
2. Builds the prompt from template + topic context + user prompt
3. Calls `openclaw/send-chat.ts` against the researcher persona
4. Streams chunks → updates `agent_runs.status` → emits `research.brief.progress` events
5. On completion: parses response into `result_md` + `citations_json`, marks `agent_runs.status='complete'`, emits `research.brief.completed`
6. On failure: writes `error_md`, marks `failed`, emits `research.brief.failed`

Failures surface to the brief detail view; we do not auto-retry in phase 1.

### 2.4 Citations format

Researcher persona's output already includes citations in markdown form. Phase 1 stores the raw rendered `result_md` for display + a parsed `citations_json` (best-effort regex over markdown links + footnote refs) for downstream querying. If parsing fails, we keep `result_md` and leave `citations_json = null`. Don't block the brief on citation parse fidelity in phase 1.

### 2.5 Web access

The researcher persona has `web_search` listed in its `knowledge_role` enum (per `migrations.ts:972`). Openclaw worker tools include WebFetch by default. Phase 1 assumes the persona has functional web access via `send-chat`'s default tool surface; validation will confirm. If web access is gated separately, we surface that as a BLOCKED finding in `04-e2e-run-results.md` and treat web-tool-wiring as a phase-1.5 dependency.

## 3. Slice plan (stacked PRs)

Branch base: `feat/research-phase-1` off `main`. Each slice is its own branch off the previous; final merge order documented in `feedback_stacked_pr_merges.md`.

| # | Branch | Scope | Files (approx) | Becomes testable |
|---|---|---|---|---|
| 1 | `feat/research-phase-1/db` | Migration 069: `agent_runs` + `topics` + `briefs` tables. DAO files with CRUD + transitions. Unit tests for DAOs (insert, status transitions, FK behavior). | `src/lib/db/{agent-runs,topics,briefs}.ts` + tests; `migrations.ts` | Schema correctness in isolation |
| 2 | `feat/research-phase-1/api` | REST endpoints: `GET/POST /api/topics`, `GET /api/briefs`, `POST /api/briefs` (creates brief + agent_run, returns IDs without dispatching), `GET /api/briefs/[id]`, `GET /api/agent-runs?kind=brief&status=running`. Workspace-scoped via header/query. Tests: shape + auth. | `src/app/api/{topics,briefs,agent-runs}/...` + tests | API contract; shape stability |
| 3 | `feat/research-phase-1/dispatch` | `src/lib/research/run-brief.ts` orchestrator. Wire `POST /api/briefs/[id]/run` to invoke it. Emit `research.brief.{started,progress,completed,failed}` events. Unit tests against a stubbed `send-chat`. | `src/lib/research/...`; `src/app/api/briefs/[id]/run/...`; `src/lib/events.ts` (additive) | Mock-LLM brief execution path |
| 4 | `feat/research-phase-1/ui` | Replace `(app)/research/page.tsx` with the real hub: "In progress / Upcoming (placeholder) / Recent results" lanes + topic library. Topic detail at `/research/topics/[id]`. Brief detail at `/research/briefs/[id]`. "Run a brief" drawer with template chooser (only `general_brief` enabled). Live updates via SSE on `research.brief.*`. | `(app)/research/...`; `src/components/research/...` | Operator-driven brief creation + display |
| 5 | `feat/research-phase-1/eval` | Eval harness: deterministic fixture topics + prompts + an LLM-judge rubric (citations present? structure correct? appropriate length?). Yarn script `yarn research:eval`. Captures results to `tmp/research-eval/`. Used in validation `S6.*` scenarios. | `src/lib/research/eval/...`; `package.json` script | LLM-output-quality regression bar |

Per-slice PR body structure (per CLAUDE.md):
```
## Summary
<1–3 bullets>
## Changes
<files + behavior delta>
## Test plan
- [ ] yarn test --tests src/lib/db/<files>
- [ ] curl smoke (where applicable)
- [ ] Manual UI walkthrough (slice 4 only)
- [ ] Validation scenarios newly exercisable: <list>
```

## 4. Test strategy

### Per-slice unit tests
- Slice 1: DAO behavior (CRUD, status transitions, FK cascades, workspace isolation), 100% on the new modules.
- Slice 2: API contract tests (status codes, payload shape, workspace scoping, auth). No DB mocking — use the test-isolation pattern from `src/lib/db/test-isolation.test.ts`.
- Slice 3: Orchestrator tests against a stubbed `send-chat` (input prompt assembly, event emission order, error path).
- Slice 4: Component snapshot + interaction tests where they exist; otherwise covered by validation scenarios.
- Slice 5: Eval-harness self-test (fixtures load, judge runs, scoring stable across invocations on the same input).

### Validation scenarios (real-agent)
See [`research-area-validation/02-test-plan.md`](research-area-validation/02-test-plan.md). Run after slice 4 lands; slice 5 makes them automatable.

### Pre-existing failures
Per CLAUDE.md, baseline `yarn test` once before slice 1 lands and inventory failures in the build-plan PR description so we know what's our breakage vs. what's pre-existing.

## 5. Open questions

1. **Citations parser fidelity** — phase 1 ships best-effort regex. Worth promoting to a structured-output researcher prompt (return JSON alongside markdown) in phase 2?
2. **Topic deletion semantics** — soft-delete (`archived_at`) keeps brief history readable. Confirm.
3. **Cost cap per brief** — should we enforce a per-brief token ceiling? Default off in phase 1 (per `project_openclaw_model.md` model is self-hosted). Add the column now (`agent_runs.cost_ceiling_cents`) so we don't migrate later.
4. **Eval rubric** — start with 3 axes (citations present, structure follows researcher SOUL output format, length 200–2000 words). Add factual-accuracy axis only when we have ground-truth fixtures.

## 6. Out of scope (phase 1)

- Schedules / recurring briefs (phase 2)
- Templates beyond `general_brief` (phase 3)
- Brief proposals → Calendar/Risks/Decisions (phase 4)
- Diff view across recurring briefs (phase 5)
- Memory integration (depends on Memory layer)
- Cost ceilings enforced (column added, behavior off)
- Multi-workspace topics (phase 1 is workspace-scoped; "global" is post-MVP)
- Concurrent-brief throttling (phase 1 lets the operator fire as many as they want; throttling lands when we hit a real failure mode)
