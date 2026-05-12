---
adr-number: 4
status: accepted
date: 2026-05-11
deciders: smb209
related-specs:
  - docs/reference/workspace-conventions-structured.md — §6 spec body
related-adrs:
  - 3 — diverges from the proposal-substrate pattern used by PM dispatch
code-anchors:
  - src/lib/workspace-conventions/refine.ts:192
  - src/app/api/workspaces/[id]/refine-conventions/route.ts
---

# ADR-004: Workspace `refine` returns the proposal inline; persistence uses existing settings PATCH

## Context

`docs/reference/workspace-conventions-structured.md` originally proposed a new
`workspace_conventions_proposals` table mirroring `pm_proposals` —
draft / accept / revert lifecycle, SSE events, the whole substrate.
The intent was symmetry with PM dispatch (see ADR-003).

In implementation, workspace conventions had exactly one use of the
proposal substrate (the refine round-trip) and no need for an
asynchronous accept-later workflow. The user accepts or discards the
refined conventions immediately in the same dialog.

## Decision

We return the refined proposal **inline** from
`refineConventions()` as a plain `{ proposal }` object. The route
handler responds synchronously; no new DB table is created. When the
user accepts, persistence flows through the existing `PATCH
/api/workspaces/[id]/settings` endpoint exactly as a manual edit
would. The spec was rewritten in wave 1 to match.

## Consequences

- Positive: zero new schema, zero new accept/revert plumbing, zero
  new SSE event types for a one-shot use case.
- Positive: the refined proposal benefits from settings-PATCH's
  existing validation and audit trail "for free".
- Negative: this diverges from ADR-003's async pattern — anyone adding
  a *second* refine-style flow should re-evaluate whether the proposal
  substrate is warranted.
- Things to watch: if refine grows asynchronous (e.g. long-running
  LLM critique with progress streaming), revisit and supersede this
  ADR.

## Code anchors

1. `src/lib/workspace-conventions/refine.ts:192` — `refineConventions`
   returns `{ proposal }` inline.
2. `src/app/api/workspaces/[id]/refine-conventions/route.ts` — the
   route is a thin wrapper around `refineConventions()`.
