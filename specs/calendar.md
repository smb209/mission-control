---
status: aspirational
built: false
last-verified: 2026-05-11
---

# Calendar — Spec (Draft)

> **Status: aspirational — not yet built.** This doc describes intended behavior. The `/calendar` route renders this doc as a placeholder. No schema, MCP tools, or backing code exist yet.

A unified timeline of **dated obligations and milestones** the project needs to track: regulatory deadlines, releases, recurring filings, stakeholder updates, sweep cadences, vendor contract renewals. Fully addressable via natural language through the PM chat, fed by research briefs and roadmap milestones, and backed by a proactive lookahead agent that surfaces prep work before deadlines arrive.

## Core objects

### CalendarEntry
| Field | Notes |
|---|---|
| `title` | "DE Annual Franchise Tax filing" |
| `description` | Context, links, what "done" looks like |
| `category` | filing / milestone / release / review / renewal / external / freeform |
| `date` | ISO date (or datetime if time-of-day matters) |
| `recurrence` | none / RFC-5545 RRULE (yearly, quarterly, etc.) |
| `lead_time_days` | how far ahead to surface as "upcoming" |
| `status` | `upcoming` / `in_progress` / `done` / `skipped` / `missed` |
| `owner` | person responsible |
| `linked_task_id` | optional — promote to a task when work is needed |
| `linked_initiative_id` | optional |
| `source` | `manual` / `proposal:<id>` / `import:<source>` |
| `notes` | post-completion freeform |
| `readiness_requirements` | structured list — see "Readiness model" below |
| `readiness_status` | `unknown` / `ready` / `partial` / `blocked` (computed) |
| `readiness_checked_at` | last time MC evaluated requirements |

### Occurrence (for recurring entries)
A recurring entry materializes individual occurrences as their lead-time window opens. Each occurrence has its own status + linked task. This keeps "I did the 2026 filing" distinct from "the 2027 filing is upcoming."

## PM chat integration

The calendar is a first-class surface the PM agent can read and write via natural language. All mutations go through the existing `propose_changes` pipeline — same `PmDiff[]` mechanism, same activity timeline, same revert flow.

### New PmDiff kinds

| Kind | Fields | Example utterance |
|---|---|---|
| `create_calendar_entry` | title, date, category, recurrence, lead_time_days, owner, description, readiness_template | "Add a quarterly board prep event starting June 1" |
| `shift_calendar_entry` | entry_id, new_date, reason | "Push the DE filing to March 15" |
| `update_calendar_entry` | entry_id, delta (any mutable field) | "Change the owner of the CA SOI to Sarah" |
| `cancel_calendar_entry` | entry_id, reason | "Cancel the Q3 investor update" |
| `link_calendar_to_task` | entry_id, task_id | "Create a task for the DE filing" |
| `add_readiness_requirement` | entry_id, requirement | "Add a requirement: need the board deck drafted" |

### System prompt context

When the PM agent session starts, its context includes:

- **Upcoming window**: all entries within the next 30 days (title, date, status, readiness status)
- **Escalations**: any entries with `readiness_status: blocked` or `partial`
- **Missed**: any entries past `date` that aren't `done`

This allows the PM to proactively reference the calendar in planning conversations without being asked. Example behaviors:

- User says "let's schedule a release for next Tuesday" → PM checks the calendar, sees the DE filing is that week, warns about the conflict before proposing.
- User asks "what do we need to get done this month?" → PM synthesizes across roadmap + calendar, prioritizing entries with readiness gaps.
- User says "research our tax obligations and put them on the calendar" → PM dispatches a `regulatory_scan` brief and routes the results through the calendar proposal pipeline.

### Query surface

The PM can answer calendar questions conversationally:

- "What's coming up next week?"
- "When is the next board meeting?"
- "Are we ready for the CA filing?"
- "What are we missing for the DE franchise tax?"
- "Show me everything tagged 'filing' in Q3"

Backed by MCP tools: `get_calendar_upcoming`, `get_calendar_entry`, `search_calendar_entries`, `get_readiness_status`.

## Event sources

The calendar aggregates dated events from multiple subsystems. Each source uses the proposal pipeline — entries don't appear silently.

### Research-derived entries (proposals)

Mirrors PM decomposition / brief-derived proposals.

**Example flow** ("DE C-corp + CA registered foreign entity" case):

