---
adr-number: 5
status: accepted
date: 2026-05-11
deciders: smb209
related-specs:
  - docs/proposals/audit-dedupe-followups.md — open backlog for generalising the guard
  - docs/reference/audit-pipeline.md — §10 documents the cancellation contract
related-adrs: []
code-anchors:
  - src/lib/mcp/groups/core.ts:421
  - src/lib/db/migrations.ts:4498
---

# ADR-005: `take_note` is the only tool that hard-blocks writes from a cancelled run

## Context

When an audit run is cancelled (operator click, supersession by a
fresher dispatch), the running agent's MCP session does not
immediately terminate. The agent can continue calling tools for
seconds-to-minutes until the worker actually exits. Those tail-end
writes — especially `take_note` — create orphan rows attributed to a
run that the UI shows as "cancelled", causing duplicate-audit and
ghost-note bugs (see the May-7 duplicate-audit incident referenced in
`docs/archive/dedupe-investigations.md`).

Migration 085 added `run_group_id` to `agent_runs` to make the
"which run owns this write?" lookup cheap.

## Decision

We added a hard guard to `take_note`: on entry, look up the owning run
via `run_group_id`; if its status is `cancelled`, refuse with
`error: 'run_cancelled'` and a structured message instructing the
agent to stop and exit. **No other tool currently enforces this.** The
narrow scope is intentional — `take_note` was the primary source of
orphan rows; expanding the guard to every write tool is open backlog
in `docs/proposals/audit-dedupe-followups.md`.

## Consequences

- Positive: orphan notes from cancelled runs are blocked at the
  write boundary, not cleaned up after the fact.
- Positive: the error envelope is structured (`run_cancelled`) so
  agents can recognise it and exit cleanly rather than retrying.
- Negative: tools other than `take_note` can still produce orphan
  side effects (task edits, proposal drafts, etc.). Generalising the
  guard is non-trivial because each tool has different "is this write
  meaningful to keep?" semantics.
- Things to watch: if a new write tool becomes a major source of
  orphan rows, add the same guard pattern there. Long term, the
  cleanest fix is to terminate the MCP session on cancellation, which
  would obviate the per-tool guards.

## Code anchors

1. `src/lib/mcp/groups/core.ts:421` — the guard inside the
   `take_note` handler.
2. `src/lib/db/migrations.ts:4498` — migration 085 adds
   `agent_runs.run_group_id` (the lookup column).
