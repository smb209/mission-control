---
status: aspirational
built: false
last-verified: 2026-05-11
audience: ai-subagents-primary, operator-secondary
related-specs:
  - docs/reference/pm-chat-prompt.md — the prompt contract; renders alongside the rows this spec describes
code-anchors:
  - src/app/(app)/pm/page.tsx
  - src/components/pm/triggerBadge.ts
  - src/lib/agents/pm-dispatch.ts
  - src/app/api/pm/proposals/route.ts
  - src/app/api/pm/plan-initiative/route.ts
  - src/app/api/pm/decompose-initiative/route.ts
  - src/app/api/pm/decompose-story/route.ts
  - src/app/api/pm/proposals/[id]/accept/route.ts
  - src/app/api/pm/proposals/[id]/refine/route.ts
  - src/lib/agents/pm-standup.ts
  - src/lib/mcp/groups/core.ts
  - src/lib/mcp/groups/pm.ts
---

# PM chat context strip + bi-directional links

> **Status: aspirational.** Spec for the next change. Not yet implemented.

## Problem

When `/pm` renders a chat post triggered by an audit, the operator sees a wall of prose ("Please review the following audit note from initiative …") with no immediate signal of:

1. **What kind of action this is.** Trigger-kind badges (`notes-intake`, `plan`, `decompose`, etc.) already exist in [src/components/pm/triggerBadge.ts](src/components/pm/triggerBadge.ts) but render only inside the embedded proposal card — not on the chat row itself. Trigger messages without an embedded proposal (user-side ask-PM posts, mid-flight status posts, accept-result echoes) have no badge at all.
2. **What initiative / note / audit run this is about.** The proposal carries `target_initiative_id`, `parent_proposal_id`, and a `trigger_text` that embeds note ids — none surfaced as clickable affordances on the chat row.
3. **How to navigate back to the source.** [agent_notes.pm_proposal_ids](src/lib/db/agent-notes.ts) already records which proposals each note triggered, but neither direction is exposed in the UI.

Today's `agent_chat_messages.metadata` JSON only carries `{ proposal_id }`, and the render in [src/app/(app)/pm/page.tsx](src/app/(app)/pm/page.tsx) parses no further than that.

## Scope

This spec covers **#1 (context strip on each chat row)** and **#2 (bi-directional cross-links to initiatives and notes)** from the design discussion. Threading (#3) and the side-drawer (#4) are explicitly out of scope; they're additive on top of this and gated on observed need.

## Proposal

### A. Widen the chat-message metadata convention

`agent_chat_messages.metadata` is already a free-form JSON column — no schema migration needed. The convention becomes:

```ts
interface PmChatMetadata {
  proposal_id?: string;             // pre-existing
  trigger_kind?: PmProposalTriggerKind;
  target_initiative_id?: string | null;
  source_note_ids?: string[];       // audit notes that produced this message
  audit_run_group_id?: string | null;  // populated when triggered by an audit run
  parent_proposal_id?: string | null;
  origin?:
    | 'pm_dispatch'                 // agent-driven via dispatchPm/dispatchPmSynthesized
    | 'ask_pm_from_notes'           // operator handed PM a note set
    | 'standup'                     // recurring standup post
    | 'accept_result'               // post-acceptance summary
    | 'system';                     // internal status (e.g. dispatch errors)
}
```

Every `postPmChatMessage` call site already has these values in scope. Threading them through is mechanical.

### B. Call-site updates

Extend the [`PostPmChatMessage`](src/lib/agents/pm-dispatch.ts) interface to accept the additional fields and write them into `metadata`. Each call site below gets the relevant fields populated:

| File | Origin | Fields added |
|---|---|---|
| [src/lib/agents/pm-dispatch.ts](src/lib/agents/pm-dispatch.ts) (×6) | `pm_dispatch` | trigger_kind, target_initiative_id, parent_proposal_id |
| [src/lib/mcp/groups/pm.ts](src/lib/mcp/groups/pm.ts) (×1, the retroactive re-echo) | `pm_dispatch` | trigger_kind, target_initiative_id |
| [src/lib/mcp/groups/core.ts](src/lib/mcp/groups/core.ts) (×1, ask-pm-from-notes) | `ask_pm_from_notes` | trigger_kind=`notes_intake`, target_initiative_id, source_note_ids, audit_run_group_id |
| [src/app/api/pm/plan-initiative/route.ts](src/app/api/pm/plan-initiative/route.ts) (×2) | `pm_dispatch` | trigger_kind=`plan_initiative`, target_initiative_id |
| [src/app/api/pm/decompose-initiative/route.ts](src/app/api/pm/decompose-initiative/route.ts) (×2) | `pm_dispatch` | trigger_kind=`decompose_initiative`, target_initiative_id |
| [src/app/api/pm/decompose-story/route.ts](src/app/api/pm/decompose-story/route.ts) (×2) | `pm_dispatch` | trigger_kind=`decompose_story`, target_initiative_id |
| [src/app/api/pm/proposals/[id]/accept/route.ts](src/app/api/pm/proposals/[id]/accept/route.ts) (×2) | `accept_result` | trigger_kind, target_initiative_id, parent_proposal_id |
| [src/app/api/pm/proposals/[id]/refine/route.ts](src/app/api/pm/proposals/[id]/refine/route.ts) | `pm_dispatch` | trigger_kind, target_initiative_id, parent_proposal_id |
| [src/lib/agents/pm-standup.ts](src/lib/agents/pm-standup.ts) | `standup` | trigger_kind |

