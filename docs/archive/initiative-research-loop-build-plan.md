---
name: Initiative Research Loop — Build Plan
description: Slice plan + design decisions for shipping the initiative-scoped research loop on top of briefs
status: draft
spec: docs/archive/initiative-research-loop.md
---

# Initiative Research Loop — Build Plan

Status: draft · Owner: smb209 · Date: 2026-05-09
Spec: [docs/archive/initiative-research-loop.md](initiative-research-loop.md)

This is the build-plan companion to the spec. It commits to slices, files-touched, and the load-bearing design calls. Operator OKs this doc *before* any code lands; per-slice unit tests + preview verification are the per-PR contract; full validation runs against the stacked branch tip per [docs/reference/long-unattended-feature-dev.md](long-unattended-feature-dev.md).

## Audit (current state, verified 2026-05-09)

- `briefs` table — `src/lib/db/migrations.ts` migration 075 (line 4133+). Columns today: `id, workspace_id, agent_run_id, topic_id, template, title, prompt, requested_by, source_ref, result_md, citations_json, error_md, created_at, updated_at`. **Already has** `source_ref TEXT` — used by rerun (`src/app/api/briefs/[id]/rerun/route.ts:43`) to write `brief:<original_id>` linking a rerun back to its source brief. **Missing:** `initiative_id`, `summary`.
- `briefs` DAO — `src/lib/db/briefs.ts`, `createBriefWithRun()` at line 119. `BriefInput` at line 111 already accepts `source_ref`.
- Suggest pipeline — `src/lib/research/suggest.ts`, `buildSuggestPrompt(kind, ctx)` at line 154. `gatherWorkspaceContext()` is workspace-wide. API caller is `POST /api/research/suggestions` (`generateSuggestions`).
- Brief run / completion — `src/lib/research/run-brief.ts`. Completion path writes `result_md` + transitions agent_run via DAO `markComplete`.
- agent_notes — `src/lib/db/agent-notes.ts:208` `listNotes(filter)`. Schema (migrations 065 + 067) supports `kind: 'discovery'`, `audience`, `importance: 0|1|2`, `archived_at`/`archived_reason`, `source` is **not** a first-class column — instead `source` shape from spec needs to map to existing fields. Verified columns: `id, workspace_id, agent_id, task_id, initiative_id, scope_key, role, run_group_id, kind, audience, body, attached_files, importance, consumed_by_stages, archived_at, archived_reason, created_at, pm_proposal_ids`. **Gap vs spec:** there's no `source_kind` / `source_id` column on `agent_notes`. We'll either (a) add one in this feature's migration, or (b) embed `{type, id}` in `body_md` via a parseable marker. See Decision 4.
- Decompose / refine context — confirmed: `src/app/api/pm/decompose-initiative/route.ts:118` and `src/app/api/pm/plan-initiative/route.ts:157` already prompt PM to call `read_notes({initiative_id, audience: 'pm', min_importance: 2, limit: 5})`. Auto-notes at importance 2 / audience 'pm' will land here with zero changes.
- MCP groups — `src/lib/mcp/groups/{core,crud,pm,read,work}.ts`. **No `research` group today.** `read_notes` lives in `core.ts:554`. New `read_brief` tool will go in `read.ts` (read-only role-agnostic), not `core.ts` (which is the heavy human-facing toolset).
- InitiativeDetailView — `src/components/InitiativeDetailView.tsx` (~1300 lines). Description and Children are clearly separated; insertion point obvious.
- Brief progress / SSE — confirmed **no SSE channel for brief progress today**. The brief detail page at `src/app/(app)/research/briefs/[id]/page.tsx` polls/refreshes server-side. The Research section on the initiative page will use the same pattern (server-rendered with revalidation, optionally SWR-style refresh on a timer) — **no new SSE channel in v1**.
- Rerun semantics — verified: rerun creates a **new brief row** with `source_ref: brief:<original_id>`. Originals stay. The new brief has its own `result_md` + `agent_run`. This shapes Decision 3.
- Suggestions UI — `src/components/research/SuggestPickerDrawer.tsx` is the existing queue surface; it filters by workspace today.

