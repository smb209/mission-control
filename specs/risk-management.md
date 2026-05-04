# Risk Management — Spec (Draft)

A risk register with **agent-assisted sweeps**, scoring history, and a dashboard that makes "what's the worst that could happen, and what are we doing about it" answerable in one glance.

## Core objects

### Risk
| Field | Notes |
|---|---|
| `title` | "Vendor X EOL'd before we migrate" |
| `description` | What it is, why it matters |
| `category` | technical / operational / market / legal / people / financial |
| `likelihood` | 1–5 |
| `impact` | 1–5 |
| `exposure` | computed = likelihood × impact (1–25) |
| `status` | `open` / `mitigating` / `accepted` / `transferred` / `closed` |
| `owner` | person/agent responsible for next action |
| `mitigation` | freeform plan; can link to tasks/initiatives |
| `linked_initiative_id` | optional |
| `linked_task_ids` | optional |
| `source` | `manual` / `sweep:<sweep_id>` / `brief:<brief_id>` |
| `created_at` / `updated_at` / `closed_at` | |

### ScoreHistory
Append-only row each time likelihood/impact change. Powers trend lines + "what changed since last review" views. Includes `reason` (freeform) and `actor`.

### Sweep
A scheduled or on-demand agent pass that proposes new risks and re-scores existing ones.

| Field | Notes |
|---|---|
| `scope` | global / initiative / category |
| `cadence` | cron or `manual` |
| `last_run_at` / `next_run_at` | |
| `last_run_proposals_id` | pointer to proposal batch |

### Proposal (sweep output)
Reuses the existing revertable-proposal infrastructure. Each proposal is one of:
- `add_risk` — new risk with suggested score + rationale
- `rescore` — proposed likelihood/impact change with rationale
- `close` — risk no longer relevant
- `add_mitigation_task` — concrete task to attach to an initiative

## Surfaces

### Dashboard (`/risks`)
- **Heatmap** (5×5 likelihood × impact, cells colored by exposure, count of risks per cell, click → filtered list)
- **Top exposure** — top N open risks by exposure score
- **Trend** — count of open risks by category over time, plus "newly created" / "newly closed" counts in the last 7/30 days
- **Overdue mitigations** — risks where `mitigation` references a task that is blocked or overdue
- **Sweep status** — last sweep, next sweep, pending proposals badge

### Register (`/risks/register`)
Sortable table: title, category, likelihood, impact, exposure, status, owner, last reviewed.
Filters: status, category, owner, linked initiative.

### Risk detail (`/risks/[id]`)
- Score (with history sparkline)
- Mitigation plan + linked tasks (status pulled live)
- Activity timeline (created, rescored, status changes, sweep notes)
- "Re-review" action — opens the score editor with a required reason

### Sweep activity (`/risks/sweeps`)
List of sweep runs with their proposal batches; click into a batch for review/accept/reject (mirrors `/pm/activity`).

## Roadmap integration

- The Roadmap view gets a **risk pill** on each initiative card showing top exposure of linked risks.
- Initiative detail view gets a "Risks" tab listing linked risks + a "Sweep this initiative" button.

## Sweep behavior

- **Global sweep** (default monthly): full register pass — propose rescores where confidence > threshold; flag stale risks (no review in 90 days).
- **Initiative sweep** (triggered on initiative status change to `planning` or `in_progress`): propose risks specific to the initiative scope.
- **Event sweep** (triggered by external signals — eventually): e.g. competitive_watch brief flags a market shift → sweep market-category risks.

Sweeps run as dispatched agent missions; outputs go through proposal review before becoming real records. Never auto-mutates an existing risk.

## Open questions

- Scoring scheme: 1–5 likelihood × 1–5 impact is the standard PMI-style grid. Consider qualitative bands ("rare/possible/likely/almost certain") for the UI even if the underlying number is 1–5.
- Should `accepted` risks still appear in heatmap? Lean yes (with an "accepted" treatment) so they don't get forgotten.
- How to handle **risk dependencies** (risk A only matters if risk B materializes)? Defer — start flat.
- Auto-close criteria — should the agent be allowed to propose closing a risk that's been `accepted` for > N days with no change? Probably yes, as a proposal.
- Cost guardrail: limit sweep scope (max risks per pass) so a misconfigured monthly sweep can't burn through budget.

## Phase plan

1. Risk + ScoreHistory tables, manual register CRUD, basic dashboard (heatmap + top exposure).
2. Manual "Run sweep" button → agent proposes adds/rescores → proposal review.
3. Scheduled global sweep + initiative-trigger sweep.
4. Roadmap/initiative integration (risk pill + tab).
5. Trend charts, overdue mitigations, sweep activity surface.
