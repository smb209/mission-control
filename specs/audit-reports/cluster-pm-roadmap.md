# Cluster: PM / Roadmap / Jobs

Audit date: 2026-05-11 (branch `feat/audit-action-recommended`).

## Verdict table

| Spec | Class | Rationale | Evidence |
|---|---|---|---|
| roadmap-and-pm-spec.md | 1 (Current & accurate, with caveats) | Phases 1–6 + Polish B all shipped; schema, MCP tools, PM agent, standup live. | `src/lib/db/migrations.ts:2388` initiatives, `src/lib/agents/pm-standup.ts`, `src/app/(app)/roadmap/`, `src/app/(app)/pm/`, commits `434c4f0`, `fcd270c`, `d34df76`. |
| roadmap-navigation-polish.md | 4 (Historical / superseded) | Already merged (`#313`). All five fixes landed; no longer aspirational. | `src/components/roadmap/RoadmapTimeline.tsx`, `RoadmapRail.tsx`, `RoadmapToolbar.tsx`, `RoadmapCanvas.tsx`; commit `0bd7432`. |
| pm-chat-prompt.md | 2 (Current & aspirational) | PR A (prompt + 1-at-a-time UI) appears wired; PR B (steer/abort + in-flight visibility) not yet implemented. | `src/lib/agents/pm-soul.md`, `src/lib/agents/pm-dispatch.ts` (no `steerSession`/`abortSession` exports). |
| pm-confirm-task-done.md | 1 (Current & accurate) | Diff kind shipped (`#325`, commit `37d7d2c`); type, validator, apply, invertDiff all present. | `src/lib/db/pm-proposals.ts:195` (type), `:522` (validate), `:1076` (apply), `:1342` (invert). |
| pm-dispatch-async.md | 1 (Current & accurate) | All 3 tiers shipped (`#88`); `dispatch_state`, reconciler, `pm_proposal_replaced` SSE all live. | `src/lib/agents/pm-dispatch.ts:243,532,832,898,1040`; `src/lib/db/pm-proposals.ts:221,749`. |
| pm-revertable-proposals.md | 2 (Current & aspirational) | Slices 1, 2, and 4 shipped (`#124` and earlier); the `/pm/activity` timeline UI (deliverable 3) appears to be implemented; cancelled-filter toggle done. Verify activity timeline UI fully matches spec. | `src/lib/pm/invertDiff.ts`, `src/lib/db/pm-proposals.ts:47` (`'revert'` trigger), `:224` (`reverts_proposal_id`), `src/app/(app)/pm/activity/`, commit `5dcb3c6`. |
| jobs-in-progress.md | 2 (Current & aspirational) | Migration 080 + 081 shipped; `/api/jobs` + `/jobs` page + cancel endpoint exist (PRs 1–4). PR 5 (sidebar pip + drill-down) status uncertain — `JobDetailDrawer.tsx` suggests drill-down landed. | `src/lib/db/migrations.ts:4317` (mig 080), `:4407` (mig 081), `src/app/api/jobs/route.ts`, `src/app/api/jobs/[id]/cancel/route.ts`, `src/app/(app)/jobs/JobDetailDrawer.tsx`, commit `c77ecb9`. |
| calendar.md | 2 (Current & aspirational — mostly aspirational) | Only a placeholder spec-rendering page exists; no schema, no PmDiff kinds, no MCP tools, no lookahead agent. | `src/app/(app)/calendar/page.tsx` is a 5-line `<SpecPage>` stub; no `calendar_entries` table in `src/lib/db/migrations.ts`; no `create_calendar_entry` in `src/lib/db/pm-proposals.ts:38-47` trigger kinds nor in the `PmDiff` union. |

## Per-spec notes

### roadmap-and-pm-spec.md
- Classification: 1.
- Spec claims: 6 phases + Polish B (plan/decompose) shipped.
- Code reality: `initiatives`, `initiative_dependencies`, `pm_proposals`, `owner_availability`, `task_initiative_history`, `initiative_parent_history` all present (`src/lib/db/migrations.ts:2388`+). PM agent identity, MCP tools, standup (`src/lib/agents/pm-standup.ts`), `/pm` and `/roadmap` and `/initiatives` routes all live. `dispatch_state` column extends original spec.
- Recommendation: Keep as the canonical reference. Add a short "post-merge addenda" pointer at top listing the follow-on specs (pm-dispatch-async, pm-confirm-task-done, pm-revertable-proposals) so readers know what's been layered since.
- Cross-cluster overlap: Touches MCP-surface cluster, autopilot, scope-keyed-sessions.

### roadmap-navigation-polish.md
- Classification: 4 (Historical / superseded — archive candidate).
- Spec claims: 5 UI fixes to `/roadmap`.
- Code reality: All five present in `src/components/roadmap/RoadmapTimeline.tsx` and siblings (header cleanup, rail width state, recompute banner, week-view centering, scroll affordances). Shipped in `#313` (`0bd7432`).
- Recommendation: Move to `specs/_archive/` (or annotate `Status: shipped`).

### pm-chat-prompt.md
- Classification: 2.
- Spec claims: PR A (mode-A/B SOUL prompt + one-at-a-time UI) and PR B (`sessions.steer`/`sessions.abort` + in-flight visibility).
- Code reality: PR A primitives are in place (`src/lib/agents/pm-soul.md`, `pm-dispatch.ts` trigger_body). PR B is not — `grep -n "steerSession\|abortSession\|pm_dispatch_in_flight" src/` yields nothing in `src/lib/openclaw/client.ts`.
- Recommendation: Mark "PR A shipped; PR B open". Either schedule PR B or split into a fresh spec.
- Cross-cluster overlap: openclaw client cluster; activity feed cluster.

