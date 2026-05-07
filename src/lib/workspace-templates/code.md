---
title: Code project
description: Repository-backed codebase with tests, PRs, and a build pipeline.
intended_for: software engineering / coding agents
---
## Repos

- Working tree: `{{working_dir}}`
- Repo: {{repo_url}}
- Default base branch: `{{base_branch}}`
- Always pass `--base {{base_branch}}` to `gh pr create`. If the repo is a fork, pass `--repo {{repo_url}}` explicitly so PRs don't auto-resolve to upstream.

## Source control

- Never push directly to `{{base_branch}}`.
- Never force-push to `{{base_branch}}`.
- Never skip commit hooks (`--no-verify`) unless the operator explicitly approves.
- New commits, not amends — if a pre-commit hook fails, fix and re-commit instead of `--amend`.

## Branch naming

When you pick a branch yourself (non-dispatched flow):

- `feat/<slug>` — new features
- `fix/<slug>` — bug fixes
- `docs/<slug>` — doc-only changes
- `perf/<slug>` — performance work

When MC dispatches a task you're already on the right branch (typically `task/<id>` or `autopilot/<slug>`). Don't rename it.

## Stacked PRs

Retarget child PRs to `{{base_branch}}` **before** merging the parent with `--delete-branch`. Otherwise GitHub auto-closes the children when the parent branch is deleted.

## Testing

Before declaring a change done, run the full suite once and inventory all failures up front. Don't iteratively add `--skip` flags to silence individual failures — that hides pre-existing breakage.

- _(replace with this project's test commands — e.g. `yarn test`, `pytest`, `go test ./...`)_

## Verification

Type-check + tests verify code correctness, not feature correctness. **Exercise the change against a running system before reporting it done.** If you can't actually exercise it, say so explicitly — don't substitute an irrelevant smoke test.

## Spec-first for non-trivial refactors

For multi-layer changes (DB migration + service + UI), follow audit → spec → implement → verify:

1. **Audit**: list current behavior and gaps.
2. **Spec**: short design doc citing specific files / lines.
3. **Implement**: commit per logical slice.
4. **Verify**: tests + smoke before opening the PR.

## Communication

- Keep updates tight: 1–3 sentences. Substance lives in the artifacts you produce, not in chat prose.
- End-of-turn summary: ≤ 2 sentences. What changed, what's next.
