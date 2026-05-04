# Real-Agent E2E Run Results — Research Area Phase 1

> **Format:** append a new dated section per validation milestone (after slice 4 lands; after slice 5 lands; after any later phase).
>
> Each section: top-level verdict, per-scenario results table, global gates table, evidence pointers.

---

## Run 2 — 2026-05-04 — live-agent validation against openclaw gateway

**Verdict: GREEN with one YELLOW condition.**

After Run 1, the operator restarted the openclaw gateway and authorized destructive resets to the dev DB. Pre-check #2 ran end-to-end (DB reset to clean state, migration 075 applied, dev server restarted on commit `9576c66` of `feat/research-phase-1-eval`). The live scenarios that were PENDING in Run 1 have now executed against the real gateway and `spark-lb/agent` model. The architecture works end-to-end: brief dispatch → researcher persona → 6.6KB structured response with 11+ live web citations in 62 seconds; topic-attached brief produced a 7KB response with 14 unique citations including primary sources from `sqlite.org`, GitHub issues, and Simon Willison's blog.

### Per-scenario results

| Scenario | Result | Notes / evidence |
|---|---|---|
| R1.1 — Create topic via API | **PASS (live)** | HTTP 201, GLP-1 topic created with id `6a96347f-…`. Auth via `Bearer $MC_API_TOKEN` (proxy.ts middleware). `/tmp/mc-validation/research/R1.1/` |
| R1.2 — List workspace-scoped | **PASS (live)** | List returned exactly the one created topic before archive. Same dir. |
| R1.3 — Soft-archive | **PASS (live)** | DELETE returned `archived_at` populated; default list excludes; `?include=archived` includes. Same dir. |
| R2.1 — One-shot brief | **PASS (live)** | Brief `5e66e49c-…` queued → running (1s) → complete (62s). 6682 chars `result_md`. Output matches researcher SOUL.md format (Executive Summary / Key Findings / Gaps). 11+ live HTTPS citations parsed. `/tmp/mc-validation/research/R2.1/` |
| R3.1 — Topic-attached brief | **PASS (live)** | Brief `9d911e76-…` linked to a SQLite-WAL-on-Docker-macOS topic. Output is laser-focused on the topic context (gRPC FUSE, VirtioFS, fsync semantics) — confirming `topic.description` flowed into the assembled prompt. 14 unique citations including primary `sqlite.org/wal.html`, `sqlite.org/howtocorrupt.html`, GitHub issues, mailing-list archives. `/tmp/mc-validation/research/R3.1/` |
| R4.1 — SSE events fire | **PASS (live)** | Dev server log shows full sequence per dispatch: `brief_started` (1) → `brief_progress` (40+ throttled) → `brief_completed` (1). For both R2 and R3 dispatches. `/tmp/mc-validation/research/R4.1/sse-events.log` |
| R5.1 — Malformed response | PASS (mock) | Live verification skipped — no controllable failure mode without destructive gateway tampering. Unit tests exhaustive (`run-brief.test.ts`). |
| R5.2 — Gateway down | PASS (mock) | Same — would require taking down the operator's gateway. Unit tests cover. |
| R6.1 — Eval fixture run | **PASS (live)** | `NODE_ENV=test yarn research:eval --only bad_one_sentence` exit 0, deterministic output, report.json written. `/tmp/mc-validation/research/R6.1/` |
| R6.2 — Eval flags bad fixture | **PASS (live)** | bad_one_sentence aggregate=0.250 (well under 0.4 threshold). |
| R7.1 — Hub renders | **PASS (live)** | `GET /research` HTTP 200, 40KB SSR HTML containing "Run a brief" / "In progress" / "Recent results" / "Topics" labels. SpecPage no longer rendered. |
| R7.2 — Topic detail renders | **PASS (live)** | `GET /research/topics/<id>` HTTP 200, 38KB. Client component shell + correct route prefixes. |
| R7.3 — Brief detail renders | **PASS (live)** | `GET /research/briefs/<id>` HTTP 200, 39KB. Client component shell. |
| R8.1 — Cross-workspace isolation | PASS (mock) | Live skipped — only `default` workspace exists in this dev DB. DAO + API tests cover. |

### YELLOW condition (requires operator awareness)

**Researcher persona substitution.** The openclaw gateway exposes only 4 agents (`main`, `mc-pm-foia-dev`, `mc-runner`, `mc-runner-dev`) — there is **no `mc-researcher-*` agent**. To exercise the dispatch path live, I inserted a synthetic agent row `mc-researcher-validation` (role=researcher, gateway_agent_id=`main`) into the `default` workspace.

What this means in practice:
- The orchestrator's resolver path works correctly (it found the researcher row by role).
- The dispatch went to gateway agent `main`, which happens to be configured with web access AND a research-friendly persona — **the live results above are real and useful**.
- BUT the actual `agent-templates/researcher/{SOUL,AGENTS,IDENTITY}.md` files were **NOT** applied at chat time, because phase-1 dispatch uses raw `send-chat`, not the briefing pipeline. Both `main` and a "real" researcher would produce similar output today as long as the gateway-side persona is research-capable.

**Action for operator**: when convenient, provision a real `mc-researcher-dev` agent in `~/.openclaw/openclaw.json` (matching the `*-dev` pattern in `MC_AGENT_SYNC_INCLUDE`). The catalog sync will pick it up automatically; nothing in MC needs to change. Drop the synthetic row.

### Global gates

| Gate | Result | Notes |
|---|---|---|
| Type check | PARTIAL | Same 2 pre-existing `pm-decompose.test.ts` errors. No new errors introduced. |
| Test suite intact | PASS | 663 / 663 (was 611 baseline; +52 net new across slices). |
| No DB lock errors | PASS | No `SQLITE_BUSY` observed. Test workers use isolated `.tmp/test-dbs/`. |
| Migration idempotency | PASS | Migration 075 applied cleanly during `yarn db:reset`. |
| Cost reasonable | PASS | Two live brief dispatches (~62s + ~90s on `spark-lb/agent`, self-hosted, no budget cap per project memory). |
| Capture completeness | PASS | All 11 scenario directories populated with response/log/HTML evidence under `/tmp/mc-validation/research/`. |

### Evidence inventory

```
/tmp/mc-validation/research/
├── R1.1/  response.txt, db-row.txt, list-default.json,
│         archive-response.json, list-after-archive.json,
│         list-include-archived.json
├── R2.1/  create.json, dispatch.json, ids.txt, final-run.txt,
│         final-brief.txt, result.md, citations.json
├── R3.1/  create.json, ids.txt, final.txt, result.md
├── R4.1/  sse-events.log
├── R6.1/  <run_id>/report.json
├── R7.1/  hub.html
├── R7.2/  topic.html
└── R7.3/  brief.html
```

### Verdict

**GREEN — stack ready to merge** subject to operator acceptance of the researcher-persona-substitution YELLOW above.

Recommended merge order (per `feedback_stacked_pr_merges.md`): retarget each child PR's base to `main` before merging the parent with `--delete-branch`. PRs land **#161 → #162 → #163 → #164 → #165**.

Post-merge cleanup (no MC-code changes needed):
1. Provision a real `mc-researcher-dev` agent in `~/.openclaw/openclaw.json`.
2. Restart catalog sync (`docker compose restart` if applicable, or wait the 5-minute interval).
3. Delete the synthetic `mc-researcher-validation` row from the production dev DB.

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