For audit-triggered notes_intake messages, `source_note_ids` comes from the `note_ids` body of the `/api/initiatives/[id]/ask-pm-from-notes` POST, and `audit_run_group_id` is looked up by joining `agent_notes` (each note carries `run_group_id`).

### C. Render: per-row context strip in `/pm`

Above each chat message in [src/app/(app)/pm/page.tsx](src/app/(app)/pm/page.tsx), render a one-line strip with:

```
[badge: notes-intake]  Initiative: Scrub stale localhost:4000…  ·  Note 1c368e63  ·  Audit run 7d4f…  ·  View proposal →
```

Components:

- **Trigger badge** — reuse `triggerBadgeFor(metadata.trigger_kind)`. Appears on both `user` and `assistant` rows of an audit-triggered exchange so the operator can scan trigger kind without reading the body.
- **Initiative chip** — clickable, navigates to `/initiatives/<id>`. Title resolved from a small in-page cache keyed by id (already fetched by the page for proposal cards).
- **Note chips** — one per `source_note_ids` entry, label is the note id's 8-char prefix, hover shows the note kind + importance, click opens the initiative page anchored to that note.
- **Audit run chip** — appears when `audit_run_group_id` is set, click navigates to a TODO `?run_group=<id>` filter on the relevant page (no-op for v1 if the filter doesn't exist yet — the chip still renders informationally).
- **"View proposal →"** — present when `metadata.proposal_id` is set; navigates to `/pm/proposals/<id>` (replaces today's implicit linking via the embedded proposal card).
- **"Refined from →"** — present when `parent_proposal_id` is set; chip navigates to the parent proposal page.

Chips are small, muted (border + low-alpha bg), and wrap on narrow viewports.

### D. Graceful fallback for old rows

Existing rows have `metadata = {"proposal_id": "..."}` only. The renderer derives the missing fields on read by reading the linked proposal (already fetched by `/pm`). When no `proposal_id` is present and metadata is empty (oldest rows), the row renders without the strip — never worse than today.

No backfill migration. The fallback is sufficient; backfill adds risk for marginal benefit since `/pm` already fetches the proposal list.

### E. Bi-directional: initiative-page "Recent PM activity" rail

On the initiative detail page, add a "Recent PM activity" section below the existing Activity rail. Query: the last N chat messages whose `metadata.target_initiative_id = <this id>` OR whose `metadata.source_note_ids` contains a note id belonging to this initiative.

Each row renders a compact preview (truncated `content`, trigger badge, timestamp) and clicks through to `/pm?focus=<message_id>` — the chat surface scrolls the targeted message into view and pulses a highlight.

`/pm` honors `?focus=<id>` with `scrollIntoView({ block: 'center' })` + a 2s ring animation. No new state needed beyond a `useEffect` on mount.

New endpoint: `GET /api/initiatives/[id]/pm-chat?limit=10`. Returns the matching rows with their already-enriched metadata.

## Out of scope

- **#3 Conversation threading.** Group same-`audit_run_group_id` rows into a collapsible thread card. Defer; not justified until audit-day volume warrants.
- **#4 Context drawer.** A side panel that opens from any chat row with full note bodies / audit verdict markdown / prior proposals on this initiative. Defer; the strip + cross-links cover the common ask.
- **Backfill of historical rows.** The graceful-fallback path is sufficient.

## Test plan

DB layer:
- `postPmChatMessage` writes the widened metadata shape; round-trip parse.
- `GET /api/initiatives/[id]/pm-chat` returns chats whose metadata targets that initiative AND chats whose `source_note_ids` points to a note belonging to that initiative.

UI:
- Chat row renders the trigger badge for every supported `trigger_kind`.
- Initiative chip click navigates to `/initiatives/<id>`.
- Note chip click navigates to the initiative anchored to that note id.
- "View proposal →" navigates to `/pm/proposals/<id>` for any row with a `proposal_id`.
- A row with empty metadata (legacy) renders without the strip and without error.
- `/pm?focus=<message_id>` scrolls and highlights the targeted row.

Verification: preview smoke against the dev DB, which already has audit-triggered notes_intake exchanges (e.g. `c12ab760` ↔ `e0e46c09` from the orphan-adopt verification) — the strip should render an initiative chip + note chip + audit-run chip on the trigger row.

## Migration order

1. Land the widened metadata convention + call-site updates + chat-row strip + graceful fallback. Single PR, behind no flag — the convention is additive.
2. Land the initiative-page "Recent PM activity" rail + `?focus=` deep link. Second PR.

PR 1 is the foundation; PR 2 closes the bi-directional loop. Threading and the drawer remain proposals.
