---
status: aspirational
built: false
last-verified: 2026-05-11
---

# Stakeholders & Comms — Spec (Draft)

> **Status: aspirational — not yet built.** This doc describes intended behavior. The `/stakeholders` route renders this doc as a placeholder. No schema, MCP tools, or backing code exist yet.

Track **who needs to know what, when**, and let agents draft the updates. Closes the "what should I tell people this week" loop without auto-sending anything.

## Core objects

### Stakeholder
| Field | Notes |
|---|---|
| `name` | |
| `role` | "Investor", "Co-founder", "Advisor", "Customer: Acme", "Team: Eng" |
| `contact` | freeform; email/Slack/etc — not used for auto-send |
| `interests` | tags or linked initiatives — what they care about |
| `update_cadence` | weekly / biweekly / monthly / on-demand / `event:<name>` |
| `preferred_format` | summary / detailed / metrics-only |
| `notes` | |
| `archived_at` | |

### UpdatePlan
A standing intent to send a recurring update to a stakeholder.

| Field | Notes |
|---|---|
| `stakeholder_id` | |
| `cadence` | RRULE or event trigger |
| `template` | which draft template (see below) |
| `last_drafted_at` / `last_sent_at` | |
| `enabled` | |

### Draft
An agent-generated update awaiting human review.

| Field | Notes |
|---|---|
| `stakeholder_id` | |
| `plan_id` | nullable (ad-hoc drafts allowed) |
| `body_md` | the actual draft |
| `sources` | structured: linked initiative IDs, task IDs, brief IDs, calendar entries cited |
| `status` | `draft` / `approved` / `sent` / `discarded` |
| `created_at` / `approved_at` / `sent_at` | |

## Templates

| Template | For | Pulls from |
|---|---|---|
| `weekly_status` | Internal team / co-founder | Last week's completed initiatives, in-flight blockers, upcoming milestones |
| `investor_update` | Investors | Higher-level: shipped, metrics deltas, asks, lowlights |
| `customer_release_note` | Customer / external | What shipped that affects them, with links |
| `incident_followup` | Anyone affected by an incident | Postmortem-style; triggered by event |
| `ad_hoc` | Anyone | Empty template; user provides the prompt |

## Surfaces

### Stakeholder list (`/stakeholders`)
Table: name, role, cadence, last update sent, next draft due, interests tags. Filters by role, cadence.

### Stakeholder detail (`/stakeholders/[id]`)
- Profile + interests
- Update plans (cadence, template, enable/disable)
- Update history (timeline of sent/discarded drafts)
- "Draft an update now" button

### Drafts inbox (`/stakeholders/drafts`)
Pending drafts across all stakeholders, oldest first. Each row: stakeholder, template, age, source-count badge.

### Draft detail (`/stakeholders/drafts/[id]`)
- Rendered markdown body, editable in place
- Sources panel (collapsed by default) — shows what the agent pulled from, with links
- Actions: **Approve & mark sent** / **Approve & copy to clipboard** / **Discard** / **Regenerate**
- We do not auto-send. Period. (See Open Questions for "send via integration" later.)

## Triggers

- Cadence-based: cron evaluates `UpdatePlan.cadence`, drafts produced ahead of due date.
- Event-based: e.g. `initiative.shipped` → draft a `customer_release_note` for stakeholders interested in that initiative; `incident.opened` → draft `incident_followup`.

## Privacy guardrails

- Drafts are workspace-scoped; no cross-workspace data leaks into a stakeholder draft unless the stakeholder is explicitly tagged on a multi-workspace topic.
- Sources panel always exposes what the agent saw — no opaque "trust me" summaries.
- "Sensitive" tags on initiatives/tasks excluded from external-template drafts by default.

## Open questions

- Sending: out of scope for v1 (copy/paste workflow). Eventually integrate with Slack / email / a "Send via Gmail draft" affordance — but that requires the explicit-permission action flow per global rules.
- Stakeholder ↔ Memory layer: when a stakeholder is referenced repeatedly, should context auto-promote into Memory? Probably yes once Memory is online.
- Diff vs. previous update — for recurring updates, highlight what's new since last send.
- Approval routing — for now, single approver (the operator). Multi-approver routing is post-MVP.

## Phase plan

1. Stakeholder + Draft tables, manual "draft an update" with `ad_hoc` template, drafts inbox.
2. UpdatePlan + cadence runner with `weekly_status` template.
3. Source attribution panel + `investor_update` template.
4. Event-triggered drafts (`customer_release_note`, `incident_followup`).
5. Diff-vs-previous, send integrations (gated behind explicit user opt-in).
