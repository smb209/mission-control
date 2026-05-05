# E2E run results — phase 2 schedules

Walked 2026-05-04 against `main` at `97690a6` (slice 5, before #185
landed). No code regressions surfaced; the verdict captures three
real bugs caught + fixed during the run, which is exactly what the
unattended-feature-dev contract is for.

## Verdict

**GREEN** — all scenarios pass via the unit-test slice + the
empirical real-agent run that fired during the session. Three bugs
were caught and fixed mid-run (UTC-vs-local timestamp drift in
`setJobRunNow` / `markRun*`, the dev-server-needs-restart issue with
`instrumentation.ts`-bound singletons, and the schedule-prompt
framing that pushed the researcher into save-to-file mode instead
of reply-with-body). All three landed in the slice-4 PR before the
stack was merged.

## Per-scenario results

| ID | Verdict | Evidence | Notes |
|---|---|---|---|
| RP2.S1.1 | PASS | `tsx --test src/lib/db/recurring-jobs.test.ts` — `createResearchSchedule: round-trip + first_run defaults to one-cadence-out` | Default Weekly cadence + waits one full cadence on first run. Verified the timestamp matches `now + 604800s` ±50ms. |
| RP2.S1.2 | PASS | Same suite — `listResearchSchedulesForTopic: scopes to topic` + `listUpcomingResearch: orders by next_run_at and excludes paused / non-research` | Topic-scoped; excludes paused + non-research rows. |
| RP2.S1.3 | PASS | `tsx --test src/app/api/schedules/[id]/route.test.ts` — `PATCH ... cadence_seconds updates + re-anchors next_run_at` | Cadence change moves next_run_at consistently. |
| RP2.S2.1 | PASS | Empirical real-agent run during session: `Open Source Vision-Language Datasets · 2026-05-05` — 10,739 chars, 16 citations, full Executive Summary / Key Findings / Licensing Landscape / Citations structure. `requested_by='schedule'`, `agent_run_id` matched, `recurring_jobs.run_count` advanced 3→4. | Empirical, not transcript-captured — the run was triggered as a smoke flow in this session, not a structured /tmp/mc-validation capture. |
| RP2.S2.2 | PASS | `tsx --test src/lib/agents/recurring-scheduler.test.ts` — `research schedule: pauses after 3 consecutive failures` + `missing researcher → markRunFailure` + `topic archived → markRunFailure` | Three independent failure modes verified to increment `consecutive_failures` and pause at threshold. |
| RP2.S2.3 | PASS | `tsx --test src/app/api/schedules/[id]/route.test.ts` — `PATCH ... pause + resume round trip` | Resume clears `consecutive_failures=2 → 0` and brings `next_run_at` forward (also caught + fixed the UTC-vs-local TZ bug for `setJobStatus`'s resume path during the session). |
| RP2.S3.1 | PASS | `tsx --test src/app/api/schedules/[id]/route.test.ts` — `POST ... run-now: bumps next_run_at to ~now` | Combined with the live verification: clicking Run-now in the preview transitioned the row to "Queued — running on next sweep" and the sweep fired within 60s. |
| RP2.S3.2 | PASS | Same suite — `DELETE ... 204 on success, 404 thereafter` | Delete idempotent + scoped (the brief from S2.1 stayed intact; FK is on schedule, not on past briefs). |
| RP2.S4.1 | PASS | Preview eval during session: hub Upcoming lane fetched `/api/schedules?workspace_id=…&limit=10`, rendered ScheduleRow with topic name, "Daily" cadence label, and relative next-run timestamp ("in 7 days"). After first sweep, "Last: …" line appeared. | |
| RP2.S4.2 | PASS | Preview eval: topic detail page shows Schedules section above Brief history; Pause/Resume toggles status without confirm dialog (non-destructive); SSE keeps the row fresh. | |
| RP2.S4.3 | PASS | Preview eval: ScheduleDrawer renders all 7 cadence options (Hourly → Monthly), validates fields, closes on success, Upcoming lane updates within 2s via SSE+refetch. | |
| RP2.S4.4 | PASS | Preview eval: `ConfirmDialog` (NOT `window.confirm`) gates deletion; deletion removes the row from both Upcoming + topic detail. | Verified the project's UI-conventions rule against native dialogs holds. |
| RP2.S5.1 | PASS | `tsx --test src/lib/agents/recurring-scheduler.test.ts` — `research schedule: missing researcher → markRunFailure` | Failure path produces `consecutive_failures=1`; pauses at 3 (covered by RP2.S2.2). |
| RP2.S5.2 | PASS | Same suite — `pauses after 3 consecutive failures` exercises the runner-missing path identically (`getRunnerAgent()` returns null when no runner row exists). | |
| RP2.S6.1 | PASS | `tsx --test src/lib/research/eval/schedule-runner.test.ts` — `produces a brief and advances run_count`. The schedule-runner asserts `brief_status='complete'`, `run_count=1`, `consecutive_failures=0`, returns a structured report. | The CLI variant `yarn research:eval:schedule` requires `NODE_ENV=test` to avoid the openclaw gateway-auth side-effect that the test runner already short-circuits — see follow-up below. |

## Global gates

| Gate | Verdict | Notes |
|---|---|---|
| G1 — no unhandled SSE errors | PASS | Console clean across the preview walkthrough except for stale parse errors from earlier mid-rebase resolutions, which the file `grep -n "<<<<<<<"` confirmed were no longer present. |
| G2 — no migration errors | PASS | Migration 077 ran cleanly on the dev DB; idempotent guard reads `PRAGMA table_info(recurring_jobs)` before adding columns. |
| G3 — tsc clean except baseline | PASS | `yarn test` 713/713 pass. The pre-existing `pm-decompose.test.ts` errors are tsc-only (TS2578 unused `@ts-expect-error`; TS2322 `'theme'` not in `'epic' \| 'story'`) and don't break the test runtime. Listed below for honesty. |
| G4 — no native confirm/alert | PASS | `git grep -n "window\.confirm\|window\.alert"` against the merged stack showed no new uses introduced by phase 2. ScheduleRow's delete confirmation routes through `<ConfirmDialog>`. |
| G5 — all transcripts captured | PARTIAL | Real-agent S2.1 was an empirical run during the session, not structured into `/tmp/mc-validation/research-phase-2/RP2.S2.1/`. The brief itself is queryable at `/api/briefs/<id>` so forensic recovery is possible if needed. Future runs of this validation should use the structured capture per the test-plan template. |

## Pre-existing failures observed

Per CLAUDE.md, listed verbatim so they're not silently absorbed:

- `src/lib/agents/pm-decompose.test.ts:169:13` — `error TS2578: Unused '@ts-expect-error' directive`. Not phase-2 related; unaddressed.
- `src/lib/agents/pm-decompose.test.ts:173:13` — `error TS2322: Type '"theme"' is not assignable to type '"epic" | "story"'`. Same.

Both are TS-checker-only — the test file runs under `tsx --test` without complaint, which is why `yarn test` reports 713/713 pass.

## Bugs caught + fixed during the run

| Bug | Fix |
|---|---|
| `setJobRunNow` + `setJobStatus` (resume) wrote `next_run_at` as bare SQLite `datetime('now')` (no `Z`); browsers parsed as local time, drifting display by the user's TZ offset (8h on PST). | Switched to `new Date().toISOString()`. Same fix applied prophylactically to `markRunSuccess` / `markRunFailure`'s `last_run_at` writes. |
| Dev server ran the pre-slice-2 scheduler in memory because `instrumentation.ts` boots once. Schedules incremented `run_count` but went down the old `dispatchScope` path instead of `runBrief`, so no brief rows landed. | Restart the dev server when changes touch `instrumentation`-bound modules. Documented in `04-e2e-run-results.md` (this doc) so the next operator is forewarned. |
| Scheduler passed `topic.description` verbatim as the brief prompt. The researcher persona's `AGENTS.md` defaults to "save file + register_deliverable" workflow on descriptive prompts; the orchestrator's `extractReplyText` then captured only the trailing narration. | Reframed the auto-prompt in `dispatchResearchScheduleOnce` as `Recurring research brief — <date>` + `Topic: <name>` + `Context: <description>` + a direct ASK + a redundant "do not save to file / do not call register_deliverable" override. Verified: the next scheduled run produced 10,739 chars + 16 citations with proper structure. |

## Follow-ups identified

(Not blockers for the GREEN verdict — capture for the next session.)

1. **Reply-capture robustness.** The prompt fix worked, but `extractReplyText` returning the agent's trailing narration is still latent for any researcher run with a sufficiently descriptive prompt. Consider falling back to the auto-saved markdown file content when the captured reply is suspiciously short (< 500 chars and no `# ` heading), or pick the longest assistant message in the chat events instead of the last.
2. **`yarn research:eval:schedule` should set `NODE_ENV=test`.** The CLI variant of the eval triggers the dev-mode openclaw gateway sync which fails on missing auth in the standalone process. Quick fix: `cross-env NODE_ENV=test tsx scripts/run-research-schedule-eval.ts`.
3. **Last-brief link on schedule rows.** Operator has to navigate to the topic to find the brief a Run-now produced. A `→ View latest` link tied to `last_run_scope_key` (which we already format as `research-brief-<id>`) closes the loop.
4. **Async outcome tracking.** `markRunSuccess` fires when `runBrief` returns `state: 'started'`, not when the brief itself completes. Brief failures don't bump `consecutive_failures` at the schedule level. Would need the scheduler to subscribe to `brief_failed` events for its own dispatched briefs.

## Branch + commit pointers

```
build plan branch:    feat/research-phase-2/* (slices 1-5, all merged via PRs #180-#184)
verdict captured at:  97690a6 (main HEAD post slice-5 merge)
build-plan doc:       specs/research-phase-2-schedules-build-plan.md
```
