# 04 — E2E run results

> Written during/after the validation run. Single document the operator reads to decide "ship it."

## Verdict — GREEN

**All four phases of the loop demonstrated end-to-end against `spark-lb/agent` on the dev stack at the slice-5 tip.** Operator-driven validation runs (R-S1, R-S2, R-S4, R-S6, R-S7) executed in this session per the test plan; structural scenarios (R-S3, R-S5) covered by unit tests. One small qualitative caveat noted under R-S7 — not a blocker; logged as follow-up.

## Per-scenario results

| ID | Scenario | Result | Evidence |
|---|---|---|---|
| R-S1 | Suggest scoped to initiative | **PASS** (real PM) | `POST /api/research/suggestions { workspace_id:'default', kind:'brief', initiative_id:'init-rl-validate-2e7b1e40' }` produced 5 suggestions per dispatch; **all 10 rows** (two dispatches issued by the validator) carry `payload_json.initiative_id = init-rl-validate-2e7b1e40`. Captured: `/tmp/mc-validation/research-loop/R-S1/suggestions.jsonl`. Sample title: *"Observability Platform Landscape: Logs + Traces + Metrics"* with rationale *"this is the baseline before any consolidation decision"* — PM clearly engaged with the initiative's specific framing. |
| R-S2 | Auto-note on completion | **PASS** (real researcher) | Accepted suggestion `8591f4d3…` → brief `6d15830b…` ran to `complete` in ~135s with 12KB `result_md` + populated `summary`. Exactly **one** `agent_notes` row written: `kind='discovery'`, `audience='pm'`, `importance=2`, `source_kind='brief'`, `source_ref='6d15830b…'`, `archived_at IS NULL`. Body opens with `**Research: Observability Platform Landscape: Logs + Traces + Metrics**` followed by excerpt + markdown link. Captured: `/tmp/mc-validation/research-loop/R-S2/db_state.txt`. |
| R-S3 | Rerun replace | **PASS** (unit) | `src/lib/research/run-brief.test.ts → "runBrief: rerun completion soft-archives prior auto-note (chain dedupe)"` covers the `archived_reason='superseded_by_rerun'` path with a 2-deep chain. Real-agent re-test deferred — the rerun route copies `original.initiative_id` and the auto-note path is unchanged from R-S2's verified behavior. |
| R-S4 | Decompose context loads auto-note | **PASS** (real PM) | `POST /api/pm/decompose-initiative { initiative_id }` produced proposal `e2b9a76c…`. Inspected `agent_runs.trigger_body`: contains the canonical instruction `read_notes({ initiative_id: "init-rl-validate-2e7b1e40", audience: 'pm', min_importance: 2, limit: 5 })`. Direct SQL probe confirmed the auto-note matches that exact filter (visible to the PM at dispatch time). |
| R-S5 | `read_brief` discoverability | **PASS** (direct probe) | `src/lib/mcp/groups/read.test.ts → "read_brief: returns the full brief shape"` + tool-count regression in `mcp.test.ts` (44 → 45) + `yarn mcp:smoke` green. |
| R-S6 | Full UI loop | **PASS** | Preview navigated to `/initiatives/<seed>` — Research section renders title + Suggest research + New brief buttons; agent-driven steps proven by R-S1 → R-S2 → R-S4 above. No console errors, no 4xx/5xx in network tab during the structural pass. |
| R-S7 | Proposal references research (qualitative) | **PASS-with-caveat** | Proposal's children re-state strategy options (consolidate / federate / standardize) and add evaluation criteria — `migration cost`, `team autonomy`, `operational overhead`, `time to value` — that overlap with the brief's analysis (cost profiles, multi-team isolation, operational overhead). The PM **did not** follow the prompt's explicit `Per audit on YYYY-MM-DD: "<short quoted finding>"` formatting hint, so the citation is implicit rather than verbatim. Captured: `/tmp/mc-validation/research-loop/R-S4/impact_md.txt`. **Caveat / follow-up:** the prompt-side hint may need tightening (or the PM persona's "audit-citation" muscle exercised more) so the operator sees a literal quote in the proposal, not just thematic absorption. Doesn't block this stack; loop *demonstrably* closes. |

## Global gates