### pm-confirm-task-done.md
- Classification: 1.
- Spec claims: `confirm_task_done` diff with evidence gate, late-stage status precondition, transition through `transitionTaskStatus`, revert via `prev_status`.
- Code reality: Exactly matches (`src/lib/db/pm-proposals.ts:195`, `:522`, `:1076`, `:1342`). Shipped in `#325`.
- Recommendation: Mark `Status: shipped` and archive.

### pm-dispatch-async.md
- Classification: 1.
- Spec claims: Tier 1 per-kind timeout, Tier 2 reconciler, Tier 3 async-by-default with placeholder + `pm_proposal_replaced` SSE.
- Code reality: All present — `timeoutMs` param, `dispatch_state` column (`'pending_agent' | 'agent_complete' | 'synth_only'`), `pm_proposal_replaced` and `pm_proposal_dispatch_state_changed` SSE events, `attachAgentProposalToPlaceholder` (`src/lib/db/pm-proposals.ts:780`).
- Recommendation: Archive.

### pm-revertable-proposals.md
- Classification: 2 (close to 1).
- Spec claims: 3 deliverables (cancelled filter, revert pipeline + capture, `/pm/activity` UI).
- Code reality: Capture pattern present (`PmDiffCapture` at `src/lib/db/pm-proposals.ts:58`), `revert` trigger_kind (`:47`), `reverts_proposal_id` column (`:224`), `src/lib/pm/invertDiff.ts` exists with tests, `src/app/(app)/pm/activity/` route exists, cancelled-filter toggle shipped (`#124`).
- Recommendation: Spot-check the activity-timeline UI surface vs. §3 of the spec; if complete, downgrade to 1 and archive. Otherwise note the residual gap.
- Cross-cluster overlap: shares ground with audit-action-recommended (current branch) — both add new PmDiff capture/revert behaviors.

### jobs-in-progress.md
- Classification: 2.
- Spec claims: 5 PRs — schema, API/UI, tree view, cancel, sidebar pip + drill-down.
- Code reality: Migration 080 + 081 in `src/lib/db/migrations.ts:4317,4407` match the spec column-for-column. `/api/jobs`, `/api/jobs/[id]/cancel`, `/api/jobs/[id]/artifacts`, `/(app)/jobs/page.tsx`, `JobDetailDrawer.tsx` all exist. Subtree fan-out and sidebar pip status not directly verified.
- Recommendation: Verify PR 3 (subtree tree view) and PR 5 (sidebar pip) shipped; if so, archive. Otherwise list residual slices.

### calendar.md
- Classification: 2 (mostly aspirational).
- Spec claims: CalendarEntry table, PmDiff kinds, MCP tools, readiness model, lookahead agent, `/calendar` views.
- Code reality: `src/app/(app)/calendar/page.tsx` is a 5-line `SpecPage` stub that renders the spec markdown. No `calendar_entries` table in `src/lib/db/migrations.ts`. No `create_calendar_entry` etc. in `src/lib/db/pm-proposals.ts:38-47` (trigger_kind) or in the `PmDiff` union. No `get_calendar_upcoming` MCP tool.
- Recommendation: Mark `Status: Draft — phase 1 not started`. Either fold into a structured-feature-dev build plan or shelve.
- Cross-cluster overlap: memory cluster (calendar as producer/consumer), research cluster (regulatory_scan), stakeholders-comms (cadence proposals), risk-management (review cadence).

## Cross-cluster overlap flags

- **pm-revertable-proposals.md ↔ pm-confirm-task-done.md ↔ audit-action-recommended.md (in flight)**: All three add new PmDiff kinds + capture/inversion logic. The "captured at apply time" pattern is becoming a load-bearing convention; worth promoting into a section of `roadmap-and-pm-spec.md` (or a new `pm-diff-conventions.md`).
- **jobs-in-progress.md ↔ pm-dispatch-async.md**: `dispatch_state` lives on `pm_proposals`; `agent_runs` rows track the same dispatch from another angle. Document the linkage (`pm_proposal_id` column in `agent_runs` is migration 081). Single source-of-truth question worth resolving.
- **calendar.md ↔ memory.md / stakeholders-comms.md / risk-management.md / research-area.md**: Calendar spec assumes hooks into all four. Until calendar phase 1 ships, those integrations are speculative.
- **pm-chat-prompt.md PR B ↔ autonomous-flow-tightening / activity feed**: Live in-flight visibility overlaps with the activity feed surface.

## Consolidation suggestions

1. Archive `roadmap-navigation-polish.md`, `pm-confirm-task-done.md`, `pm-dispatch-async.md` under `specs/_archive/` — they're fully shipped and clutter the active list.
2. Add a top-of-file "post-merge addenda" / pointer block to `roadmap-and-pm-spec.md` linking the layered specs so newcomers don't read it as the only roadmap doc.
3. Split `pm-chat-prompt.md` into "PR A — shipped" (archive) and a fresh `pm-steer-abort.md` (PR B scope), since the two halves now have different lifecycles.
4. Promote the `PmDiffCapture` / `invertDiff` pattern into a small `pm-diff-conventions.md` reference that the three add-a-diff-kind specs can cite instead of repeating.
5. `calendar.md` should be either elevated to a structured-feature-dev build plan or moved to `specs/_proposals/` to make its aspirational status obvious — today it's indistinguishable from shipped specs.
