# Research Area — Spec (Draft)

A first-class hub for **standing research interests, scheduled briefs, and on-demand investigations**. Output is structured *briefs* that other surfaces (Initiatives, PM, Calendar, Decisions) can cite.

## Core objects

### Topic
A long-lived area of interest. Not a question — a *beat*.

| Field | Notes |
|---|---|
| `name` | "GLP-1 regulation", "Competitor: Acme", "DE/CA filing obligations" |
| `description` | Why this matters; framing for the agent |
| `tags` | freeform |
| `default_brief_template` | which template to use when scheduling auto-briefs |
| `linked_initiatives` | optional |
| `archived_at` | soft-delete |

### Brief
A single research output. Standalone, or attached to a topic.

| Field | Notes |
|---|---|
| `topic_id` | nullable (one-shot briefs allowed) |
| `title` | |
| `prompt` | the actual question / instruction sent to the agent |
| `template` | see Templates below |
| `status` | `queued` / `in_progress` / `complete` / `failed` / `cancelled` |
| `requested_by` | user, schedule, or trigger |
| `result_md` | rendered markdown body |
| `citations` | structured list (url, title, accessed_at, snippet) |
| `proposals` | optional — see "Briefs as proposal sources" |
| `created_at` / `started_at` / `completed_at` | |

### Schedule
A trigger that produces briefs on a cadence or event.

| Field | Notes |
|---|---|
| `topic_id` | required |
| `template` | which brief template to run |
| `cadence` | cron expr, or `event:<name>` (e.g. `event:initiative.status_changed`) |
| `next_run_at` | computed |
| `last_run_brief_id` | for diff-against-previous |
| `enabled` | |

## Templates

Briefs are template-driven so cadence + agent prompt + output shape are consistent across runs (and diffable across time).

| Template | Purpose | Output shape |
|---|---|---|
| `general_brief` | Open-ended research prompt | Free-form md + citations |
| `competitive_watch` | Snapshot one competitor: pricing, positioning, recent news, hiring signals, product changes | Sectioned md, **diff vs. previous run highlighted** |
| `market_scan` | Survey of N players in a category | Comparison table |
| `regulatory_scan` | Filing/compliance obligations for a jurisdiction or entity type | Obligations list (each with deadline / cadence — feeds Calendar proposals) |
| `decision_support` | Compare options against criteria for a pending decision | Pro/con grid, recommendation |
| `recurring_status` | Re-survey a topic and emit only what's *new* since last run | Delta-only md |

Templates live in code initially; promote to DB once we want UI editing.

## Surfaces

### Hub dashboard (`/research`)
Three lanes:
- **In progress** — briefs currently running (status, agent, elapsed)
- **Upcoming** — next ~10 scheduled runs with their topic + template
- **Recent results** — completed briefs (newest first), grouped by topic

Plus a topic library on the left rail.

### Topic detail (`/research/topics/[id]`)
- Description + linked initiatives
- Schedule list (cadence, last run, next run, enable/disable)
- Brief history (timeline, with template badges and "diff vs previous" link for `recurring_status` / `competitive_watch`)
- "Run brief now" button (template chooser)

### Brief detail (`/research/briefs/[id]`)
- Header: topic, template, status, requested-by, timestamps
- Body: rendered markdown
- Citations panel
- "Proposals from this brief" (see below)
- Actions: cite from initiative, attach to decision, re-run, archive

## Briefs as proposal sources

Some templates emit **proposals** alongside the narrative body, mirroring the existing PM-decomposition / autopilot proposal pattern:

- `regulatory_scan` → Calendar entries (filing deadlines, recurring obligations)
- `competitive_watch` → Risks (e.g. "Acme launched feature X — risk to roadmap item Y")
- `decision_support` → a draft Decision in the Decisions log
- `general_brief` → Tasks or Initiatives (when the agent flags an action)

Proposals reuse the existing revertable-proposal infrastructure (`/pm/activity` model) — review, accept individually or in bulk, accepted proposals create real records linked back to the brief.

## Execution model

- Briefs run as **dispatched agent missions** with a research persona, consistent with PM / autopilot dispatch (not openclaw missions). Persona prompt + template = full agent prompt.
- Long-running briefs stream progress into the activity log under a `research.brief.*` event family.
- Failed briefs surface with a retry button + error excerpt; we don't auto-retry.

## Open questions

- Do we want **scoped research** (per-workspace) or **global**? Lean per-workspace, with a "global topics" escape hatch for things like company-wide regulatory scans.
- How do citations interact with the upcoming Memory layer? Likely briefs *write into* memory by default, so future briefs can ground on past findings.
- Templates as code vs. data — start in code; revisit once we have ≥ 5 in active use.
- Cost ceiling per brief / per topic per month, with soft warning before run.

## Phase plan

1. Topic + Brief tables, manual "run a brief" with `general_brief` template, hub dashboard skeleton.
2. Schedules + cron runner.
3. Templates: `competitive_watch`, `regulatory_scan`.
4. Proposals from briefs (Calendar + Risks integrations).
5. Diff view for recurring templates; Memory integration.
