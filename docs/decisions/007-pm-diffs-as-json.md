---
adr-number: 7
status: accepted
date: 2026-05-11
deciders: smb209
related-specs:
  - specs/pm-diff-conventions.md — canonical diff envelope reference
  - specs/pm-revertable-proposals.md — invert/revert flow
related-adrs:
  - 3 — proposal substrate this lives inside
code-anchors:
  - src/lib/db/pm-proposals.ts:1130
---

# ADR-007: PmDiff state lives in `proposed_changes` JSON, not a separate `pm_diffs` table

## Context

PM proposals carry a list of diffs (create_task, update_task,
create_child_initiative, etc.). An early prototype gave diffs their
own normalised table (`pm_diffs`) keyed back to `pm_proposals`. That
shape made some queries easier (e.g. "all create_task diffs across
proposals") but added schema, join overhead, and a second write path
on apply / revert.

The revert flow (see `specs/pm-revertable-proposals.md`) needs each
diff to capture its own pre-state at apply time (e.g. `prev_status`,
`created_dependency_id`) so `invertDiff` can synthesise a pure-
function revert from the row alone. With diffs in JSON, all that
capture state writes back as one `UPDATE pm_proposals SET
proposed_changes = ?`. With a separate table, it'd be N updates per
apply.

## Decision

PmDiff state is stored as a JSON array in
`pm_proposals.proposed_changes`. The apply path mutates each diff
in place to add capture state and writes the whole augmented array
back in a single statement. No `pm_diffs` table exists.

## Consequences

- Positive: apply / revert are single-row atomic; no multi-row
  transactional complexity.
- Positive: the diff schema can evolve freely — adding a new diff
  kind or a new capture field is a TypeScript change with no
  migration.
- Negative: cross-proposal diff queries ("show every `create_task`
  in the last week") require `json_each` or post-hoc filtering in
  code. Acceptable given how rarely that query is needed.
- Things to watch: if diffs grow unbounded (many KB per proposal) the
  JSON column becomes a hotspot. Current envelopes stay well under
  that threshold.

## Code anchors

1. `src/lib/db/pm-proposals.ts:1130` — the `UPDATE pm_proposals SET
   proposed_changes = ?` write-back on apply, with the explanatory
   comment.
