# 00 — Baseline observations

Captured 2026-05-09, before any slice merges. Re-read before validation runs to confirm the substrate hasn't shifted.

## Schema state

- `briefs` table — migration 075 (`src/lib/db/migrations.ts:4133+`). Columns: `id, workspace_id, agent_run_id, topic_id, template, title, prompt, requested_by, source_ref, result_md, citations_json, error_md, created_at, updated_at`.
  - **Missing:** `initiative_id`, `summary`. Slice 1 adds both.
- `agent_notes` table — supports `kind: 'discovery'`, `audience`, `importance: 0|1|2`, `archived_at` (migrations 065 + 067).
  - **Missing:** `source_kind`, `source_ref`. Slice 1 adds both.

## API + lib state

- Suggest pipeline workspace-only: `src/lib/research/suggest.ts:154` (`buildSuggestPrompt(kind, ctx)`), `gatherWorkspaceContext` is the only context gatherer.
- Brief completion has **no** auto-note path: `src/lib/research/run-brief.ts` writes `result_md`, transitions agent_run, returns. No write to `agent_notes`.
- Decompose / refine **already** prompts PM to call `read_notes({ initiative_id, audience: 'pm', min_importance: 2, limit: 5 })`:
  - `src/app/api/pm/decompose-initiative/route.ts:118`
  - `src/app/api/pm/plan-initiative/route.ts:157`
- Rerun route (`src/app/api/briefs/[id]/rerun/route.ts:43`) creates a **new brief row** with `source_ref: brief:<original_id>` (not an in-place rerun).
- No `read_brief` MCP tool. `read.ts` has no brief-fetching tool today.

## UI state

- `/roadmap` ships timeline shell + recompute (separate spec — roadmap-navigation-polish).
- `/initiatives/[id]` renders Description + Children, no Research section.
- `/research` hub renders SuggestPickerDrawer / RunBriefDrawer / ResearchSideRail; suggestions filter by workspace only.
- No SSE channel for brief progress. Brief detail page (`src/app/(app)/research/briefs/[id]/page.tsx`) is server-rendered.

## Environment

- Dev DB at `:4010`, prod at `:4001` per `project_dev_prod_db_split.md`. Validation runs against dev.
- Default agent: `spark-lb/agent`.
- Pending-brief queue: **must be empty before validation**; check pre-run.

## Open issues / known unrelated breakage

To be filled in during pre-check 01 from `yarn test` baseline. Anything failing pre-feature-branch gets listed here so we don't blame the feature for it.
