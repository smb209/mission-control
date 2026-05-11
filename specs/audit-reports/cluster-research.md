# Cluster: Research / Investigate

Audit date: 2026-05-11. Branch: `feat/audit-action-recommended`.

## Verdict table

| Spec | Class | Rationale | Evidence |
|---|---|---|---|
| `docs/archive/initiative-investigate.md` | 4 (Historical / superseded) | Investigate flow shipped: `scope_type='initiative_audit'` enum value, `/api/initiatives/[id]/investigate` route, audit prompt, take_note capture. Spec retains useful design narrative but no longer drives new work; supersession captured by sibling `dedupe-investigations.md` follow-ups. | `src/lib/db/migrations.ts:4235` (mig 078 adds `initiative_audit` to mc_sessions.scope_type); `src/app/api/initiatives/[id]/investigate/route.ts`; `src/lib/agents/audit-prompt.ts` |
| `docs/archive/initiative-research-loop.md` | 4 (Historical — shipped) | Five-slice plan shipped: `briefs.initiative_id`, `briefs.summary`, `agent_notes.source_kind`/`source_ref`, suggest pipeline branch, auto-note on completion, `read_brief` MCP tool, InitiativeResearchSection UI. | `src/lib/db/briefs.ts:40,59,167` (initiative_id col); `src/lib/db/agent-notes.ts:91,164,307` (source_kind/source_ref + `findBySource`); `src/lib/mcp/groups/read.ts:188`; `src/components/research/InitiativeResearchSection.tsx`; `src/app/api/initiatives/[id]/briefs/route.ts` |
| `docs/archive/initiative-research-loop-build-plan.md` | 4 (Historical — shipped) | Companion build plan to the spec above. All five slices visible in code. | Same as parent spec. |
| `docs/archive/initiative-research-loop-validation/` | 4 (Historical) | Post-hoc validation directory. Per operator guidance: archive candidate by definition. | `00..04-*.md` results docs present. |
| `specs/research-area.md` | 4 (Historical — phase 1+2 shipped, later phases not in scope here) | Phase 1 (`topics` + `briefs` + `agent_runs`) shipped via migration 075. Phase 2 (schedules) shipped via migration 077. Phases 3-5 (templates, proposals-from-briefs, diff view) are deferred per phase-2 plan §8; they live in `research-area.md` §"Phase plan" but were never re-specced. Treating as historical because the active spec is consumed by the build plans; remaining work is captured as "out of scope" tails, not aspirational asks. | `src/lib/db/migrations.ts:4070-4155` (mig 075); `src/lib/db/{topics,briefs,agent-runs}.ts`; `src/components/research/*` |
| `docs/archive/research-area-build-plan.md` | 4 (Historical — phase 1 shipped) | Phase 1 slices 1–4 all visible in code; eval harness slice 5 partially present (`src/lib/research/eval/`). | `src/lib/research/eval/`; `src/lib/research/run-brief.ts`; migration 075. |
| `docs/archive/research-area-validation/` | 4 (Historical) | Post-hoc validation. | Directory present with 00-04 + README. |
| `docs/archive/research-phase-2-schedules-build-plan.md` | 4 (Historical — shipped) | Migration 077 adds `recurring_jobs.topic_id` + `brief_template`; scheduler branch, schedules API, ScheduleDrawer UI all present. | `src/lib/db/migrations.ts:4208-4230` (mig 077); `src/lib/db/recurring-jobs.ts:170,197,205`; `src/app/api/schedules/[id]/`, `src/app/api/topics/[id]/schedules/`; `src/components/research/ScheduleDrawer.tsx`, `ScheduleRow.tsx` |
| `docs/archive/research-phase-2-validation/` | 4 (Historical) | Post-hoc validation. | Directory present. |
| `specs/foia-pipeline.md` | 2 (Current & aspirational) | Zero code: no `foia_*` tables, no `foia.ts` DAO, no MCP tools (`upsert_agency`, `mark_submitted`, etc.), no `/requests` or `/agencies` routes. Only echo of "foia" string is a workspace-slug fixture in `bootstrap-agents.test.ts`. The initiative tree the spec leans on may exist on the dev DB but the implementation slices have not started. | `grep foia_ src/lib/db/` returns nothing; `src/app/(app)/` has no `requests`/`agencies`; `src/lib/mcp/groups/{core,crud,pm,read,work}.ts` lack the listed tools |
| `specs/dedupe-investigations.md` | 4 (Historical — PR #1 shipped; #2/#3 still flagged as future) | Spec's PR-#1 scope (migration 085 + `run_group_id` on `agent_runs` + take_note guard) is fully shipped. The spec itself documents #2 and #3 as "Future (not this PR)" — they remain open by design, not drift. Archive candidate because the shipped-PR portion is the spec's core, but operator may want to keep it as the open backlog reference for #2/#3. | `src/lib/db/migrations.ts:4497-4514` (mig 085); `src/lib/db/agent-runs.ts:63,356` (`run_group_id`, `getRunByGroupId`); `src/lib/mcp/groups/core.ts:37,421-429` (run_cancelled guard) |

## Per-spec notes

### initiative-investigate.md
- Classification: **4**
- Spec claims: new `scope_type='initiative_audit'`, `POST /api/initiatives/:id/investigate`, narrow+subtree modes, audit prompt, take_note capture, PM read-notes integration, workspace settings for timeout/concurrency.
- Code reality: scope_type shipped (migration 078, `src/lib/db/migrations.ts:4235`). Investigate route + audit prompt + take_note flow present (`src/app/api/initiatives/[id]/investigate/route.ts`, `src/lib/agents/audit-prompt.ts`). Set-status enum extension for `done`/`cancelled` (spec §"Schema gap") would need re-verification, but the audit pipeline itself works.
- Recommendation: **Archive** (move to `specs/archive/`). Keep accessible because the prompt-iteration loop and subtree-fanout decisions are still useful design context.
- Cross-cluster overlap: pairs tightly with `dedupe-investigations.md` (same audit flow, deduping its dispatches).

### initiative-research-loop.md + build plan + validation/
- Classification: **4**
- Spec claims: `briefs.initiative_id`, `briefs.summary`, `agent_notes.source_kind`/`source_ref`, suggest scope-branch, auto-note kind=`discovery`, rerun-replace, `read_brief` MCP tool, InitiativeDetailView Research section.
- Code reality: every line item present. Confirmed file:line: `src/lib/db/briefs.ts:167` (insert writes `initiative_id`), `src/lib/db/agent-notes.ts:307` (`findBySource`), `src/lib/mcp/groups/read.ts:188` (`read_brief` registered), `src/lib/mcp/groups/read.test.ts:48`.
- Recommendation: **Archive** all three artifacts as a unit (`initiative-research-loop*` + validation dir).
- Cross-cluster overlap: depends on Research Area phase 1; no external overlap.

### research-area.md + build plan (phase 1) + validation/
- Classification: **4**
- Spec claims: `topics` / `briefs` / `agent_runs` envelope; researcher dispatch; `/research` hub; templates beyond `general_brief` deferred.
- Code reality: migration 075 creates the three tables (`src/lib/db/migrations.ts:4089-4155`). `src/lib/research/run-brief.ts` orchestrates dispatch. UI at `src/app/(app)/research/` and `src/components/research/`. Only one template (`general_brief`) — matches the documented phase scoping.
- Recommendation: **Archive** the build plan + validation dir. Optionally keep `research-area.md` as a slim "phases roadmap" reference (its phases 3–5 capture aspirational templates / proposals-from-briefs) — but those phases never had a follow-up build plan, so they're really backlog-as-prose, not a spec. Cleanest move: archive everything and re-spec phase 3+ when work resumes.

### research-phase-2-schedules-build-plan.md + validation/
- Classification: **4**
- Spec claims: extend `recurring_jobs` with `topic_id` + `brief_template`; scheduler branch to `run-brief`; schedules API + UI; "Upcoming" lane.
- Code reality: migration 077 (`src/lib/db/migrations.ts:4208-4230`), `src/lib/db/recurring-jobs.ts:170` (`listUpcomingResearch`), schedules API routes, `ScheduleDrawer.tsx` + `ScheduleRow.tsx`.
- Recommendation: **Archive**.

### foia-pipeline.md
- Classification: **2 (Current & aspirational)**
- Spec claims: four new tables (`foia_agencies`, `foia_statutes`, `foia_requests`, `foia_correspondence`); 12 new MCP tools (`upsert_agency`, `mark_submitted`, `record_response`, etc.); `/requests` and `/agencies` pages; PII regex gate; deadline tracking via Coordinator sweep.
- Code reality: **none of it shipped.** No `foia_*` tables in `src/lib/db/migrations.ts`, no `src/lib/db/foia.ts`, no MCP tools in `src/lib/mcp/groups/*.ts`, no `/requests` or `/agencies` routes. Only "foia" string appearance is a workspace-slug fixture in `src/lib/bootstrap-agents.test.ts`.
- Missing list: all four tables, all 12 tools, both new UI pages, statute seed data, PII detection, daily sweep wiring.
- Recommendation: **Keep as-is** — this is the canonical aspirational spec for the FOIA pipeline and remains accurate to operator intent. When work resumes, write a build plan against it.
- Cross-cluster overlap: leans on the existing `tasks` + `initiatives` tables (out-of-cluster, fine). The "weekly report" sentence overlaps with PM standup mechanics but is one-line and harmless.

### dedupe-investigations.md
- Classification: **4** (shipped portion) — operator may prefer keeping it open as backlog for the explicit "Future" items.
- Spec claims: PR #1 = `run_group_id` on `agent_runs` + take_note refuse-when-cancelled. PR #2 (dispatch-time guard) and PR #3 (UI cooldown) explicitly named as future.
- Code reality: PR #1 fully shipped. Migration 085 adds `run_group_id` (`src/lib/db/migrations.ts:4497-4514`), DAO surface at `src/lib/db/agent-runs.ts:356` (`getRunByGroupId`), take_note guard at `src/lib/mcp/groups/core.ts:421-429` emitting `{error:'run_cancelled'}`. PR #2 + #3 still absent (no concurrent-audit 409 in investigate route; no "last audited X ago" UI hint).
- Recommendation: **Archive** the spec but file follow-up tickets for the documented #2/#3 work, or downgrade classification to **2** if operator wants to keep using this file as the live backlog. Default: archive + extract #2/#3 into a new small spec.
- Cross-cluster overlap: paired with `initiative-investigate.md` (same audit pipeline).

## Cross-cluster overlap flags

- **Agent runs envelope (`agent_runs`)**: introduced by the research-area build plan but now hosts initiative-audit dispatches, jobs-in-progress migration 080 expansions, and the dedupe-investigations `run_group_id` linkage. Any future spec touching `agent_runs` should explicitly call out these three consumers.
- **`take_note` / `agent_notes` writes**: initiative-investigate.md uses `take_note` as the audit-output channel; initiative-research-loop.md adds `source_kind`/`source_ref`; dedupe-investigations.md adds the cancellation guard. Three specs ship coordinated changes to the same surface — worth a one-paragraph "agent-notes contract" reference doc.
- **`/research` hub vs Initiative Research section**: research-area.md and initiative-research-loop.md split the brief surface area (workspace-scoped hub vs. initiative-scoped section). No drift today, but if proposals-from-briefs (research-area phase 4) lands, it will need to decide whether initiative-scoped briefs emit proposals scoped to that initiative.

## Consolidation suggestions

1. **Move `initiative-research-loop.md`, `initiative-research-loop-build-plan.md`, and `initiative-research-loop-validation/` to `specs/archive/`** as a unit. All shipped, no aspirational tail.
2. **Move `research-area-build-plan.md`, `research-area-validation/`, `research-phase-2-schedules-build-plan.md`, `research-phase-2-validation/` to `specs/archive/`.** All shipped.
3. **`research-area.md` itself**: either (a) archive alongside its build plans and write a fresh "Research roadmap" spec for phases 3–5 when they're next picked up, or (b) trim it down to the §"Phase plan" tail and rename to `research-area-roadmap.md`. Recommend (a) — the existing doc mixes shipped phase-1 design with deferred phase-3+ ideation, which is the textbook "spec that is half historical, half aspirational" anti-pattern.
4. **`initiative-investigate.md`**: archive. The shipped pipeline is the source of truth; the prompt-iteration loop and subtree-fanout discussion are nice context but not "live" any more.
5. **`dedupe-investigations.md`**: archive the PR-#1 portion. Extract documented #2 (dispatch-time 409 guard) and #3 (UI cooldown) into a single short spec at `specs/audit-dedupe-followups.md` so they don't get lost in the archive.
6. **`foia-pipeline.md`**: keep at top level. It is the only fully-aspirational spec in the cluster. When work resumes, pair it with a `foia-pipeline-build-plan.md` per the project's structured-feature-dev contract.

---

## 5-line summary

Research cluster is overwhelmingly historical: phase-1 + phase-2 of Research Area shipped (migrations 075, 077), the initiative research loop shipped (briefs.initiative_id, read_brief MCP tool, auto-note source tracking), the initiative-investigate audit pipeline shipped (scope_type=initiative_audit, /investigate route), and dedupe-investigations PR-#1 shipped (migration 085 + take_note cancellation guard). The lone aspirational spec is `foia-pipeline.md` — zero code, four tables and 12 MCP tools still on paper. Recommendation: archive eight of the nine specs as a batch, extract dedupe-investigations' documented #2/#3 follow-ups into a new short spec, and keep foia-pipeline.md plus possibly research-area.md as the live aspirational/roadmap files.

## Top 3 drift / consolidation items

1. **`research-area.md` is split-personality** — phase 1+2 are shipped (build plans + code), phases 3–5 are aspirational but never re-specced. Either trim to roadmap-only or archive and re-spec phase 3+ when picked up.
2. **`dedupe-investigations.md` PR-#2/#3 are dangling** — the spec explicitly defers them but they have no other home; they should be lifted into a dedicated `audit-dedupe-followups.md` before the parent is archived, otherwise the dispatch-time-409 guard and UI-cooldown ideas get lost.
3. **`foia-pipeline.md` is the only true greenfield spec** in this cluster — needs a build plan companion before any code starts, per the project's structured-feature-dev contract. Bootstrap workspace test fixture references "foia" but no schema/MCP/UI exists.