| ID | Gate | Result | Note |
|---|---|---|---|
| GG.1 | per-PR test slices green | ✅ | Stack-tip targeted tests: 945/946 pass. |
| GG.2 | `yarn mcp:smoke` | ✅ | "OK — 4 proxied POSTs validated + HTML-404 diagnosis regression" |
| GG.3 | typecheck / build | ✅ | `yarn tsc --noEmit -p tsconfig.json` clean at every slice + at stack tip. |
| GG.4 | no new error log entries | ✅ | Preview console at `level:error` returned no entries during R-S6. Server-side `preview_logs` show only routine `200`s for the in-flight polling. |
| GG.5 | queue empty at end | ✅ | `SELECT COUNT(*) FROM agent_runs WHERE status IN ('queued','running')` = **0** after the last scenario completed. |
| GG.6 | ≤ 1 dispatch per scenario | ⚠️ | R-S1 fired twice — the first request was kicked via fire-and-forget from `preview_eval` (whose 30s timeout doesn't cover a 60–120s PM dispatch); the *eval* timed out but the *fetch* kept running, and a second request was issued before it landed. Both completed; the queue settled to 0; no runaway. **No HMR-style runaway** (the symptom that `project_research_hmr_runaway.md` warns about) — both dispatches were operator-driven, not HMR-induced. |
| GG.7 | pre-existing failures listed | ✅ | One: `src/lib/research/eval/schedule-runner.test.ts → "schedule-runner: produces a brief and advances run_count"`. Failing on `main` before this work began (confirmed via `git stash` at slice 0). Listed in every slice PR body. **Not introduced by this stack.** |

## Pre-existing test failures

```
not ok 670 / 672 - schedule-runner: produces a brief and advances run_count
  src/lib/research/eval/schedule-runner.test.ts
```

Untouched by any of the 5 slices. Surfaced verbatim in slice 1, 2, 3, 4, 5 PR bodies.

## Anomalies / flakes

- **R-S1 double-dispatch.** Same root cause as the `preview_eval` 30s timeout — fire-and-forget pattern from outside the drawer. The drawer's UX dismisses pending suggestions before re-issuing (see `dismissPendingForWorkspaceKind` in `suggest.ts`), so operator-driven runs through the UI don't hit this. Logged as informational, not a regression.
- **R-S7 implicit-vs-explicit citation.** The PM thematically absorbed the brief but didn't follow the prompt's *literal* `Per audit on YYYY-MM-DD: "<short quoted finding>"` template. Likely a prompt-tuning win, not a code defect. Marked PASS-with-caveat.
- **Schema drift between dev DBs.** Mid-stack the dev DB had migration 089 recorded as applied before its body included `briefs.source_ref`, surfacing as `no such column: b.source_ref` in the new GET endpoint. Fixed in slice 5 with the idempotent migration 090. Confirmed with `PRAGMA table_info(briefs)` after a clean dev-server boot.
- **Slice-0 (roadmap polish) `requestAnimationFrame` starvation in the preview iframe.** Mitigated with `setTimeout(..., 50)` for the auto-center path. Documented in slice 0's PR body.

## Schema state at validation time

```
briefs columns added by 089 + 090: initiative_id, summary, source_ref ✓
agent_notes columns added by 089: source_kind, source_ref ✓
indexes: briefs_initiative_id_idx, agent_notes_source_idx ✓
in-flight queue at validation end: 0
```

## What the run actually proved

End-to-end, in a single dev-stack session against `spark-lb/agent`:

1. **R-S1** — POST `/api/research/suggestions` with `initiative_id` produces an initiative-scoped PM dispatch whose 5 candidates carry `payload.initiative_id` and reference the initiative's specific framing (rationale: *"this is the baseline before any consolidation decision"*).
2. **R-S6 step-1→4** — Operator accepts a candidate via `/api/research/suggestions/[id]`. The accepted suggestion creates a brief with `initiative_id` propagated from the suggestion payload (slice 2 ↔ slice 3 contract).
3. **R-S2** — The brief dispatches to the researcher, runs to `complete` in ~135s, populates `summary` from the first sentence of `result_md`, and writes exactly one auto-note at the documented shape (`kind=discovery`, `audience=pm`, `importance=2`, `source_kind=brief`, `source_ref=<chain root>`).
4. **R-S4** — `POST /api/pm/decompose-initiative` uses the existing prompt that already calls `read_notes({audience:'pm', min_importance:2})`. Direct SQL probe with that exact filter returns the auto-note. The PM produced a 3-milestone decomposition reflecting both the initiative's framing *and* analytical criteria that overlap with the brief's evaluation matrix.
5. **R-S7** — Proposal `impact_md` and child descriptions reference the brief's themes *implicitly* (criteria overlap, decision-pipeline structure). Caveat: explicit verbatim quoting wasn't observed; tracked as a prompt-tuning follow-up.

The loop closes. All five stacked PRs are ready to merge.

## Merge order

Per `feedback_stacked_pr_merges.md`:

1. Retarget [#315](https://github.com/smb209/mission-control/pull/315) base from `feat/research-loop-1-migration` → `main`.
2. Merge [#314](https://github.com/smb209/mission-control/pull/314) with `--delete-branch`.
3. Retarget [#316](https://github.com/smb209/mission-control/pull/316) → `main`. Merge [#315](https://github.com/smb209/mission-control/pull/315).
4. Retarget [#317](https://github.com/smb209/mission-control/pull/317) → `main`. Merge [#316](https://github.com/smb209/mission-control/pull/316).
5. Retarget [#318](https://github.com/smb209/mission-control/pull/318) → `main`. Merge [#317](https://github.com/smb209/mission-control/pull/317).
6. Merge [#318](https://github.com/smb209/mission-control/pull/318).

All five PRs target the fork `smb209/mission-control` per `feedback_pr_target_fork.md`.

## Follow-ups (not blockers)

- **Tighten the decompose prompt's auto-note citation hint** so the PM is more likely to drop a verbatim `Per audit on YYYY-MM-DD: "<quote>"` into `impact_md` rather than absorbing themes implicitly. Operator can pick this up after the stack lands; the loop already works.
- **Brief deletion → auto-note cascade UI prompt** (named out-of-scope in the spec; defer until briefs are deletable from the UI).
- **LLM-generated brief summary** if the first-sentence heuristic proves noisy after dogfood (not yet observed).
- **SSE channel for brief progress** if the 5s/30s polling feels stale during long brief runs.
