---
status: current
last-verified: 2026-05-11
audience: ai-subagents-primary, operator-secondary
code-anchors:
  - src/lib/db/agent-notes.ts
  - src/app/api/agent-notes/[id]/route.ts
  - src/components/notes/NoteCard.tsx
  - src/components/notes/NotesRail.tsx
  - src/components/initiative/InitiativeRunsStrip.tsx
  - src/components/InvestigateModal.tsx
  - src/app/api/initiatives/[id]/investigate/route.ts
  - src/app/api/initiatives/[id]/ask-pm-from-notes/route.ts
  - src/app/api/jobs/route.ts
  - src/lib/db/agent-runs.ts
mcp-tools: [propose_from_notes]
db-tables: [agent_notes, agent_runs]
related-specs:
  - jobs-in-progress.md — agent_runs surface this filters by initiative_id
  - audit-action-recommended.md — auto Ask-PM bridge built atop this manual path
  - subtree-audit-proposals-spec.md — produces the audit notes this manages
---

# Audit Actions & Per-Initiative Run Tracking

Two pain points, one spec because they share surfaces (NoteCard, InvestigateModal, agent_runs):

1. **Audits/notes have no clear next action.** They land in NotesRail and in PM-chat
   context, both inert. Operator can't archive, correct, delete, or hand off to PM.
2. **Investigate has no progress tracking.** Toast disappears in 8–10 s; on refresh
   the operator can't recall what they queued or see where it'll land.

## What we're not changing

- `agent_runs` schema (the jobs spine — already has `initiative_id`, `scope_key`,
  `kind`, `status`, lifecycle helpers; see `specs/jobs-in-progress.md`).
- `agent_notes` schema (`archived_at`/`archived_reason` already present from
  migration 065). We only add a hard-delete DAO and routes.
- `/jobs` page (we link to it; we don't refactor it).
- `propose_from_notes` MCP tool's existing call shape (we add an optional
  `note_ids` arg, no breaking change).

## Slices (stacked PRs against `smb209/mission-control:main`)

### PR 1 — Note lifecycle DAO + HTTP routes
**Scope:** add `restoreNote()` and `hardDeleteNote()` to `src/lib/db/agent-notes.ts`.
Add HTTP surface that the UI can call:
- `POST /api/agent-notes/:id/archive` (body: `{ reason?: string }`)
- `POST /api/agent-notes/:id/restore`
- `DELETE /api/agent-notes/:id` (hard delete; requires the note to be archived first
  so destructive actions are gated by a two-step intent)

**Why two-step:** mirrors the trash metaphor — archive first, then delete from trash.
Prevents accidental loss when an audit is mid-review.

**Tests:** unit tests in `agent-notes.test.ts` for the new DAO calls; route tests
under `src/app/api/agent-notes/__tests__/` for the three HTTP verbs.

### PR 2 — Per-initiative in-flight strip
**Scope:** extend `listJobs()` and `GET /api/jobs` to accept optional
`initiative_id` query param. When set, all three buckets filter to runs whose
`initiative_id` matches (live + recent) or whose recurring job is scoped to that
initiative (scheduled — best-effort; out-of-scope OK if it complicates).

Build `<InitiativeRunsStrip>` (new component under `src/components/initiative/`)
that polls `/api/jobs?workspace_id=…&initiative_id=…` every 2 s and renders a
compact horizontal strip above NotesRail showing live + most-recent terminal
runs. Each row: kind badge, label, elapsed (live) / completed-at (recent),
status, link to `/jobs?run=<id>`.

Mount on `InitiativeDetailView` between header and NotesRail.

### PR 3 — Persistent Investigate confirmation
**Scope:** `POST /api/initiatives/:id/investigate` already returns scope_key +
timestamp; extend the JSON to also return `run_id` (or `run_ids` for subtree
fanout) so the modal can navigate to specific rows in the strip.

In `InvestigateModal`, replace the disappearing toast with an inline persistent
result card under the Investigate button. Card shows: dispatch summary (1 narrow
run / N subtree runs), elapsed time (live polled), "view in Jobs" link, and
"dismiss" button. Card persists until dismissed or initiative is unmounted.

Side effect: even after refresh, the strip from PR 2 already shows the dispatch.
PR 3's card is the in-modal echo; PR 2 is the durable surface.

### PR 4 — Note actions UI (archive, delete, trash view)
**Scope:** add an action row to `NoteCard` with buttons:
- **Archive** → `POST /api/agent-notes/:id/archive`. Optimistic update in hook.
- **Restore** (only when archived) → `POST /api/agent-notes/:id/restore`.
- **Delete** (only when archived) → `DELETE /api/agent-notes/:id`, behind
  `ConfirmDialog` (per project rule: no native `window.confirm`). `destructive`
  styling.

`NotesRail` gets a "Show archived" toggle. When on, the rail fetches with
`include_archived=true` and renders archived notes dimmed at the bottom of the
list. This is the "trash can" view.

Mirror these buttons in PM-chat-rendered notes (later PR; out of scope if PM chat
doesn't render audit notes as cards today — leave a TODO).

### PR 5 — Ask-PM handoff (note → PM proposal)
**Scope:** extend the `propose_from_notes` MCP tool input schema to accept
optional `note_ids: string[]` (defaults to current behavior of "all unconsumed
notes" when absent). When provided, the PM intake prompt is grounded only in
those notes.

Add an "Ask PM to propose" button to `NoteCard` (only when `kind === 'observation'`
per the locked tradeoff). Button calls a new
`POST /api/initiatives/:id/ask-pm-from-notes` route which dispatches the PM with
`trigger_kind='notes_intake'` and `note_ids=[noteId]`.

The resulting PM run shows in the in-flight strip from PR 2 — closes the loop.

### PR 6 — Note ↔ run linkage chip
**Scope:** `agent_notes.scope_key` already joins to `agent_runs.scope_key`.
Add a server-side join in the `/api/agent-notes` payload (or a sibling endpoint
if join cost matters) that returns `originating_run_kind` + `originating_run_status`.
Render a small chip on `NoteCard` ("from Audit · complete") that links to the
`/jobs?run=<id>` drill-down.

## Verification

For each PR, follow the project verify pattern:
1. `yarn typecheck` + `yarn test` (relevant slices) — inventory pre-existing
   failures up-front per CLAUDE.md.
2. For UI changes, `preview_eval` on `mission-control-dev` (running on :4010)
   exercising the touched flow, then `preview_logs` for runtime errors.
3. PR body uses `## Summary` / `## Changes` / `## Test plan`; target
   `smb209/mission-control` with explicit `--repo` per project rules.

## Out of scope (named so we don't drift)

- Editing note bodies inline. The "Correct" button I'd originally proposed in
  the plan turned into a fork: either edit-in-place (heavy: needs a new column /
  audit log) or store an amendment as a child note (lightweight). Both are
  valuable but neither is on the critical path for "no next action." Leave for a
  follow-up; "Ask PM" + archive cover the immediate need.
- PM-chat note rendering parity. PM chat surfaces note text inside the
  conversation transcript, not as discrete cards; making chat-rendered notes
  actionable is a separate UX problem.
- SSE upgrade for the in-flight strip. 2 s polling matches `/jobs` page.
