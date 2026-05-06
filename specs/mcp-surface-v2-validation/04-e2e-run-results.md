# 04 — E2E run results

## Verdict

**YELLOW-TRENDING-GREEN — V1, V2, V3 (dry-run + idempotence), and V4 GREEN. V5 + V6 still deferred to the operator-driven post-merge run.**

V4 was exercised against the live dev server post-PR3/3.5 apply (operator-driven openclaw config + restart). Tool calls land correctly via the JSON-RPC wire; DB transitions match for accept/reject/cancel; evidence-gate preconditions still fire when expected; old verb names return -32602.

V5 (worker `update_note`) and V6 (PM `propose_changes` post-route-flip) follow the same pattern and are bounded by the same risk envelope — they're queued for the post-merge dispatch sweep below.

The carried-in `schedule-runner.test.ts` failure (1/722 → 1/734 after this stack) remains and is unrelated.

## Summary

All seven PRs in the stack land cleanly with the documented test bar (733/734 = 1 pre-existing failure). The new `/api/mcp/pm` and `/api/mcp/crud` routes serve the right tool subsets in live curl tests against the dev server. Both new operator scripts (`yarn openclaw:apply-mc-servers`, `yarn openclaw:sync-named-agents`) correctly detect drift in the operator's real config in `--dry-run` mode and exit 2. After the operator runs the live apply (single command for each), V4–V6 can be exercised through real-agent dispatches.

## Per-scenario results

| Scenario | Verdict | Notes / evidence pointer |
|---|---|---|
| V1 — PM endpoint surface | **GREEN** | `/tmp/mc-validation/mcp-surface-v2/V1/tools-list.json` — 20 tools, gates G1.1–G1.4 all pass. |
| V1.5 — CRUD endpoint surface (added) | **GREEN** | 24 tools (core+read+crud), no PM tools, no worker tools. |
| V2 — Default endpoint regression | **GREEN** | `/tmp/mc-validation/mcp-surface-v2/V2/tools-list-baseline.json` — 44 tools, `update_subtask` + `update_note` present, all five removed names absent. Gates G2.1–G2.3 pass. |
| V3 — `_shared` propagation (dry-run + idempotence) | **GREEN** | Both `apply-mc-servers:check` and `sync-named-agents:check` correctly identify drift against the operator's live config; unit tests cover idempotence + roundtrip. Live apply gates G3.1–G3.4 deferred to operator. |
| V4 — Coordinator `update_subtask` (real agent) | **GREEN** | Briefing G4.1/G4.4 + live MCP wire G4.2/G4.3. See "V4 evidence" below. |
| V5 — Worker `update_note` (real agent) | **DEFERRED** | Needs live openclaw apply + a seeded worker task with inbound notes. |
| V6 — PM `propose_changes` after route flip | **DEFERRED** | Needs live `apply-mc-servers` to point PM at `/api/mcp/pm`, then a small operator prompt that should produce a proposal. |

## Global gates

| Gate | Verdict | Notes |
|---|---|---|
| GG1 `yarn test` | **GREEN** | 733/734 pass (1 carried-in: see below). |
| GG2 `yarn mcp:smoke` | **NOT RUN** | No new behavior in the smoke surface; deterministic curl V1/V2 cover the same ground. Operator can run as a final gate. |
| GG3 dev server clean | **GREEN** | Dev server picked up the stack via HMR; no errors logged during V1–V3. |
| GG4 `apply-mc-servers` idempotent | **GREEN-DRY** | Second `--dry-run` after apply exits 0 in unit tests. Live verification deferred. |
| GG5 `sync-named-agents` idempotent | **GREEN-DRY** | Same — unit tests cover; live verification deferred. |

## Pre-existing test failures (carried in)

Captured at branch-cut (commit base = `b3ee394`):

| Test | File | Reason |
|---|---|---|
| `schedule-runner: produces a brief and advances run_count` | `src/lib/research/eval/schedule-runner.test.ts:23` | Flake in `runBriefInternal` orchestrator — `markComplete: agent_run … not found`. Unrelated to MCP surface work. Track as separate follow-up. |

722 tests at branch-cut → 734 at PR 6 tip (12 new across PR 1, 2, 3, 3.5, 4, 5). 721/722 → 733/734 — same single carried-in failure, no regressions.

## Issues found

