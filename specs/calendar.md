# Calendar — Spec (Draft)

A unified timeline of **dated obligations and milestones** the project needs to track: regulatory deadlines, releases, recurring filings, stakeholder updates, sweep cadences, vendor contract renewals. Agent-proposable: "do the research and put it on the calendar."

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

## Proposals from research

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

- **Roadmap** overlay toggle: show milestone-category entries on the roadmap.
- **Tasks**: linking is bidirectional; closing the linked task can optionally close the entry.
- **PM agent**: PM can read the calendar when planning ("don't schedule this initiative the same week as the DE filing crunch").

## Open questions

- Per-workspace vs. cross-workspace? Some obligations (corporate filings) span all workspaces. Probably support a "global" scope at entry level.
- Time zones — store everything in UTC + render in user's local; allow per-entry override for filings that have a specific jurisdictional deadline time.
- ICS export for entries the user wants in their personal calendar. Read-only feed URL per workspace.
- How heavy should recurrence be? RFC-5545 RRULE covers 99%; start with a small enum (yearly/quarterly/monthly) + custom RRULE escape hatch.
- Conflict detection: warn when proposed entries cluster in a single week beyond a threshold.

## Phase plan

1. CalendarEntry table, manual CRUD, month + agenda views.
2. Recurrence (occurrences materialized via cron).
3. Proposal flow + first proposing template (`regulatory_scan` from Research).
4. **Readiness model**: requirements schema, readiness sweep, entry-detail readiness panel. Manual `source: manual` requirements first; then `memory_query` and `brief_template` sources.
5. Linked tasks + roadmap overlay; readiness templates for the common entry types.
6. `workflow:<id>` requirement source (depends on Workflows engine).
7. ICS feed, header reminder badge with escalation count.
