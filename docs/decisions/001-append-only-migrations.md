---
adr-number: 1
status: accepted
date: 2026-05-11
deciders: smb209
related-specs:
  - specs/long-unattended-feature-dev.md — references migration discipline
related-adrs: []
code-anchors:
  - src/lib/db/migrations.ts
---

# ADR-001: Migrations are append-only after recording

## Context

The migration runner records each migration's id in `schema_migrations`
(or equivalent) the moment its `up()` returns. On subsequent boots, the
runner silently skips any id already present.

If we amend an applied migration's `up()` body — adding a column, fixing
a typo, tightening a constraint — the change runs on no environment that
has already recorded the id. The local dev DB drifts from CI, from
prod, and from other developers' DBs without any error surfacing. The
bug only manifests later when a query references the missing column.

This has bitten us once already; the global CLAUDE.md "Database
Migrations" section documents the rule.

## Decision

We treat migrations as **immutable once recorded**. To change schema
that an applied migration produced, write a new migration with the next
sequential number. Every migration must also be idempotent at the
column / index level (`IF NOT EXISTS`, `PRAGMA table_info` guards) so
re-runs and partially-applied DBs skip cleanly rather than erroring.

## Consequences

- Positive: dev/CI/prod schemas converge deterministically; a passing
  local migration run guarantees the same schema everywhere.
- Positive: rollback is by forward fix, not by retro-editing — the
  history reads as a true append-only log.
- Negative: trivial column-add typos become two migrations instead of
  one edit; migration count grows monotonically.
- Things to watch: tooling that "rebuilds" the DB from scratch (test
  setup, `db:reset`) can mask drift by replaying every migration.
  Trust the recorded-id check, not the from-scratch path.

## Code anchors

1. `src/lib/db/migrations.ts` — runner + every migration (`IF NOT
   EXISTS` and `PRAGMA table_info` patterns appear ~300 times).
