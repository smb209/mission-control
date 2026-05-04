# Decisions & Assumptions — Spec (Draft)

Two related but distinct artifacts that share a surface:

- **Decisions** — durable, ratified ADR-style records: "we chose X over Y because Z."
- **Assumptions** — open questions / working hypotheses we haven't yet decided. The PM agent's parking lot.

Decisions are forever; assumptions either get *resolved into* decisions, *converted to* research briefs, or *promoted to* risks.

## Core objects

### Decision
| Field | Notes |
|---|---|
| `title` | "Use SQLite + WAL for the metadata store" |
| `context` | what situation forced the choice |
| `options_considered` | structured list — option name + summary |
| `chosen_option` | which one won |
| `rationale` | why this option |
| `consequences` | knock-on effects, what we accept by choosing this |
| `status` | `proposed` / `accepted` / `superseded` / `deprecated` |
| `superseded_by` | decision_id, if status=superseded |
| `linked_initiative_id` | optional |
| `linked_risk_ids` | risks this decision creates or closes |
| `decided_by` | person/agent |
| `decided_at` | |
| `source` | `manual` / `brief:<id>` / `proposal:<id>` |

Append-only by convention: changes mean *create a new decision that supersedes the old one*, not edit. We display the chain.

### Assumption
| Field | Notes |
|---|---|
| `statement` | "We assume CA registration triggers a separate franchise tax filing" |
| `confidence` | low / medium / high |
| `criticality` | how much rides on this being true (low / medium / high) |
| `status` | `open` / `validated` / `invalidated` / `decided` / `risked` |
| `owner` | who's chasing the answer |
| `linked_initiative_id` | optional |
| `created_at` / `updated_at` / `resolved_at` | |
| `resolution` | freeform; references decision/risk/brief that closed it |

Assumptions are deliberately lighter weight than risks or decisions — easy to capture so they don't sit only in the PM agent's working memory.

## Surfaces

### Hub (`/decisions`)
Tabs:
- **Decisions** — list (newest first), filter by status; supersession chains visualized.
- **Assumptions** — list (open first by criticality × low-confidence), filter by status/owner.
- **Resolved** — assumptions that became decisions/risks/briefs (audit trail).

### Decision detail (`/decisions/[id]`)
- Full ADR rendering: context → options → choice → rationale → consequences
- Linked initiatives, linked risks
- Supersession chain (older → this → newer)
- Sources (briefs, conversations) cited

### Assumption detail (`/decisions/assumptions/[id]`)
- Statement + criticality/confidence grid (similar visual to risk likelihood/impact)
- Owner + age
- Action buttons:
  - **Resolve as decision** → opens decision draft pre-filled
  - **Convert to research brief** → creates a `decision_support` brief
  - **Promote to risk** → creates a Risk pre-filled with the assumption's downside
  - **Validate / invalidate** (no decision needed, just confirmation)

## Proposals & agent assist

- PM and brief outputs propose **assumptions** liberally — low cost to capture.
- `decision_support` briefs propose **decisions** with options + rationale; user reviews/edits before accepting.
- Periodic sweep: open assumptions older than N days with high criticality + low confidence get surfaced as a "stale assumptions" digest.

## Integrations

- **Initiative detail** gains an "Assumptions & Decisions" tab listing both.
- **Risks**: a risk's `source` can be `assumption:<id>` if it was promoted from one.
- **Memory**: accepted decisions write a memory note; the Memory layer treats them as durable facts the PM agent can cite without re-deriving.

## Open questions

- Should we render decisions as markdown in `specs/` (file-backed) or DB? Lean DB so they're queryable and linkable, with a markdown export for the engineering-style ADR archive.
- Confidence/criticality bands: 3-step (low/medium/high) is enough to start; resist sliding into 1–10 numerics.
- Auto-prompt: when a PM proposes a plan, can it surface "this depends on assumption X" inline? Worth wiring once the assumption store is populated.
- "Decision drift": when the chosen-option's consequences haven't been observed in N days, prompt a review.

## Phase plan

1. Decision + Assumption tables, manual CRUD, hub list views.
2. Action flows from assumption → brief / risk / decision.
3. Decision-supersession chains; ADR markdown export.
4. PM/brief proposal sources; stale-assumptions digest.
5. Memory integration (decisions as durable facts).
