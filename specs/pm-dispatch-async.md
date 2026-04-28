# PM dispatch — async orchestration

## Why

Today's `dispatchPmSynthesized` is synchronous-with-timeout: it sends to the
named openclaw PM agent and waits up to `NAMED_AGENT_TIMEOUT_MS` (60s) for
the agent's `propose_changes` to land. If the agent takes longer (e.g. cold
session + complex `plan_initiative` prompt — observed in the wild at ~70s),
two bugs surface:

1. The 60s budget elapses, the deterministic `synthesizePlanInitiative`
   fallback fires, and the resulting low-quality proposal is what the
   operator sees.
2. The agent's high-quality `propose_changes` lands ~10s later, gets a fresh
   `pm_proposals` row, but is **orphaned** — no `target_initiative_id`,
   `trigger_kind = 'manual'`, and nothing supersedes the synth fallback. The
   UI never surfaces it.

This is a regression class the unit/e2e tests miss because they mock the
gateway client and the timing never realistically diverges.

## Tiers

### Tier 1 — per-kind timeout

`DispatchSynthesizedInput` gains an optional `timeoutMs?: number`.
`dispatchPmSynthesized` passes it through to `sendChatAndAwaitReply`, falling
back to `namedAgentTimeoutMs()` (60s) when omitted.

The two slow-prompt callers — `/api/pm/plan-initiative` and
`/api/pm/decompose-initiative` — pass `timeoutMs: 120_000`.

Risk: low. Disruption + refine paths keep their 60s default.

### Tier 2 — late-arrival reconciler

After the named-agent path either succeeds or times out, a background watcher
runs in the same dispatch promise's tail (default 120s past the original
timeout). When a NEW draft `pm_proposals` row appears in the same workspace,
keyed by the dispatch's `correlation_id` (matched via the agent's chat
session), the watcher:

1. Stamps the agent's row with `trigger_kind`, `target_initiative_id`, and
   `parent_proposal_id = synth_row.id`.
2. Marks the original synth row as `superseded`.
3. Broadcasts a new SSE event `pm_proposal_replaced` carrying
   `{ workspace_id, old_id, new_id }`.

The plan-initiative panel subscribes to that SSE event and reloads (or
navigates to the new id).

If no agent row arrives within the tail window, the watcher exits silently
and the synth row stays as the operator's draft (today's behavior, just less
likely).

### Tier 3 — async-by-default API contract

`/api/pm/plan-initiative` and `/api/pm/decompose-initiative` no longer await
the named-agent round trip. They:

1. Persist the synth proposal immediately as a placeholder draft.
2. Kick off the named-agent dispatch as a fire-and-forget background promise
   that uses Tier 2's reconciler.
3. Return the placeholder proposal in the POST response with
   `dispatch_state: 'pending_agent'`.

The plan-initiative panel renders the placeholder (synth content) right
away, shows a "PM agent is still working — content may update" indicator,
and listens for `pm_proposal_replaced` to swap content when the agent's
proposal lands. Accept is soft-disabled until either the agent completes or
the tail window elapses — operator opt-out via "Accept synth as-is".

## Files

- `src/lib/agents/pm-dispatch.ts` — plumbing for all three tiers
- `src/lib/types.ts` — extend `SSEEventType` with `pm_proposal_replaced` and
  `pm_proposal_dispatch_state_changed`
- `src/lib/db/pm-proposals.ts` — add `dispatch_state` column (`'pending_agent' | 'agent_complete' | 'synth_only'`)
  via migration 055; `createProposal` accepts it.
- `src/app/api/pm/plan-initiative/route.ts` and
  `src/app/api/pm/decompose-initiative/route.ts` — async path + Tier 1
  timeout opt-in.
- Plan-initiative panel UI — subscribe to `pm_proposal_replaced` and
  refetch.

## Tests

- `pm.test.ts`:
  - Tier 1: explicit `timeoutMs` is honored end-to-end (mock agent waits past
    60s; with `timeoutMs: 120_000` the named-agent path wins).
  - Tier 2: agent's `propose_changes` lands 10s after the named-agent
    timeout → reconciler stamps the new row, supersedes the synth row,
    broadcasts SSE.
  - Tier 3: API returns placeholder synth row immediately with
    `dispatch_state: 'pending_agent'`; agent row supersedes async.
- `pm-proposals.test.ts`: `dispatch_state` column round-trip.

## Out of scope

- Streaming the agent's chain-of-thought into the panel as it works (would
  be ideal UX but requires a separate SSE channel keyed on session_key).
- Auto-rejecting the synth row when superseded (operator may want to compare
  synth vs. agent diff manually).