## Design decisions

### D1. `briefs.summary` generation strategy

**Choice:** "first sentence of `result_md`, max 160 chars" at brief completion. Computed in JS with a small extractor (`/^(.*?[.!?])\s/`). No LLM call.

- **Why:** zero added cost / latency / failure mode. Spec already names this as the v1 default. If indexes look noisy after dogfood, swap to LLM 1-liner in a follow-up.
- **Reversible:** yes — column is a single string, regenerable from `result_md` any time.

### D2. Auto-note `source` representation

The spec writes `source: { type: 'brief', id }` on the note. `agent_notes` has no `source_kind`/`source_id` column today.

**Choice:** add `source_kind TEXT` and `source_ref TEXT` columns to `agent_notes` in this feature's migration. Indexed `(source_kind, source_ref)` for the dedupe lookup.

- **Why over body-marker:** clean dedupe + future "rerun replaces" + cheap to query. The cost is a 2-column migration; the benefit is the rerun-replace path is a single SQL `UPDATE` instead of a body parse. Notes rail rendering can read `source_kind='brief'` to render a "View brief" affordance cleanly.
- **Why not reuse existing `attached_files`:** wrong semantics — that's a JSON list of filesystem paths.
- **Reversible:** columns are nullable and net-additive; existing notes stay null.

### D3. Rerun ↔ auto-note semantics

Rerun creates a **new brief row** with `source_ref: brief:<original_id>`. The original brief (and its auto-note) still exists. Two questions:
1. Does the rerun's auto-note replace the original's, or stack alongside?
2. Is "replace" via in-place update or soft-delete + insert?

