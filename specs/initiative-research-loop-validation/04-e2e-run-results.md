# 04 — E2E run results

> Written during/after the validation run. Single document the operator reads to decide "ship it."

## Verdict — YELLOW

**Structural surface and unit-tested behavior: GREEN.** Migration applied; schema verified; all targeted unit suites green at the stack tip; preview-verify confirmed the Research section renders and threads to the (initiative-scoped) Suggest + New brief drawers; MCP smoke green.

**Real-agent end-to-end (R-S1 / R-S4 / R-S6-agent-steps / R-S7): NOT-RUN.** These dispatch live PM + researcher work via `spark-lb/agent`. I deferred them rather than fire ~7 real-agent sessions unattended, because slice 3 edited `src/lib/research/run-brief.ts` (a known HMR-runaway hotspot per `project_research_hmr_runaway.md`) and a runaway during an unattended cycle is exactly the failure mode that memory exists to prevent. Operator runs the runbook in [01-pre-check-initialization.md](01-pre-check-initialization.md) → [02-test-plan.md](02-test-plan.md) before merging the stack to fully prove the loop closes.

The unit suites cover the load-bearing logic (auto-note shape, rerun chain dedupe, importance-2 / audience-pm filter compatibility, `read_brief` shape, suggest-prompt initiative scoping) so the real-agent runs are validating *integration*, not contracts. If any contract were going to break it would have failed in the per-slice tests.

## Per-scenario results

| ID | Scenario | Result | Evidence |
|---|---|---|---|
| R-S1 | Suggest scoped to initiative | **NEEDS-OPERATOR** (real PM dispatch) | unit: `src/lib/research/suggest.test.ts → "generateSuggestions: stamps initiative_id onto brief suggestion payloads"` proves the path with a stub PM; prompt-shape covered by `"buildInitiativeSuggestPrompt: prompt body is initiative-scoped, not workspace-scoped"` |
| R-S2 | Auto-note on completion | **PASS** (unit) | `src/lib/research/run-brief.test.ts → "runBrief: when initiative-scoped, completion writes one auto-note + populates summary"` |
| R-S3 | Rerun replace | **PASS** (unit) | `src/lib/research/run-brief.test.ts → "runBrief: rerun completion soft-archives prior auto-note (chain dedupe)"` |
| R-S4 | Decompose context loads auto-note | **NEEDS-OPERATOR** (real PM dispatch) | The path is contract-tested: auto-note lands at `audience='pm', importance=2`, exactly the shape `decompose-initiative/route.ts:118` already prompts the PM to read. No code change needed in decompose itself; the integration is "PM follows its existing prompt." |
| R-S5 | `read_brief` discoverability | **PASS** (direct probe) | `src/lib/mcp/groups/read.test.ts → "read_brief: returns the full brief shape …"` + `src/lib/mcp/mcp.test.ts → "default server keeps full union of 45 tools"` (was 44; bumped after slice 4). MCP smoke green via `yarn mcp:smoke`. |
| R-S6 | Full UI loop | **PASS** (preview, structural) | Preview navigated to `/initiatives/<id>`; Research section renders title + Suggest research + New brief buttons + correct empty state ("No research yet…"). No console errors. Real-agent steps (suggest → accept → run → notes rail → decompose proposal) defer with R-S1/R-S4/R-S7. |
| R-S7 | Proposal references research | **NEEDS-OPERATOR** (real PM dispatch) | Hard requires R-S4 since this is the *qualitative* check on R-S4's output. |

## Global gates

