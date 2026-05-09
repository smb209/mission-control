# Initiative Research Loop — Spec (Draft)

Couple the existing PM brief/topic research system to initiatives so an operator can iterate **research → refine → research → decompose** against a single high-level goal, with each round feeding the next round's context.

## Operator intent

> "I have a theme. Help me figure out what we should actually do — research the space, refine the framing as we learn, then break it into milestones."

The loop is operator-driven, not autonomous. Each step produces evidence the operator reviews; the operator decides whether to run another brief, refine the description, or move to decompose.

## Why on top of briefs (not autopilot)

Decided in conversation 2026-05-09. Briefs already have: citations with snippets, markdown output that flows through the notes rail, topic grouping, rerun, recurring schedules, gateway retry resilience. Autopilot is product-scoped, JSON-sectioned, swipe-ranked — wrong shape for arbitrary initiatives. See [research-area.md](research-area.md) for the brief/topic substrate.

## The loop

```
                ┌──────────────────────────────────────┐
                │  Initiative (theme)                  │
                │  description + existing notes        │
                └──────────────────────────────────────┘
                                 │
                                 ▼
                  ┌──────────────────────────┐
                  │ Suggest research          │  PM agent reads initiative
                  │ (operator-triggered)      │  + prior briefs + notes,
                  └──────────────────────────┘  proposes 3–5 candidate briefs
                                 │
                                 ▼
                  ┌──────────────────────────┐
                  │ Operator picks / edits   │
                  └──────────────────────────┘
                                 │
                                 ▼
                  ┌──────────────────────────┐
                  │ Brief executes           │  researcher dispatch
                  │ initiative_id = <X>      │  → result_md + citations
                  └──────────────────────────┘
                                 │
                                 ▼
                  ┌──────────────────────────┐
                  │ Auto-note on initiative  │  kind: 'discovery'
                  │ (link + excerpt)         │  body: brief title +
                  └──────────────────────────┘  result excerpt
                                 │
                                 ▼
              ┌─────────────────────────────────────┐
              │ Operator reviews. Three exits:      │
              │  (a) refine description, then loop  │
              │  (b) suggest more research, loop    │
              │  (c) Decompose with PM              │
              └─────────────────────────────────────┘
```

`refine` and `decompose` already pull `agent_notes` for the initiative (`min_importance: 2, limit: 5, audience: 'pm'`). Auto-noting brief completions means the loop closes without touching those endpoints.

## Architecture

### DB changes (one migration)

```ts
// migrations.ts — new migration
ALTER TABLE briefs ADD COLUMN initiative_id TEXT
  REFERENCES initiatives(id) ON DELETE SET NULL;
ALTER TABLE briefs ADD COLUMN summary TEXT;  -- one-liner for index views
CREATE INDEX briefs_initiative_id_idx ON briefs(initiative_id);
```

`summary` is populated at completion time from the first sentence of `result_md` (max 160 chars). It feeds the suggest prompt's prior-briefs index and the Research section list view.

`topics.linked_initiatives` (already in the research-area spec, may not be implemented yet) stays optional and orthogonal — a topic *can* span initiatives. The brief is the per-initiative unit.

No changes to `agent_notes` schema. We use `kind: 'discovery'` with structured body.

### Suggest endpoint extension

`src/lib/research/suggest.ts:154` (`buildSuggestPrompt`) already gathers workspace context. Add optional `initiative_id` scoping:

```ts
// suggest.ts
export type SuggestOptions = {
  workspaceId: string;
  initiativeId?: string;  // NEW
  // ...existing
};
```

When `initiativeId` is set:
- Replace workspace-wide context block with **initiative-scoped** context: initiative title/description/status, parent chain, recent agent_notes (`audience: 'pm', limit: 10`), and a **lightweight index** of prior briefs where `initiative_id = ?` — just `{ id, title, summary }` per brief, not the full body. The PM can call `read_brief({ brief_id })` (see "New MCP tool" below) to pull a full prior brief if it looks relevant.
- Prompt instructs PM to propose briefs that *advance this specific initiative* — fill gaps in current understanding, validate assumptions in the description, surface unknowns blocking decomposition.
- Generated `research_suggestions` rows carry `payload_json.initiative_id` so accept-flow knows to set it on the brief.

API: extend `POST /api/research/suggestions` to accept `{ initiative_id?: string }`. List/filter endpoints get an `initiative_id` query param.

### Brief dispatch carries initiative_id

`src/lib/research/run-brief.ts` — `createBriefWithRun()` accepts `initiative_id` and persists it on the brief row. No change to the agent prompt itself; the initiative context shows up via the brief's own `prompt` field, which the suggest step composed.

### Auto-note on brief completion

Where briefs transition to `complete` (run-brief.ts around line 290–340 in the completion handler), if `brief.initiative_id` is non-null, write an `agent_notes` row:

```ts
{
  initiative_id: brief.initiative_id,
  kind: 'discovery',
  audience: 'pm',
  importance: 2,                    // visible to refine/decompose default filter
  body_md: `**Research: ${brief.title}**\n\n${excerpt(brief.result_md, 600)}\n\n[Full brief](${briefUrl})`,
  source: { type: 'brief', id: brief.id },
  created_at: now,
}
```

Notes:
- `importance: 2` is the threshold `decompose_initiative` uses (`min_importance: 2`). Anything lower wouldn't appear in the context.
- Excerpt is the first ~600 chars of `result_md`, not the full body — full body stays one click away. Refine/decompose contexts have token budgets; we don't want a single brief to crowd them out.
- `source` block lets the notes rail render a "View brief" affordance and lets us dedupe if the brief is rerun.