**Choice:** when a brief with non-null `briefs.source_ref` (i.e. it's a rerun) completes, find any existing **non-archived** `agent_notes` with `source_kind='brief'` and `source_ref` pointing at the chain root, **soft-delete** them (`archived_at = now`, `archived_reason = 'superseded_by_rerun'`), then insert a new note for the new brief.

- **Why soft-delete over in-place update:** preserves audit trail in the `agent_notes` table; `archived_reason` makes the relationship explicit. Notes rail already filters out `archived_at IS NOT NULL`, so the UI is clean.
- **Why "chain root":** if the rerun is itself rerun, we want to walk back to the original to find every prior auto-note. Trivial recursive lookup.
- **Reversible:** yes — `archived_at` is a flag; un-archiving brings back the prior note.

### D4. New MCP tool placement

**Choice:** `read_brief({ brief_id })` lives in `src/lib/mcp/groups/read.ts`. Returns the shape from the spec.

- **Why `read.ts`:** it's the read-only group available to all roles. No need to invent a `research` group for a single tool.
- **Future:** if we add `list_briefs_for_initiative`, that probably belongs here too. Don't pre-invent the group.

### D5. UI fetch for the Research section

**Choice:** server-rendered list of briefs scoped by `initiative_id` on the initiative detail page. In-progress briefs render with the existing `agent_runs.status` (queued / running / complete / failed), refreshed via the same revalidation pattern the page already uses. **No new SSE channel.**

- **Why:** matches existing `/research` hub. SSE for brief progress is a worthwhile follow-up but out of scope for the loop's correctness.
- **Reversible:** yes — adding SSE later doesn't break server-rendered fallback.

### D6. Migration scope

Single migration adds: `briefs.initiative_id` (FK + index), `briefs.summary`, `agent_notes.source_kind`, `agent_notes.source_ref`, index on `(source_kind, source_ref)`.

- **Why one migration:** atomic; no slice can land partial state.
- **Cost:** ~30 lines in `migrations.ts`; backfills are no-ops.

## Slice plan

Each slice is one stacked PR. Branch base for slice N = slice N-1's branch (per [docs/reference/long-unattended-feature-dev.md](long-unattended-feature-dev.md)). Retarget children to `main` before merging the parent.

### Slice 1 — DB migration + DAO surface

**Branch:** `feat/research-loop-1-migration` (off `main`)

**Files:**
- `src/lib/db/migrations.ts` — new migration: `briefs.initiative_id`, `briefs.summary`, `agent_notes.source_kind`, `agent_notes.source_ref`, indexes.
- `src/lib/db/briefs.ts` — extend `BriefInput`, `BriefRow`, `createBriefWithRun()` to accept `initiative_id` and write/read it. Add `summary` to row shape.
- `src/lib/db/agent-notes.ts` — extend insert/list to accept `source_kind` / `source_ref`; add `findBySource(source_kind, source_ref)` helper for the rerun dedupe path.
- Tests: extend `src/lib/db/briefs.test.ts` and `src/lib/db/agent-notes.test.ts` (paths exist) — schema round-trip + new filter.

**Testable after this slice:** DAO unit tests pass; `yarn test` green for DB layer.

**Dependencies:** none.

### Slice 2 — Suggest pipeline carries initiative scope

**Branch:** `feat/research-loop-2-suggest` (off slice 1)

**Files:**
- `src/lib/research/suggest.ts` — add `initiativeId?: string` to options. New `gatherInitiativeContext(initiativeId)` that returns `{ initiative, parents, recent_pm_notes, prior_briefs_index: [{id, title, summary}] }`. Branch in `buildSuggestPrompt` to use it instead of workspace context.
- `src/app/api/research/suggestions/route.ts` — accept `{ initiative_id }` body field, thread through. List endpoint accepts `?initiative_id=` query.
- `src/lib/db/research-suggestions.ts` — `payload_json.initiative_id` so accept-flow propagates it onto the brief. (verify the DAO; may already be JSON-blob-passthrough)
- Tests: extend `src/lib/research/suggest.test.ts` — assert prompt contains initiative-scoped block when set.

**Testable after this slice:** suggest works against an initiative end-to-end; produced suggestions carry `initiative_id`.

### Slice 3 — Brief dispatch + auto-note + rerun replace

**Branch:** `feat/research-loop-3-autonote` (off slice 2)

**Files:**
- `src/lib/research/run-brief.ts` — accept `initiative_id` in dispatch helpers; persist on row (already covered by slice 1 DAO change). At completion: if `initiative_id` non-null, compute `summary`, write `agent_notes` row with `kind: 'discovery'`, `audience: 'pm'`, `importance: 2`, `source_kind: 'brief'`, `source_ref: <brief_id>`. If brief has `source_ref` (it's a rerun), walk back to chain root, soft-delete prior auto-notes for that root.
- `src/app/api/research/suggestions/[id]/accept/route.ts` (or wherever accept lives) — pass through `initiative_id` from the suggestion payload onto the dispatched brief.
- `src/app/api/briefs/[id]/rerun/route.ts` — copy `initiative_id` from original to rerun.
- Tests: `src/lib/research/run-brief.test.ts` — extend with the auto-note assertion (one note written, idempotent on second completion of same brief, replace on rerun).

**Testable after this slice:** end-to-end: suggest → accept → run → complete → note appears via `read_notes`. Refine + decompose context loads now include the auto-note with no changes.

### Slice 4 — `read_brief` MCP tool

**Branch:** `feat/research-loop-4-read-brief` (off slice 3)

**Files:**
- `src/lib/mcp/groups/read.ts` — register `read_brief({ brief_id })`. Returns `{ id, title, prompt, result_md, citations, status, completed_at, initiative_id, summary }`.
- Schema test: add a sibling `read.schema.test.ts` if a pattern exists, otherwise extend whatever schema test covers `read.ts`.
- Tests: integration smoke (`yarn mcp:smoke`) — verify the tool is discoverable.

**Testable after this slice:** PM and researcher roles can fetch full brief bodies during refine / iterative research.

### Slice 5 — InitiativeDetailView Research section + suggest UI scope

**Branch:** `feat/research-loop-5-ui` (off slice 4)

**Files:**
- `src/components/InitiativeDetailView.tsx` — new `<ResearchSection>` between Description and Children. Loads `briefs.where(initiative_id = X)` server-side. Header has `Suggest research` and `New brief` buttons.
- `src/components/research/InitiativeResearchSection.tsx` (new) — list of brief rows with status badges + "View" link.
- `src/components/research/SuggestPickerDrawer.tsx` — accept optional `initiativeId` prop; filter listed suggestions by it.
- `src/components/research/RunBriefDrawer.tsx` — accept optional `initiativeId`; post it to brief create.
- `src/app/api/initiatives/[id]/briefs/route.ts` (new) — GET endpoint listing briefs for an initiative (or extend `/api/briefs?initiative_id=` if that's the existing pattern).
- Tests: component smoke; preview-verify in validation phase.

**Testable after this slice:** full UI loop. Operator can drive the entire sequence from the initiative page. This is the slice that the validation test plan exercises end-to-end.

## Test strategy summary

| Slice | Unit tests added | Validation scenarios that become exercisable |
|---|---|---|
| 1 | DAO round-trip, source-ref filter | none yet (DB only) |
| 2 | Suggest prompt content w/ initiative | R-S1 (suggest scoped to initiative) |
| 3 | Auto-note write + rerun replace | R-S2 (note appears post-completion), R-S3 (rerun replaces note), R-S4 (decompose context includes auto-note) |
| 4 | MCP smoke | R-S5 (researcher fetches prior brief body) |
| 5 | Component smoke | R-S6 (full UI loop), R-S7 (decompose proposal references research) |

Validation directory ([initiative-research-loop-validation/](initiative-research-loop-validation/)) holds the concrete scenarios.

## Open questions for operator

1. **Slice-3 auto-note's link** — the spec writes `[Full brief](${briefUrl})` in `body_md`. Confirmed brief detail page lives at `/research/briefs/[id]/page.tsx` so URL is `/research/briefs/<id>`. Going with that unless you say otherwise.
2. **Brief rerun edge case** — if the *original* brief has `initiative_id = X` but the rerun is dispatched from a context where that's lost (shouldn't happen but worth nailing), the rerun copies `initiative_id` from the original. Confirmed this is what the rerun route does in slice 3.
3. **`agent_notes.source_kind` / `source_ref`** — adding these columns is a small but real schema expansion. If you'd rather embed source-tracking in `body_md` to avoid the migration, say so and I'll switch. Default is the migration.

None of these block writing the validation skeleton. Calling them out so they're not surprises.

## Out of scope (named explicitly)

- Phase tracking + heartbeat on briefs (autopilot lift, deferred).
- Cost / token tracking on briefs (deferred).
- Hierarchical context rollup (parent initiative refine sees child briefs).
- Brief deletion → auto-note cascade UI prompt (defer until briefs are deletable from the UI).
- LLM-generated `summary` (defer until first-sentence proves noisy).
- New SSE channel for brief progress.
- Workspace-level "research watch" auto-loop.

## Cost ceiling

Per `project_openclaw_model.md`: real-agent dispatches use `spark-lb/agent`, self-hosted, no budget concern. Validation runs ~7 scenarios × ~5 min each ≈ 35 min of agent time. **HMR-runaway watchdog** (per `project_research_hmr_runaway.md`): pre-check 01 confirms pending-brief queue is empty before any dispatch; abort-if-not.

## Slice merge order

Per `feedback_stacked_pr_merges.md`:
1. Each slice PR opens against the prior slice's branch (`--base feat/research-loop-N-…`).
2. Before merging slice 1, retarget slice 2's base to `main`. Repeat down the stack.
3. `--delete-branch` only after children are retargeted.
4. All PRs target the fork (`smb209/mission-control`), explicit `--repo` per `feedback_pr_target_fork.md`.
