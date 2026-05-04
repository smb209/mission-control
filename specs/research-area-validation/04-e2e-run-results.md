# Real-Agent E2E Run Results — Research Area Phase 1

> **Format:** append a new dated section per validation milestone (after slice 4 lands; after slice 5 lands; after any later phase).
>
> Each section: top-level verdict, per-scenario results table, global gates table, evidence pointers.

---

## Run 1 — 2026-05-04 — slices 1–5 implemented; stack open as PRs #161–#165

**Verdict: GREEN (pre-merge, mock-mode evidence). LIVE GATEWAY SCENARIOS PENDING.**

All five slices (db / api / dispatch / ui / eval) have landed on stacked PRs, all unit + integration test gates pass, and the eval harness has been smoke-tested end-to-end in mock mode. The live-agent scenarios that require the openclaw gateway + the operator's dev server (R2.1, R3.1, R4.1, R5.1, R5.2, R7.1–R7.3) are blocked on **stack merge + a dev-server restart on the merged branch**, which the operator must trigger.

The `01-pre-check-initialization.md` runbook is destructive (wipes dev DB) and must not run while the operator is using `localhost:4010` — it's the operator's call to schedule that window.

### Per-scenario results

| Scenario | Result | Notes / evidence |
|---|---|---|
| R1.1 — Create topic via API | PASS (DAO+API tests) | `src/lib/db/topics.test.ts` + `src/app/api/topics/route.test.ts`. SQL-injection probe included. |
| R1.2 — List is workspace-scoped | PASS (DAO+API tests) | Same files. |
| R1.3 — Soft-delete | PASS (DAO+API tests) | Same files. |
| R2.1 — One-shot brief (general_brief) | PENDING (LIVE) | Orchestrator covered by `src/lib/research/run-brief.test.ts` happy path + topic-context test. End-to-end against gateway needs operator-driven run. |
| R3.1 — Topic-attached brief | PENDING (LIVE) | "topic context flows into the assembled prompt" test in `run-brief.test.ts` confirms the wiring; live confirmation pending. |
| R4.1 — SSE events fire during run | PENDING (LIVE) | Event types added to `SSEEventType`; orchestrator emits `brief_started` / `brief_progress` (throttled) / `brief_completed` / `brief_failed`. End-to-end confirmation requires live SSE consumer. |
| R5.1 — Malformed response handling | PASS (mock) | "empty body → fails with explicit message" test in `run-brief.test.ts`. |
| R5.2 — Gateway down | PASS (mock) | "gateway not connected → failed with gateway message" + "chat.send throws → failed" tests. |
| R6.1 — Eval fixture run produces stable scores | PASS | `NODE_ENV=test yarn research:eval --only bad_one_sentence` exits 0 with deterministic axis scores. |
| R6.2 — Eval rubric flags bad fixture | PASS | bad_one_sentence aggregate=0.250 (well below 0.4 threshold). Captured in eval-runner self-test. |
| R7.1 — Hub dashboard | PENDING (LIVE) | Page implemented; live SSE updates only confirmable on running dev server. |
| R7.2 — Topic detail | PENDING (LIVE) | Same. |
| R7.3 — Brief detail | PENDING (LIVE) | Same. |
| R8.1 — Cross-workspace isolation | PASS (DAO+API tests) | DAO tests for topics, briefs, agent-runs all assert workspace isolation; API tests confirm workspace scoping at the route boundary. |

### Global gates

| Gate | Result | Notes |
|---|---|---|
| Type check | PARTIAL | Same 2 pre-existing `pm-decompose.test.ts` errors observed throughout; no new errors introduced by any slice. |
| Test suite intact | PASS | 663 / 663 (was 611 baseline; +52 net new across slices 1+2+3+5). All five slice PRs documented their per-slice test plan in PR body. |
| No DB lock errors | PASS | All tests use isolated `.tmp/test-dbs/` per worker; no `SQLITE_BUSY` observed. |
| Migration idempotency | PASS | Migration 075 applied cleanly during `yarn test:setup`; idempotency exercised by repeated `yarn test` runs across slices. |
| Cost reasonable | N/A (mock) | No live gateway dispatches yet; eval harness mock mode only. |
| Capture completeness | PARTIAL | Mock-mode eval runs have `report.json` evidence (now gitignored under `tmp/research-eval/`); live-mode capture pending operator-led validation run. |

### YELLOW conditions (require operator sign-off)

1. **Web-tool exposure** — phase 1 dispatches direct openclaw `send-chat` to the researcher persona. The researcher's `send-chat` session must surface web-fetch / web-search tools or `general_brief` outputs will lack citations. Captured as a known risk in `00-baseline-observations.md` §3 and in build plan §2.5. First live R2.1 run will resolve to GREEN/YELLOW/BLOCKED on this dimension.
2. **Re-run UI affordance is non-functional** — the brief-detail "Re-run" button is rendered + tooltip-disabled with "phase 2." Operator confirmation that this is the intended phase-1 surface.
3. **Schedule lane on hub is a placeholder** — "Upcoming" lane on `/research` displays empty-state copy referencing phase 2 schedules. Same surface treatment as the Re-run button.

### Pre-existing failures noted (per CLAUDE.md)

| File / surface | Failure | Pre-exists? |
|---|---|---|
| `src/lib/agents/pm-decompose.test.ts:169` | TS2578 unused `@ts-expect-error` directive | Yes — present on `main` before any feat/research-phase-1 commit. |
| `src/lib/agents/pm-decompose.test.ts:173` | TS2322 type mismatch | Yes — same. |
| `next build` on `/initiatives` | "useSearchParams missing Suspense" prerender error | Yes — `useSearchParams` is not used by any research-area file. Prod build is broken on main; only dev mode (which the operator uses) is affected. |

### Action items for live validation run

When the operator is ready to run R2/R3/R4/R5/R7 against a live gateway:

1. Land the stack: PRs **#161 → #162 → #163 → #164 → #165** in that order.
   - Per `feedback_stacked_pr_merges.md`: retarget each child's base to `main` BEFORE merging the parent with `--delete-branch`.
2. Pull `main`; run `yarn install` (no new deps).
3. Take a database backup: `yarn db:backup`.
4. Stop the dev server: `kill $(lsof -ti :4010)`.
5. Execute `01-pre-check-initialization.md` end-to-end. Halt-on-failure.
6. Restart the dev server: `yarn dev`.
7. Run scenarios R2.1 → R3.1 → R4.1 → R5.1 → R5.2 → R7.1 → R7.2 → R7.3 with capture into `/tmp/mc-validation/research/<scenario_id>/`.
8. Score against `03-validation-criteria.md`. If GREEN: merge complete. If YELLOW: surface conditions; operator decides.
9. Append a "Run 2" section to this file with the live verdict.

### Evidence pointers (this run)

- PRs: [#161 db](https://github.com/smb209/mission-control/pull/161), [#162 api](https://github.com/smb209/mission-control/pull/162), [#163 dispatch](https://github.com/smb209/mission-control/pull/163), [#164 ui](https://github.com/smb209/mission-control/pull/164), [#165 eval](https://github.com/smb209/mission-control/pull/165). Each PR body lists its per-slice test plan + which validation scenarios it newly enables.
- Per-slice unit test commit messages contain the test totals at slice landing time.
- Mock-mode eval smoke output captured inline in PR #165 body.
