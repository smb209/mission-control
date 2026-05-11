---
adr-number: 6
status: accepted
date: 2026-05-11
deciders: smb209
related-specs:
  - docs/reference/audit-pipeline.md — §5 narrow vs subtree
related-adrs: []
code-anchors:
  - src/app/api/initiatives/[id]/investigate/route.ts:190
---

# ADR-006: Subtree audit is a hard cutover; `mode='subtree'` is rejected with 400

## Context

The audit-pipeline originally exposed three modes on
`POST /api/initiatives/:id/investigate`: `narrow`, `subtree`, and
`subtree-proposal`. The two subtree variants overlapped — `subtree`
ran the fan-out immediately, `subtree-proposal` produced a plan the
operator confirmed before fan-out. Callers were confused about which
to use, and the legacy `subtree` path bypassed the operator-confirm
gate that the proposal flow added.

After `subtree-proposal` had been stable for a release cycle, the
team decided to fully retire the legacy mode rather than keep both
working in parallel.

## Decision

`POST /api/initiatives/:id/investigate` accepts only
`mode: 'narrow' | 'subtree-proposal'`. Requests with
`mode: 'subtree'` are rejected with HTTP 400 and an error string
pointing callers at `docs/archive/subtree-audit-proposals-spec.md`
§6.3. Narrow's "single-answer" semantics are now reached separately
via the `audit_verdict` bridge, not via a `mode` parameter.

## Consequences

- Positive: one less mode to reason about; the operator-confirm gate
  is on the only subtree path.
- Positive: the 400 error is loud, making lingering callers fail fast
  rather than silently routing to an obsolete codepath.
- Negative: any old script or saved curl hitting `mode=subtree` is
  broken (intentionally — that's the point of "hard cutover").
- Things to watch: if a new caller wants the old "immediate subtree
  fan-out without operator confirmation" semantics, that's a real
  product decision, not a missing parameter; revisit the audit
  pipeline design rather than reintroducing the mode.

## Code anchors

1. `src/app/api/initiatives/[id]/investigate/route.ts:190` — the
   explicit `mode === 'subtree'` rejection.
