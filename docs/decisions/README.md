# Architectural Decision Records

This directory captures **non-obvious decisions** — the kind where the
*why* can't be reconstructed by reading the code alone. ADRs are short,
dated, and **immutable once accepted**.

## When to write one

Write an ADR when you've just made (or surfaced) a decision whose
rationale a future subagent would not be able to recover from `git
blame` plus the code. Typical triggers:

- A spec consolidation where you had to choose between two paths.
- A "we deliberated between A and B, picked B because Z" moment.
- A hard cutover or removal that contradicts older docs still floating
  around.

Don't ADR routine code or obvious refactors. The bar is *non-obvious
decision*, not *change of any kind*.

## File layout

- Filename: `NNN-short-slug.md` — `NNN` is zero-padded, monotonic,
  never reused. `slug` is kebab-case.
- Frontmatter mirrors `docs/reference/`: `adr-number`, `status`, `date`,
  `deciders`, `related-specs`, `related-adrs`, `code-anchors`.
- Body sections: **Context** / **Decision** / **Consequences** /
  **Code anchors**. Target 80–160 lines.

## Status values

- `proposed` — drafted but not yet committed to.
- `accepted` — current law. **Never edit an accepted ADR.** To change
  the decision, write a new ADR that supersedes it.
- `superseded` — historical. Set `superseded-by: NNN` in the
  frontmatter and leave the body intact for context.

## Current index

| # | Title | Status |
|---|---|---|
| 1 | Migrations are append-only after recording | accepted |
| 2 | `spawn_subtask` replaces `delegate`; multiple convoys per parent | accepted |
| 3 | PM dispatch is async; placeholder + reconciler | accepted |
| 4 | Workspace refine returns inline; persistence via settings PATCH | accepted |
| 5 | `take_note` is the only tool that hard-blocks cancelled-run writes | accepted |
| 6 | Subtree audit is a hard cutover; `mode='subtree'` returns 400 | accepted |
| 7 | PmDiff state lives in `proposed_changes` JSON, not a separate table | accepted |
| 8 | `agent_runs` is the general dispatch envelope; briefs opt out | accepted |

## Related

- `docs/README.md` — the audit that surfaced most of these decisions.
- `yarn docs:check` — validates frontmatter on `docs/reference/`,
  `docs/proposals/`, and `docs/decisions/`; ADRs additionally must
  have an integer `adr-number` that matches the `NNN-` filename prefix.