1. User: "We're a DE C-corp also registered in CA. Research filing requirements (taxes + reports) and put them on the calendar."
2. PM dispatches a `regulatory_scan` brief.
3. Brief returns an obligations list; for each obligation it emits a **CalendarEntry proposal** (title, date, recurrence, lead time, source citation).
4. User reviews the proposal batch on `/calendar/proposals/[id]` (same UI shape as `/pm/activity`):
   - Accept all / accept individually / edit before accept / reject with reason.
5. Accepted proposals create real CalendarEntries; rejected ones are kept on the proposal batch for audit but not promoted.

This same mechanism handles:
- Risk sweeps proposing review dates
- Initiative decomposition proposing milestone dates
- Stakeholder cadence proposing recurring update slots

### Roadmap overlays (auto-materialized)

Initiative milestones and target dates from the roadmap auto-materialize as **read-only overlay entries** on the calendar. These are not stored in `calendar_entries` — they're queried from the initiatives table at render time and displayed with a distinct visual treatment (dashed border, roadmap icon).

- **What appears**: any initiative with a `target_date` set, regardless of kind (theme, milestone, epic, story)
- **Visual layer**: togglable overlay on all calendar views; on by default
- **Interaction**: clicking an overlay entry navigates to the initiative detail page, not a calendar entry detail
- **No readiness model**: overlays don't have readiness requirements — they're informational. If an initiative milestone needs prep tracking, the operator promotes it to a real calendar entry (button on the overlay card → creates a `create_calendar_entry` proposal pre-filled from the initiative)
- **Conflict awareness**: the PM agent and lookahead agent both see overlay entries when checking for date clustering

### Stakeholder cadence entries

When a stakeholder record has a defined update cadence (e.g., "monthly investor update"), the comms subsystem proposes recurring calendar entries via the proposal pipeline. These are real `CalendarEntry` records with `category: review` and `source: stakeholder:<id>`.

### Risk review cadence

Risk sweeps that propose a next-review date for a risk emit a calendar entry proposal with `category: review`, `linked_risk_id`, and a readiness template appropriate to the risk type.

## Readiness model

The point of the calendar isn't to nag — it's to know whether we're *ready to act* when the date arrives, and to do something about it if we aren't. Each entry can declare what information or artifacts are needed to execute it; MC checks readiness on a schedule and surfaces the gap.

### Requirement
| Field | Notes |
|---|---|
| `label` | "Total revenue for fiscal year" |
| `kind` | `fact` / `document` / `decision` / `external_data` / `human_confirm` |
| `source` | how to satisfy it: `memory_query` / `db_query` / `brief_template` / `workflow:<id>` / `manual` |
| `source_args` | structured args for the source (query string, brief topic id, workflow input) |
| `cache_ttl_days` | how long a satisfied value remains valid before re-checking |
| `status` | `missing` / `stale` / `satisfied` / `unsatisfiable` |
| `value` | last satisfied value (snapshot) |
| `satisfied_at` / `satisfied_by` | provenance |

### Example: DE franchise tax requirements
```yaml
- label: Total authorized shares
  kind: fact
  source: memory_query
  source_args: { key: "corp.de.authorized_shares" }
  cache_ttl_days: 365

- label: Gross assets (most recent fiscal year)
  kind: fact
  source: brief_template
  source_args: { template: "regulatory_scan", topic: "internal_financials_q4" }
  cache_ttl_days: 90

- label: Principal place of business address
  kind: fact
  source: memory_query
  source_args: { key: "corp.principal_address" }
  cache_ttl_days: 365

- label: Filing fee payment method confirmed
  kind: human_confirm
  source: manual
  cache_ttl_days: 30
```

### Readiness sweep

A scheduled job evaluates each upcoming entry's requirements (within `2 × lead_time_days` of `date`) and updates `readiness_status`:

- All requirements `satisfied` → `ready`
- Any `missing` or `stale` requirements that have an automatable `source` → MC **proactively fetches** them (dispatches the brief, runs the workflow, queries memory) before falling back to escalation
- Any `missing` requirements with `source: manual` or `kind: human_confirm` → `partial`, escalated as the date approaches
- Any `unsatisfiable` requirement → `blocked`, escalated immediately

Escalation surfaces in the upcoming rail with an explicit gap list — *"DE Franchise Tax in 12 days: missing gross assets figure (auto-fetch attempted, brief failed); missing payment method confirmation (needs you)"* — so the operator sees exactly what's left rather than a generic reminder.

### Templates

Common entry types ship with default `readiness_requirements` templates so the operator doesn't author them from scratch:

- `de_franchise_tax` — shares, gross assets, address, payment method
- `ca_statement_of_information` — officers, agent for service, address
- `release_milestone` — release notes drafted, changelog updated, comms drafted
- `quarterly_board_meeting` — agenda, financial summary, prior-quarter actions reviewed

