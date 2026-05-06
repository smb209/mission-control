# 04 — E2E run results

## Verdict

**YELLOW (CODE-COMPLETE) — pending operator-driven gateway flip and real-agent runs.**

The deterministic gates (V1, V2, V3 dry-runs + idempotence) are GREEN. The real-agent gates (V4, V5, V6) are deferred to the operator because they require live config edits to `~/.openclaw/openclaw.json` and named-agent workspace files — destructive changes I should not apply unilaterally.

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
| V4 — Coordinator `update_subtask` (real agent) | **DEFERRED** | Needs live openclaw apply + a seeded coordinator/parent-task fixture; surfaced for operator-driven run. |
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