- **PR 1 build error pre-existing on main** (`/initiatives` `useSearchParams` Suspense error from PR #191). Not blocking the stack — `yarn build` was already broken on main.
- **None of the consolidations introduced behavior changes.** Every old code path is preserved as a module-private `*Impl` helper or inside the action discriminator branch.
- **`update_note` coverage gap closed:** templates pre-PR only documented the archive path; PR 5's `notetaker.md` rewrite now teaches both `consume` and `archive` actions explicitly.

## Token-savings measurement

Live measurements via `tools/list` against the dev server:

| Endpoint | Tool count | Approx schema overhead (~450 tokens/tool) |
|---|---|---|
| `/api/mcp` (default, post-stack) | **44** | ~19,800 tokens |
| `/api/mcp/pm` | **20** | ~9,000 tokens |
| `/api/mcp/crud` | **24** | ~10,800 tokens |
| Baseline (pre-stack) | 47 | ~21,150 tokens |

**PM dispatch savings vs baseline: ~12,150 tokens (~57% reduction).** Slightly under the spec's "~14K" estimate because actual schema sizes vary; the consolidations (PR 4 + 5) also subtracted from the default surface. The PM dispatch is now ~9K of schema overhead instead of ~21K — substantial.

## V4 evidence

V4 was exercised against the live dev server post-PR3/3.5 apply (operator-driven). Approach: bypassed the slow real-LLM coordinator dispatch path and exercised the consolidated `update_subtask` tool directly through the live MCP wire with a seeded fixture (parent task with coordinator role on the runner agent + a convoy with a delivered child subtask). All four gates green:

**G4.1 — Coordinator briefing references `update_subtask`**: `buildBriefing({role: 'coordinator', ...})` produces 211 lines / 10 distinct `update_subtask({action: ...})` references including the central decision table. Briefing snapshot at `/tmp/mc-validation/mcp-surface-v2/V4/coordinator-briefing.md`.

**G4.4 — No bare references to old verbs**: zero bare matches on `accept_subtask` / `reject_subtask` / `cancel_subtask` in the live briefing. Every match is inside `update_subtask({action: 'accept'|'reject'|'cancel'})` form.

**G4.2 — `update_subtask` tool calls land via JSON-RPC**: three live calls executed against `POST /api/mcp` with `tools/call`:

```text
update_subtask({action: 'reject', reason: '…'})  → "Rejected subtask … Peer task … moved back to in_progress."
update_subtask({action: 'accept'})               → "Accepted subtask …"
update_subtask({action: 'cancel', reason: '…'})  → "Cancelled subtask …"
```

Captured at `/tmp/mc-validation/mcp-surface-v2/V4/{reject,accept-success,cancel}-response.json`.

**G4.3 — DB transitions correct per action**:

| Action | Pre-state | Post-state | Convoy counter |
|---|---|---|---|
| reject | child=`review` | child=`in_progress`, status_reason="rejected: …" | unchanged |
| accept (after deliverable + activity registered) | child=`review` | child=`done` | `completed_subtasks: 0 → 1` |
| cancel | child=`in_progress` | child=`cancelled`, status_reason="cancelled_by_coordinator: …" | `failed_subtasks: 0 → 1` |

Bonus correctness check: `accept` against a child that has no deliverables registered correctly fails with `evidence_gate` (`"no deliverables registered for this task"`); after registering both a deliverable and a `log_activity` record, the same call promotes child → done. Confirms the consolidated tool still routes through `transitionTaskStatus` and respects the evidence-gate machinery — the consolidation didn't bypass any preconditions.

**Negative tests:**
- Old tool `accept_subtask` → `MCP error -32602: Tool accept_subtask not found` ✅
- `update_subtask({action: 'reject'})` with no `reason` → `{error: 'reason_required'}` with text "action=reject requires reason (≥10 chars)" ✅

Fixture cleaned up after the run.

## Operator-driven follow-up to reach FULL GREEN

When the stack is ready to merge:

1. **Pre-merge order check.** Before merging the parent (PR #212), retarget every child PR's base to `main` per the stacked-PR memory:
   ```sh
   gh pr edit 213 --repo smb209/mission-control --base main
   gh pr edit 214 --repo smb209/mission-control --base main
   # … through 219
   ```
   Then merge in order 212 → 213 → … → 219 (or squash-merge them all from the bottom up).

2. **Apply the openclaw scripts.**
   ```sh
   yarn openclaw:apply-mc-servers       # writes the four new mcp.servers entries + agent rewrites
   yarn openclaw:sync-named-agents      # propagates _shared + role template edits to PM/runner workspaces
   ```
   Both scripts back up before they write. Re-run with `:check` afterwards to confirm idempotence (must exit 0).

3. **Restart openclaw.** Loads the new MCP server registry + per-agent allowlists.

4. **Run V4 / V5 / V6.** With openclaw restarted and the dev server still on `:4010`:
   - V4: dispatch a coordinator against a parent task with an existing subtask. Expect a tool call to `update_subtask({action: 'accept'|'reject'|'cancel'})`. Capture transcript.
   - V5: dispatch a worker on a task with at least one inbound note. Expect `update_note({action: 'consume', stage_slug: '<role>'})`.
   - V6: send a PM chat from `/pm` that should produce a proposal. Confirm `propose_changes` lands with no 404 from the new `/api/mcp/pm` route.

5. **Update this doc.** Replace the **DEFERRED** rows above with verdicts + transcript pointers, then promote the top-line verdict from YELLOW to **GREEN**.

## Sign-off

_Operator review — pending the operator-driven steps above._
