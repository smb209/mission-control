# Validation criteria — phase 2 schedules

Scenarios pass only when every gate in their row evaluates true. Globals apply across the entire run.

## Per-scenario gates (AND)

| ID | Gates |
|---|---|
| RP2.S1.1 | (a) HTTP 201; (b) returned row has `topic_id=<topic_wal>`, `brief_template='general_brief'`, `cadence_seconds=604800`; (c) `next_run_at` within ±2s of `now()+604800`. |
| RP2.S1.2 | (a) workspace listing includes the row; (b) topic listing includes the row; (c) other workspace's listing does NOT include it. |
| RP2.S1.3 | (a) HTTP 200; (b) `cadence_seconds=60` in returned row; (c) `next_run_at` advanced consistently. |
| RP2.S2.1 | (a) exactly 1 new brief row, `topic_id=<topic_wal>`; (b) brief's `template='general_brief'`; (c) `recurring_jobs.run_count=1`, `consecutive_failures=0`; (d) `next_run_at = last_run_at + cadence_seconds` ±2s; (e) `brief_started` and `brief_completed` SSE events observed. |
| RP2.S2.2 | (a) `consecutive_failures` increments per sweep; (b) `brief_failed` SSE for each; (c) `status='paused'` when failures hit 3; (d) no further sweep dispatches while paused. |
| RP2.S2.3 | (a) `consecutive_failures=0` after PATCH; (b) `status='active'`; (c) next sweep produces a successful brief. |
| RP2.S3.1 | (a) `next_run_at <= now()` after the API call; (b) sweep dispatches within 60s. |
| RP2.S3.2 | (a) HTTP 204; (b) row gone; (c) brief from S2.1 still queryable. |
| RP2.S4.1 | (a) Upcoming lane lists the schedule by topic name; (b) cadence label matches dropdown ("Weekly"); (c) next-run timestamp formatted as relative ("in 6 days"). |
| RP2.S4.2 | (a) topic page shows schedule row; (b) Pause toggles status to `paused` without confirm dialog (non-destructive); (c) Resume restores. |
| RP2.S4.3 | (a) drawer fields validate (cadence + template); (b) success path closes drawer; (c) Upcoming lane updates within 2s via SSE. |
| RP2.S4.4 | (a) confirm dialog uses `ConfirmDialog`, NOT `window.confirm`; (b) deletion removes the row from both surfaces. |
| RP2.S5.1 | (a) schedule create succeeds; (b) first sweep produces a `brief_failed` whose error_md mentions the missing researcher; (c) status pauses at 3 failures. |
| RP2.S5.2 | Same gates as S5.1 with runner-missing message. |
| RP2.S6.1 | (a) real-agent dispatch via `spark-lb/agent`; (b) brief.result_md ≥ 200 words; (c) ≥ 1 citation parsed; (d) eval rubric "structure follows researcher SOUL output format" passes. |

## Global gates

- **G1.** No unhandled SSE errors across the run (`preview_console_logs { level: 'error' }` clean except for any pre-existing artifacts listed in 00-baseline-observations.md).
- **G2.** No `[Migration]` errors at startup.
- **G3.** `yarn tsc --noEmit` clean except the pre-existing `pm-decompose.test.ts` errors documented in baseline.
- **G4.** No native `window.confirm` / `alert` introduced (UI-conventions in CLAUDE.md).
- **G5.** All real-agent transcripts captured under `/tmp/mc-validation/research-phase-2/<id>/evidence/transcript.md`.

## FLAKE policy

A scenario flagged FLAKE (timing-sensitive sweep, transient gateway hiccup): re-run 3 times, pass if ≥ 2/3. Document re-run results in `04-e2e-run-results.md`.

## Verdict mapping

| Verdict | Meaning |
|---|---|
| GREEN | All gates pass on first run, or pass under FLAKE policy. Stack ready to merge. |
| YELLOW | All scenario gates pass but a global gate degraded (e.g. one transient SSE error). Operator decides. |
| BLOCKED | A scenario gate is failing for a reason outside this branch's scope (infra, gateway). Operator unblocks. |
| RED | At least one scenario gate fails on this branch's code. Don't merge. |