A `regulatory_scan` brief that proposes a calendar entry should also propose its readiness requirement template based on the obligation type.

## Lookahead agent

A scheduled agent process that scans the calendar horizon, identifies what needs preparation, and **proposes** actions for operator review. It does not dispatch work autonomously — it surfaces gaps and recommends next steps.

### Cadence

Runs as a `recurring_job` on a configurable schedule (default: daily). Scans all entries within a configurable horizon (default: `3 × lead_time_days` per entry, minimum 14 days out).

### Responsibilities

**1. Readiness gap analysis**
For each upcoming entry, evaluate its readiness requirements. For gaps:
- Identify which requirements are `missing` or `stale`
- Propose specific actions to fill them: "Dispatch `regulatory_scan` brief for gross assets figure", "Create task: draft Q3 board deck", "Ask operator to confirm payment method"
- Rank by urgency (days until entry date ÷ lead time remaining)

**2. Prep work proposals**
Beyond readiness requirements, the agent reasons about what *else* might be needed:
- Proposes task drafts for complex entries ("The annual audit is in 3 weeks — propose a task to gather all vendor contracts")
- Proposes research briefs when context is thin ("The CA SOI filing is in 6 weeks but we have no memory entries about current officers — propose a brief to verify")
- Proposes stakeholder notifications ("Board meeting in 2 weeks — propose a draft agenda update to board members")

**3. Conflict and clustering detection**
- Flags weeks with more than N entries (configurable, default 3)
- Flags entries competing for the same owner's time
- Proposes date shifts when clustering is severe, citing the specific conflicts

**4. Occurrence materialization check**
For recurring entries, verifies that the next occurrence has been materialized and its readiness requirements initialized. Proposes materialization if the cron job missed it.

**5. Post-completion capture**
For recently completed entries (`done` within last 7 days), proposes memory entries to capture outcomes: "DE franchise tax filed on 2026-03-01, $400 paid, confirmation #12345." This feeds the memory integration loop (see below).

### Output

Each run produces a **lookahead report** visible at `/calendar/lookahead/[run_id]`:
- Summary: N entries scanned, M readiness gaps found, K proposals generated
- Grouped by entry: each upcoming entry with its gap analysis and proposed actions
- Operator can accept/reject/edit each proposal individually (same UX as PM activity)

Proposals from the lookahead agent have `source: lookahead:<run_id>` for audit trail.

### Escalation

If the same readiness gap persists across multiple lookahead runs and the entry date is within `lead_time_days`, the agent escalates: the entry's escalation severity increases, and it surfaces in the `/escalations` inbox with the full history of what was tried.

## Surfaces

### Calendar view (`/calendar`)
Default = month grid. Toggles for week / agenda (list) / quarter view. Color-coded by category. Filters: category, owner, source.

### Upcoming rail (`/calendar?view=upcoming`)
List of next ~30 days of entries past their `lead_time_days` threshold, grouped by week. The "what's coming up" view PM/autopilot can cite.

### Entry detail (`/calendar/[id]`)
- Header: title, date(s), recurrence, status, **readiness pill** (ready / partial / blocked)
- Description + citations (when from a proposal)
- **Readiness panel** — each requirement with status, current value (or "missing"), source, last-checked timestamp, and per-requirement actions (re-fetch / mark satisfied / edit source)
- Linked task (with status); button to "Create task for this" if not yet linked
- Occurrence history (for recurring entries) — readiness history per occurrence
- Activity timeline (incl. readiness-sweep events: fetched, escalated, satisfied)

### Proposals (`/calendar/proposals`)
Pending and historical proposal batches. Same review UX as PM activity.

## Reminder model

- An entry past its `(date - lead_time_days)` threshold and not `done` shows as **upcoming**.
- Past `date` and not `done` → **missed** (red).
- An entry with `readiness_status: blocked` or `partial` within `2 × lead_time_days` shows as an **escalation** (orange), distinct from a generic upcoming reminder — the operator sees *what's missing*, not just *that something's coming*.
- The Mission Control header gets a small bell badge with count of upcoming + missed + escalations for the current workspace. (Future — not in phase 1.)

## Integrations

### Memory subsystem

The calendar is both a **consumer** and **producer** of memory entries, making it a core node in the memory graph.