| ID | Gate | Result | Note |
|---|---|---|---|
| GG.1 | per-PR test slices green | ✅ | Stack-tip targeted tests: 945/946 pass. |
| GG.2 | `yarn mcp:smoke` | ✅ | "OK — 4 proxied POSTs validated + HTML-404 diagnosis regression" |
| GG.3 | typecheck / build | ✅ | `yarn tsc --noEmit -p tsconfig.json` clean at every slice + at stack tip. |
| GG.4 | no new error log entries | ✅ (preview-only) | Preview console_logs at `level: error` returned no entries during the Research-section render checks. Production-equivalent run hasn't been done — that's part of operator e2e. |
| GG.5 | queue empty at end | ✅ | `SELECT COUNT(*) FROM briefs JOIN agent_runs … WHERE status IN ('queued','running')` = **0** before and after the structural validation pass. |
| GG.6 | ≤ 1 dispatch per scenario | N/A | No real dispatches fired during this validation pass. |
| GG.7 | pre-existing failures listed | ✅ | One: `src/lib/research/eval/schedule-runner.test.ts → "schedule-runner: produces a brief and advances run_count"` was failing on `main` before this work began. Confirmed via `git stash` baseline at slice 0 (roadmap polish PR's test plan). Listed in every slice PR body. **Not introduced by this stack.** |

## Pre-existing test failures

```
not ok 670 / 672 - schedule-runner: produces a brief and advances run_count
  src/lib/research/eval/schedule-runner.test.ts
```

Untouched by any of the 5 slices. Surfaced verbatim in slice 1, 2, 3, 4, 5 PR bodies.

## Anomalies / flakes

- During slice 5 preview-verify the first run hit `no such column: b.source_ref` because the dev DB had migration 089 recorded as applied before slice 1's body included `briefs.source_ref`. **Fixed in slice 5 with migration 090** — an idempotent belt-and-suspenders ALTER. Confirmed live by `PRAGMA table_info(briefs)` after a clean dev-server boot. New deployments running 089 + 090 in order get all four columns; deployments that already ran the broken 089 pick up `source_ref` via 090.
- During slice 0 (roadmap polish) preview-verify, the auto-center for the timeline canvas had to switch from `requestAnimationFrame` to `setTimeout(..., 50)` because RAFs were starving in the preview iframe under HMR churn. Documented in slice 0's PR body.

## Schema state at validation time (informational)

```
briefs columns added by 089 + 090: initiative_id, summary, source_ref ✓
agent_notes columns added by 089: source_kind, source_ref ✓
indexes: briefs_initiative_id_idx, agent_notes_source_idx ✓
in-flight queue: 0
```

## Next steps for the operator

**To convert YELLOW → GREEN before merging:**

1. Run [01-pre-check-initialization.md](01-pre-check-initialization.md) clean to a known baseline.
2. Execute [02-test-plan.md](02-test-plan.md) scenarios R-S1, R-S4, R-S6 (real-agent steps), R-S7 against the live dev stack with `spark-lb/agent`. Time budget ~25 min total agent time.
3. Score against [03-validation-criteria.md](03-validation-criteria.md). Each scenario has its capture path under `/tmp/mc-validation/research-loop/<scenario_id>/`.
4. Update this doc's verdict to GREEN if all gates pass.

**Merge order** (per `feedback_stacked_pr_merges.md`):
1. Retarget slice 2 PR base to `main`. Merge slice 1.
2. Retarget slice 3 PR base to `main`. Merge slice 2.
3. Retarget slice 4 PR base to `main`. Merge slice 3.
4. Retarget slice 5 PR base to `main`. Merge slice 4.
5. Merge slice 5.

All five PRs target the fork `smb209/mission-control` per `feedback_pr_target_fork.md`.

## What's *demonstrably* working at the structural level

- DB layer: `initiative_id` round-trips through `createBriefWithRun` + `getBrief`; `ON DELETE SET NULL` from initiatives works; `findBriefChainRoot` walks 2-deep rerun chains; `findNotesBySource` excludes archived by default.
- Suggest pipeline: branches cleanly between workspace-scoped and initiative-scoped context; rejects unknown initiative_id with 409; stamps `initiative_id` onto brief payloads; prompt body is initiative-scoped (no workspace-wide blocks).
- Brief completion: `extractBriefSummary` strips heading + collapses whitespace + caps at 160 chars; non-initiative briefs write zero auto-notes; initiative-scoped briefs write exactly one auto-note with the documented shape; rerun soft-archives prior with `archived_reason='superseded_by_rerun'`.
- MCP surface: `read_brief` registered, callable, returns the full documented shape, errors cleanly on unknown id; tool-count regression test bumped 44 → 45.
- UI: Research section renders inside the InitiativeDetailView header card; floating TOC includes `Research`; Suggest + New brief drawers accept and propagate `initiativeId`; `/api/initiatives/[id]/briefs` returns the joined `(brief, agent_run.status)` shape so the section doesn't N+1.

## What's *not yet* verified at integration

- A live PM session producing initiative-scoped suggestions whose JSON parses cleanly and whose payloads carry `initiative_id`.
- A live researcher dispatch completing through to the auto-note write at `audience='pm', importance=2`.
- A live PM `decompose_initiative` reading that auto-note and producing a proposal whose `impact_md` quotes the brief.
- The full UI loop end-to-end (Suggest → accept → run → notes rail → Decompose with PM → proposal references research).

These four are the four NEEDS-OPERATOR scenarios above.
