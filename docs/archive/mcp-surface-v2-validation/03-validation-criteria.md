# 03 — Validation criteria

Pass requires every gate in a scenario AND-ed; final verdict requires all scenarios + global gates.

## Per-scenario gates

### V1 — PM endpoint surface
- G1.1 `tools/list` returns ≤ 20 tools.
- G1.2 None of: `register_deliverable`, `submit_evidence`, `update_task_status`, `fail_task`, `spawn_subtask`, `update_subtask`, `register_subagent_dispatch`.
- G1.3 All of: `propose_changes`, `propose_from_notes`, `refine_proposal`, `preview_derivation`, `add_owner_availability`.
- G1.4 All of: `whoami`, `list_peers`, `get_workspace_context`.

### V2 — Default endpoint regression
- G2.1 `tools/list` count = 44 (after full stack lands).
- G2.2 `update_subtask` and `update_note` present.
- G2.3 `accept_subtask`, `reject_subtask`, `cancel_subtask`, `mark_note_consumed`, `archive_note` absent.

### V3 — `_shared` propagation
- G3.1 Marker appears in `mc-pm-default-dev/AGENTS.md` after sync.
- G3.2 Marker appears in `mc-runner-dev/AGENTS.md` after sync.
- G3.3 Second `--dry-run` is empty (idempotent).
- G3.4 Reverting the `_shared` edit + re-syncing removes the marker (round-trip).
- G3.5 No file outside the named-agent workspace dirs is touched.

### V4 — Coordinator uses `update_subtask`
- G4.1 Coordinator briefing references `update_subtask` (grep transcript).
- G4.2 ≥ 1 `update_subtask` tool call in transcript.
- G4.3 Subtask status moved correctly per the action requested (accept/reject/cancel).
- G4.4 No reference to old verbs in briefing.

### V5 — Worker uses `update_note`
- G5.1 Worker briefing references `update_note`.
- G5.2 ≥ 1 `update_note` tool call in transcript.
- G5.3 Note row has `consumed_at` set or `archived_at` set as expected.
- G5.4 No reference to `mark_note_consumed` or `archive_note` in briefing.

### V6 — PM `propose_changes` flow
- G6.1 Tool call to `propose_changes` lands without 404/500.
- G6.2 New `proposals` row created with the expected `kind`.
- G6.3 Proposal card renders in PM chat UI.
- G6.4 No console errors / SSE errors during dispatch.

## Global gates

- GG1 `yarn test` passes (or only pre-existing failures listed in 04).
- GG2 `yarn mcp:smoke` passes.
- GG3 No unhandled errors in dev server log across the run.
- GG4 `yarn openclaw:apply-mc-servers --dry-run` is empty after the live apply step (idempotence).
- GG5 `yarn openclaw:sync-named-agents --dry-run` is empty after the live apply step (idempotence).

## FLAKE policy

V4 / V5 / V6 (real-agent) may flake on model output. Re-run up to 3×; pass if ≥ 2/3 pass with all gates.

## Verdict matrix

| Verdict | Condition |
|---|---|
| **GREEN** | All scenarios + all global gates pass. |
| **YELLOW** | All scenarios pass; 1 global gate is a pre-existing failure (must be enumerated). |
| **BLOCKED** | Pre-check fails or environment can't reach baseline. |
| **RED** | Any scenario gate fails after FLAKE retries, or any global gate fails for a non-pre-existing reason. |