**Consumer (memory → calendar)**:
- Readiness requirements with `source: memory_query` pull facts from the memory layer (e.g., "corp.de.authorized_shares"). The retrieval is logged in `memory_retrievals` for provenance.
- When the gardener updates or quarantines a memory entry, any calendar readiness requirement that depends on it is automatically marked `stale`, triggering re-evaluation on the next readiness sweep.
- Recurring entries can reference prior-occurrence memory to pre-fill context: "Last year's DE filing used the assumed par value method — start from that."

**Producer (calendar → memory)**:
- When an entry is marked `done`, the lookahead agent (post-completion capture) proposes a memory entry recording the outcome. These are **project-scoped** if the entry has a `linked_initiative_id`, otherwise **org-scoped**.
- Readiness requirement values that are satisfied become memory candidates — e.g., a freshly-verified gross assets figure fetched for the DE filing is worth persisting for future use.
- The `satisfied_by` provenance on requirements creates a retrieval trail: if a memory entry later turns out to be wrong, blast-radius analysis can trace which calendar entries relied on it.

**Gardener interaction**:
- The gardener's **verify** pass can cross-reference calendar-derived memory entries against their source (brief output, manual confirmation) to detect drift.
- The gardener's **closure pass** on a completed initiative checks for any calendar entries linked to it and proposes archival of their associated memory entries.

### Roadmap
Overlay toggle: show initiative target dates on the calendar as read-only overlays (see "Roadmap overlays" above).

### Tasks
Linking is bidirectional; closing the linked task can optionally close the entry.

### PM agent
PM reads the calendar in its system prompt context (see "PM chat integration" above) and can propose mutations via calendar PmDiff kinds.

### Research
Research briefs propose calendar entries via the proposal pipeline. The calendar can also trigger research: readiness requirements with `source: brief_template` dispatch briefs on demand.

### Workflows
Readiness requirements with `source: workflow:<id>` integrate with the workflows engine when available.

## Open questions

- Per-workspace vs. cross-workspace? Some obligations (corporate filings) span all workspaces. Probably support a "global" scope at entry level.
- Time zones — store everything in UTC + render in user's local; allow per-entry override for filings that have a specific jurisdictional deadline time.
- ICS export for entries the user wants in their personal calendar. Read-only feed URL per workspace.
- How heavy should recurrence be? RFC-5545 RRULE covers 99%; start with a small enum (yearly/quarterly/monthly) + custom RRULE escape hatch.
- Conflict detection: warn when proposed entries cluster in a single week beyond a threshold.
- ~~Roadmap sync: auto-materialize vs. propose?~~ **Resolved**: auto-materialize as read-only overlays, with promote-to-entry escape hatch.
- Lookahead agent scope: should it ever auto-dispatch (briefs, tasks) or always propose? **Resolved**: surface + propose only. Operator approves all prep work.
- Memory entry lifecycle for calendar outcomes: should completed-entry memory entries be auto-accepted or go through the gardener's proposal pipeline? Leaning toward proposal pipeline for consistency.
- Lookahead horizon: fixed (e.g., 30 days) or per-entry (`3 × lead_time_days`)? Current spec says per-entry with a 14-day floor — is that right?
- Should the PM be able to create calendar entries directly (bypass proposal review) for simple cases like "remind me to check on X next Friday"? Or keep everything in the proposal flow for audit consistency?

## Phase plan

1. CalendarEntry table, manual CRUD, month + agenda views.
2. **PM chat integration**: calendar PmDiff kinds, MCP query tools (`get_calendar_upcoming`, `search_calendar_entries`, `get_readiness_status`), PM system prompt calendar context injection.
3. Recurrence (occurrences materialized via cron).
4. **Roadmap overlays**: auto-materialize initiative target dates as read-only overlay entries on all calendar views; promote-to-entry action.
5. Proposal flow + first proposing template (`regulatory_scan` from Research). Stakeholder cadence + risk review cadence proposals.
6. **Readiness model**: requirements schema, readiness sweep, entry-detail readiness panel. Manual `source: manual` requirements first; then `memory_query` and `brief_template` sources.
7. **Memory integration**: calendar-as-consumer (readiness requirements pulling from memory, gardener-triggered staleness). Calendar-as-producer (post-completion memory capture, requirement values as memory candidates).
8. **Lookahead agent**: daily recurring job — readiness gap analysis, prep work proposals, conflict detection, post-completion capture. Lookahead report UI.
9. Linked tasks + readiness templates for common entry types.
10. `workflow:<id>` requirement source (depends on Workflows engine).
11. Lookahead escalation (persistent gaps → `/escalations` inbox).
12. ICS feed, header reminder badge with escalation count.