### Brief rerun semantics

If a brief is rerun (`POST /api/briefs/[id]/rerun`), the new run *replaces* the prior auto-note rather than stacking. Find by `source.type='brief' AND source.id=<brief_id>` and update in place, or soft-delete the old and insert the new. **Open question:** soft-delete + new = preserves history in notes rail; in-place update = cleaner UI. Default to in-place; revisit if operators want to compare runs.

### UI surface

Initiative detail page (`src/components/InitiativeDetailView.tsx`) gets a new section between **Description** and **Children**:

**Research** section
- List of briefs where `initiative_id = <this>` ordered by `created_at desc`.
- Each row: title, status badge, completion date, citation count, "View" link.
- Header buttons:
  - **Suggest research** → calls `POST /api/research/suggestions { initiative_id }`. Returns to a modal/drawer where operator multi-selects suggestions, edits prompts, accepts.
  - **New brief** → free-form prompt entry, dispatches directly with `initiative_id` set.
- In-progress briefs render with the same progress signal as `/research` hub (subscribe to brief_progress events).

The notes rail keeps showing the auto-notes alongside other discoveries. The Research section is the canonical view; the rail is the synthesis surface that `refine`/`decompose` see.

### Suggest UX inside initiative

Reuse the existing suggestions queue UI (`/research` hub) but filter to `initiative_id = <this>`. Suggestions for an initiative don't pollute the workspace-wide suggestions feed — they're scoped.

## Lift from autopilot (deferred, not in this spec)

Two ideas worth lifting later, neither required for the loop to work:

1. **Phase tracking with heartbeat** on briefs (autopilot's `current_phase` + `last_heartbeat` pattern from `research_cycles`). Briefs currently lean on `agent_runs.status`; for long iterative loops a finer-grained phase column gives better UI feedback. **Defer until** operators complain about "running for 4 minutes" being opaque.
2. **Cost/token tracking per brief** (autopilot calls `recordCostEvent` per cycle). A research → refine → research cycle could quietly burn budget. **Defer until** there's a cost concern; track it as a row-level addition to `briefs` when the time comes.

Neither blocks v1.

## Migration & rollout

1. **Migration** — add `briefs.initiative_id` column + index. Backfill is a no-op (existing briefs stay null).
2. **Suggest extension** — `initiativeId` is optional; existing workspace-scoped suggest path is unchanged. Behind no flag.
3. **Auto-note on completion** — only fires when `initiative_id` is non-null, so no impact on existing one-shot briefs.
4. **UI section** — new component, no existing surface modified.

No flag needed; net-additive everywhere except the suggest prompt builder, which has a clean branch on `initiativeId`.

## Test plan

- **Unit / integration**
  - `suggest.ts` with `initiativeId` produces prompt with initiative-scoped context block; without it falls back to workspace context.
  - Brief completion writes one `agent_notes` row with `kind: 'discovery'`, `importance: 2`, `source.type='brief'`, when and only when `initiative_id` is set.
  - Brief rerun replaces (not duplicates) the prior auto-note.
  - `decompose_initiative` and `refine` context loads include the auto-note (verify via `read_notes` in their existing flows — should require zero changes).
- **Preview-verify**
  - Create a theme initiative with a 2-sentence description.
  - Click **Suggest research** → 3–5 candidates appear scoped to the initiative.
  - Accept one → brief runs → completion writes a note visible in notes rail.
  - Run **Decompose with PM** → confirm proposal `impact_md` references the research finding.
- **MCP smoke** — `yarn mcp:smoke` should pass; no MCP tool surface changes in v1.

## Out of scope (named for clarity)

- Workspace seeding from autopilot ideation — captured in conversation 2026-05-09, deferred.
- A "research watch" auto-loop that fires briefs on its own when an initiative changes status — interesting but the operator-driven loop ships first.
- Replacing autopilot's product-scoped research with the brief system — eventual direction, not part of this work.
- Hierarchical context (rolling up child-initiative briefs into a parent's refine context) — solvable later via the same `read_notes` channel; out for v1.

## Resolved decisions (from review)

1. **Auto-note importance** — `2`. Matches `decompose_initiative`'s default filter so research lands in context without crowding higher-priority signals. Revisit after dogfood.
2. **Auto-note `audience`** — `'pm'`. Single audience; the rail already renders PM-audience notes for human review.
3. **Prior briefs in suggest context** — pass **only** `{ id, title, one_line_summary }` per prior brief, not the result_md. The PM (and the researcher it dispatches) can pull the full body via a new MCP tool when relevant. Keeps the suggest prompt small and lets the researcher decide which prior briefs are worth fetching.
4. **Brief deletion ↔ auto-note** — no DB cascade. When a brief with `initiative_id` is deleted, surface a follow-up UI prompt: "This brief has 1 note attached to <Initiative>. Delete the note too?" Operator decides per-case. Defer implementation until briefs are deletable from the UI.

## New MCP tool (researchers + PM)

`read_brief({ brief_id })` — returns `{ id, title, prompt, result_md, citations, status, completed_at, initiative_id }`.

Belongs in the `research` MCP group (or `core` if there isn't one yet — check `src/lib/mcp/groups/`). Available to any role; primary callers are `researcher` (when investigating an initiative with prior briefs) and `pm` (during refine/decompose if a brief excerpt in a note isn't enough).

The `one_line_summary` field used in suggest context comes from the existing `briefs.title` plus a new `briefs.summary` column populated at completion time — first sentence of `result_md` or an LLM-generated 1-liner. Open: which generation strategy. Defaulting to "first sentence, max 160 chars" for v1; LLM-summarize if that proves noisy.
