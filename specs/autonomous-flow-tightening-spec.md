# Autonomous Flow Tightening

Status: draft
Owner: smb209
Date: 2026-04-29
Trigger: post-mortem of first fully-autonomous AlertDialog convoy run (PR #111). Three sessions reviewed: Builder (`61f914e…`), Reviewer (`c4844a9…`), Tester (`114ec91…`).

## Goal

Close the failure modes surfaced by the first autonomous run so the next convoy can complete without operator mid-flight fixes. Stage isolation worked at the gateway-session layer (#110); it bled through at workspace, roll-call, ACL, status_reason, and **verification** layers. The Tester is currently the only role producing real verification evidence — Builder and Reviewer can ship `TASK_COMPLETE` with zero runtime proof.

## Non-goals

- Re-architecting convoy. The convoy primitive is fine.
- Adding new roles. Builder / Tester / Reviewer / PM stay as-is.
- Changing OpenClaw worker semantics. Changes are MC-side except role-doc updates.

## Core principle: never ask an agent a yes/no question about its own work

Every gate is **"run this exact command, submit raw output."** The convoy hook parses the output and decides pass/fail. The agent is the transport, not the judge. A field like `typecheck: pass` is just another self-attestation — replace it with `typecheck.stdout: <raw>` + server-side parse.

## Failure modes (from post-mortem)

| FM | One-line | Ground truth |
|----|----------|--------------|
| FM1 | Verification gate is pure self-attestation | `src/lib/task-governance.ts:30` `checkStageEvidence` only counts deliverable/activity rows |
| FM2 | Workspace isolation skipped — Builder ran on `main` | `src/lib/workspace-isolation.ts` exists; dispatch path doesn't always invoke or doesn't enforce |
| FM3 | Roll-call id lost across stage-isolated session boundary | `src/lib/rollcall.ts:274` `recordRollCallReplyIfMatch` — pattern match only, not propagated |
| FM4 | `agent_not_coordinator` on first `get_task` for assigned agent | `src/lib/mcp/tools.ts:280-342` |
| FM5 | Stale `status_reason` survives forward transitions | `src/lib/services/task-status.ts:149-153` partial fix already (`/^failed:/i` only) |
| FM6 | `yarn test` stalls with no harness budget / fallback | `package.json:10` test script unbounded |
| FM7 | Path-scheme drift (`/app/...` vs host paths) in deliverables | `src/lib/deliverables/storage.ts` |
| FM8 | Builder "spray scaffolding" — no end-to-end wiring trace | role doc absent (`src/lib/agents/` has only `pm-soul.md`) |
| FM9 | Free-text completion summaries hide verification asymmetry | `register_deliverable` `src/lib/mcp/tools.ts:366-412` |
| FM-T | No role-scoped test budget — Builder runs full regression | role-doc + harness-side change |
| FM-A | Self-attestation everywhere — no run-and-forward primitive | new `submit_evidence` MCP tool |

## Design

### A. Evidence model (FM1, FM9, FM-A)

New MCP tool `submit_evidence`:

```
submit_evidence({
  task_id: string,
  gate: 'build_fast' | 'test_full' | 'review_static' | 'runtime_ui' | 'runtime_smoke',
  command: string,            // exact command line agent ran
  stdout: string,             // raw, untrimmed
  stderr: string,
  exit_code: number,
  artifact_paths?: string[],  // screenshots, trace.zip, HAR
  diff_sha?: string,          // git rev-parse HEAD at run time
})
```

Server side:
1. Reject if `command` doesn't match the gate's prescribed pattern (regex per gate).
2. Reject if `diff_sha` doesn't match the task's current head SHA (stale run).
3. For `runtime_ui`: require ≥1 `artifact_paths` entry that exists on disk and was written within session window.
4. Parse stdout: TS errors counted from `tsc` output, ESLint error count from JSON output, test pass/fail from tap or jest summary line. Pass/fail is computed, never trusted.
5. Persist as `task_evidence` row (new table) with hash of stdout for tamper-evidence.
6. Update `checkStageEvidence` to require a passing `task_evidence` row of the matching gate type for a forward transition into `testing` / `review` / `done`.

Free-text deliverables remain (for narrative context) but no longer satisfy the gate.

### B. Role-scoped test budgets (FM-T, FM6)

| Role | Required gate(s) before transitioning OUT |
|------|------------------------------------------|
| Builder | `build_fast`: `tsc --noEmit`, `eslint <changed>`, `jest --findRelatedTests <changed>` (or repo equivalent) — hard 60s budget |
| Tester | `test_full`: `yarn test` — 90s harness budget; `runtime_ui` or `runtime_smoke` artifact |
| Reviewer | `review_static`: structured diff notes referencing Tester's evidence ids — no test execution |

`build_fast` command is computed from `git diff --name-only <base>...HEAD` and prescribed to the Builder via the dispatch context — Builder doesn't pick the file list.

Harness budget: `submit_evidence` rejects entries with `duration_ms > budget`. The harness layer (Bash tool? gateway?) wraps long-running commands in a SIGTERM at budget+10s and emits a structured `{event: 'runner_stalled', command, budget}` payload the agent must surface.

### C. Workspace isolation enforcement (FM2)

Dispatch route (`src/app/api/tasks/[id]/dispatch/route.ts:33`) currently calls `determineIsolationStrategy` + `createTaskWorkspace`. Make isolation **mandatory** for any task with role ∈ {builder, tester} on a repo-backed product. Inject the resolved absolute workspace path into the agent's bootstrap context (`MC-CONTEXT.json` or session intro mail) as `workspace.path`. Agents that attempt to write outside that path through MCP tools get rejected at the MC API layer (path-prefix check).

If isolation fails (no git, no rsync target), fail the dispatch — don't fall back to shared working tree.

### D. Roll-call propagation (FM3)

`rollcall.ts` initiates a session and broadcasts the subject. When stage-isolated session is created (`workflow-engine.ts:handleStageTransition`), copy any `rollcall_sessions` entries with `status='active'` and matching agent into the new session's bootstrap context so `recordRollCallReplyIfMatch` finds them. Specifically: include `active_rollcalls: [{id, subject_pattern, expires_at}]` in the dispatch payload.

### E. ACL widening (FM4)

`get_task` in `src/lib/mcp/tools.ts:280` currently requires coordinator scope. Add: assigned agent of the task (any stage's role mapping) can read the task without elevation. Implementation: check `tasks.assigned_agent_id == calling_agent_id` OR `task_roles.agent_id == calling_agent_id` before falling through to coordinator gate.

### F. status_reason cleanup (FM5)

Already partly done in `task-status.ts:149-153` — broaden to clear ANY `status_reason` on forward transition out of a quality stage (not just `/^failed:/i`). Keep it on backward (`testing → in_progress`) since that's the audit trail. Optional: persist cleared reason to `prior_failures[]` JSON column on tasks.

### G. Path-scheme drift (FM7)

`src/lib/deliverables/storage.ts:getTaskDeliverableDir` should resolve to a path that is meaningful from the agent's runtime, not from MC's. Detect agent runtime (host vs Docker) at agent-registration time, store in `agents.runtime_root`, and resolve deliverables-root by joining that root with the task-relative subpath. Agent bootstrap MUST include the resolved absolute root.

### H. Builder wiring trace (FM8)

Add `src/lib/agents/builder-soul.md`, `tester-soul.md`, `reviewer-soul.md`. Builder soul mandates:
- Before transitioning to `testing`, trace one user-visible path end-to-end: call site → shim/dispatcher → component → mounted DOM. Document the trace in the deliverable.
- The `runtime_ui` evidence (Tester gate) is what *proves* the trace; the Builder doc just makes "wire it before saying done" explicit.

## Implementation slices

Ordered by leverage / risk:

1. **submit_evidence + checkStageEvidence rewrite** (FM1, FM9, FM-A) — biggest leverage. Schema migration + MCP tool + governance update + role-doc snippets.
2. **Role-scoped test budgets + role souls** (FM-T, FM8, FM6) — depends on (1) for the gate definitions. New role docs, dispatch context inclusion of prescribed commands, harness budget wrapper.
3. **Workspace isolation enforcement** (FM2) — make existing infra mandatory + inject path into bootstrap.
4. **Roll-call propagation** (FM3) — small, isolated change in dispatch + rollcall.
5. **ACL widening for get_task** (FM4) — one-line change, low risk.
6. **status_reason broadening** (FM5) — single regex/predicate change.
7. **Path-scheme drift** (FM7) — touches agent registration + bootstrap; medium risk.

Each slice is its own PR on its own branch, stacked on the previous where dependencies exist.

## Verification

Each slice ships with:
- Unit tests on the parser / hook logic
- A replay test that takes the recorded session 1/2/3 transcripts and asserts the new gates would have caught the bug (e.g. the no-mount AlertDialog should fail Builder's `build_fast` runtime trace step or Tester's `runtime_ui` gate)
- Preview-smoke run before the PR opens

Final gate: re-run a tiny convoy task end-to-end through the autonomous flow and confirm zero operator interventions.

## Open questions

- Does the harness budget belong in MC's MCP layer or in the openclaw worker? MC-side rejection is simpler but worker-side cancellation actually frees the turn.
- Should `task_evidence` be append-only audit, or should re-runs supersede prior entries? Append-only is safer; supersede is cleaner UI.
- Where do we store the prescribed-command templates per repo? Repo-local `.mc/gates.json` keeps it close to the code; central in MC keeps it consistent across products. Lean toward repo-local with MC fallbacks.
