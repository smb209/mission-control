# Dedupe redundant initiative investigations

## Why

Operator clicked "Audit" on an initiative twice in 24 seconds (at 23:30:13
and 23:30:37 on May 7 2026). The first dispatch was cancelled; the second
ran to completion. Both ended up writing observation notes (`agent_notes`
ids `43b6502f…` and `fe345c99…`) — same audit, slightly different prose,
~50 seconds apart. The operator had to read both to confirm they were
redundant.

Three failure modes are tangled here:

1. **Cancelled runs still persist tool writes** — the openclaw worker is
   not killed when `agent_runs.status` flips to `cancelled` (gateway abort
   is best-effort; the worker keeps executing tools until it polls
   heartbeat or hits timeout). So a cancelled run can still call
   `take_note`, `register_deliverable`, `log_activity`, etc.

2. **No dispatch-time guard** — `POST /api/initiatives/:id/investigate`
   doesn't check whether an `initiative_audit` is already
   `queued`/`running` for this initiative.

3. **No throttle on back-to-back complete audits** — even with #1+#2
   fixed, an operator can re-audit 30s after a clean completion without
   any UI hint that the previous one already finished.

This spec ships #1 first as a standalone change. #2 and #3 follow as
separate PRs that build on the run-group-id linkage added here.

## Scope of this PR (#1 only)

**Goal**: A cancelled `agent_run` cannot persist `agent_notes`. If a
worker calls `take_note` after its run was cancelled, the call is
rejected and the row is not written.

Out of scope (follow-ups):
- Same gating on `register_deliverable`, `log_activity`, etc. (mentioned
  in §Future, not built here).
- Dispatch-time guard against concurrent audits (#2).
- UI cooldown / "audited 2 min ago" hint (#3).

## Design

### Linking notes back to their run

Today `agent_notes` carries `run_group_id` (UUID minted in
`dispatch-scope.ts` at dispatch time, baked into the briefing, passed
back by the agent on every `take_note`). But `agent_runs` does **not**
store `run_group_id` — there's no way to look up a run from a
`run_group_id`.

Match on `scope_key` alone won't work: scope_key is reused across runs,
and in the redundant-audit case the *most recent* run for that scope_key
is the new (complete) run, not the cancelled one whose worker is the
actual caller.

**Fix**: persist `run_group_id` on `agent_runs` so it can be the join
key.

### Migration 085

Add `run_group_id TEXT` to `agent_runs`, plus an index. Backfill is
unnecessary — older runs won't be checked (their workers are long dead).
Column is nullable so legacy rows continue to load.

```sql
ALTER TABLE agent_runs ADD COLUMN run_group_id TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_runs_run_group
  ON agent_runs(run_group_id) WHERE run_group_id IS NOT NULL;
```

### Code changes

1. `src/lib/db/agent-runs.ts`
   - `StartAgentRunInput.run_group_id?: string` (optional for backwards
     compat / brief-dispatch which manages its own row).
   - INSERT writes the column.
   - New `getRunByGroupId(run_group_id: string): AgentRun | null` —
     returns the single row matching this run_group_id, or null.

2. `src/lib/agents/dispatch-scope.ts`
   - Pass `run_group_id` into the `startAgentRun` call (currently does
     not).

3. `src/lib/mcp/groups/core.ts` — `take_note` handler
   - Before calling `createNote`, look up the run via
     `getRunByGroupId(args.run_group_id)`.
   - If found AND `status === 'cancelled'`: return a structured MCP
     error (`{ error: 'run_cancelled', message: '…' }`) with `isError:
     true`. Do **not** insert.
   - If not found (legacy run, no run_group_id, or fresh insert race):
     proceed — fail open. Logging this case as a warning is fine but not
     required; we don't want to block legitimate writes if the lookup
     misses.
   - If status is anything else (`queued`, `running`, `complete`,
     `failed`): proceed. We only block `cancelled`, not `complete` —
     a worker writing to a `complete` run is a different bug (the run
     finalize raced ahead) and we'd rather have the data.

### Failure modes considered

- **Race: worker calls `take_note` between `cancelAgentRun` flipping
  status and the abort signal landing.** Handled — the status flip is
  the canonical source of truth. The check sees `cancelled` and refuses.

- **Legacy runs with no `run_group_id`.** Handled — `getRunByGroupId`
  returns null, take_note falls through. These are old runs whose
  workers are no longer alive anyway.

- **Brief dispatch path (`skip_run_row: true`).** No `agent_runs` row
  exists at all. Lookup returns null, take_note proceeds. Brief
  dispatches don't have a cancellation pathway today.

- **Multiple agent_runs sharing a run_group_id.** Shouldn't happen —
  run_group_id is a per-dispatch UUID. If it does, `getRunByGroupId`
  can `LIMIT 1 ORDER BY created_at DESC` defensively.

## Test plan

Unit tests in `src/lib/db/agent-runs.test.ts`:
- `startAgentRun` persists `run_group_id` when provided.
- `getRunByGroupId` returns the row.
- `getRunByGroupId` returns null for unknown id.

Unit/integration test for take_note guard
(`src/lib/mcp/groups/core.test.ts` or new file):
- Dispatch a run with `run_group_id=X`, mark it `cancelled` via
  `cancelAgentRun`, call `take_note` with `run_group_id=X` → MCP returns
  `isError: true`, no row in `agent_notes`.
- Same setup but status stays `running` → take_note succeeds, row
  inserted.
- `take_note` with unknown `run_group_id` → succeeds (fail-open).

Manual verify:
- Dispatch an `initiative_audit`, immediately cancel it via the /jobs UI
  before the worker finishes, watch the worker log a 4xx-style error on
  `take_note` instead of writing the orphan note. Inspect `agent_notes`
  to confirm no row.

## Future (not this PR)

- **#2 Dispatch-time guard**: in
  `POST /api/initiatives/:id/investigate`, check
  `agent_runs WHERE initiative_id=? AND kind='initiative_audit' AND
  status IN ('queued','running')`. If found, refuse with 409 + a
  message that the operator can re-issue with `?supersede=1` to
  cancel-and-redispatch atomically.

- **#3 UI cooldown**: client-side check on the audit button — if the
  most recent complete `initiative_audit` for this initiative is < 5 min
  old, render "Last audited 2 min ago — re-audit?" with a confirm.

- **Generalize the cancelled-run guard** to `register_deliverable`,
  `log_activity`, `propose_changes`. Same lookup, same refuse path.
  Probably a small `assertRunNotCancelled(run_group_id)` helper
  imported into each tool.
