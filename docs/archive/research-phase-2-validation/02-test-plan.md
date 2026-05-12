# Test plan — phase 2 schedules

Scenarios grouped by surface. Each is ~5 minutes of real-agent time. Capture transcripts + DB diffs into `/tmp/mc-validation/research-phase-2/<scenario_id>/`.

All real-agent dispatches use `spark-lb/agent` (per `project_openclaw_model.md`).

| ID | Surface | Purpose |
|---|---|---|
| RP2.S1.1 | API + DAO | Create a schedule for `<topic_wal>`, default cadence (weekly), assert row + `next_run_at = now()+604800s`. |
| RP2.S1.2 | API + DAO | List schedules for workspace and for topic, both return the row from S1.1. |
| RP2.S1.3 | API | PATCH to change cadence to `cadence_seconds=60`; row updates; `next_run_at` adjusts to `last_run_at + 60s` (or `created_at + 60s` if never run). |
| RP2.S2.1 | Scheduler | Set the row's `cadence_seconds=2`, `next_run_at=now()`. Wait one sweep. Assert one new brief row tied to `<topic_wal>` with `template='general_brief'`, `recurring_jobs.run_count=1`, `next_run_at` advanced. |
| RP2.S2.2 | Scheduler | Force the runner agent offline. Sweep tick should mark `consecutive_failures=1` and emit a `brief_failed` event. After 3 failures, status=`paused`. |
| RP2.S2.3 | Scheduler | Resume via `PATCH /api/schedules/[id]` with `status=active`. `consecutive_failures` resets to 0; next sweep dispatches successfully (after re-enabling runner). |
| RP2.S3.1 | API | `POST /api/schedules/[id]/run-now` sets `next_run_at=now()`; next sweep fires within 60s. |
| RP2.S3.2 | API | `DELETE /api/schedules/[id]` removes the row; the brief produced by S2.1 stays (FK is on schedule, not on past briefs). |
| RP2.S4.1 | UI | `/research` Upcoming lane shows the schedule with topic name + cadence label + relative next-run timestamp. |
| RP2.S4.2 | UI | Topic detail page lists the schedule with enable/pause/resume + Run-now actions. SSE keeps last-run timestamp fresh. |
| RP2.S4.3 | UI | Create a schedule via the drawer; toast or inline confirmation; lane updates without manual refresh. |
| RP2.S4.4 | UI | Delete the schedule via topic detail; confirm dialog (per UI-conventions: no native confirm); row disappears from Upcoming + topic page. |
| RP2.S5.1 | Preflight | Workspace with no researcher roster entry → schedule create allowed, but first sweep marks the run failed with the same preflight message phase 1 surfaces. After 3 failures, paused. |
| RP2.S5.2 | Preflight | Runner offline → same as S5.1 with the runner-missing message. |
| RP2.S6.1 | Eval | `yarn research:eval --scenario rp2-scheduled-run` (slice 5) creates a 1s-cadence schedule, observes a real-agent run, asserts brief produced with citations + structure. |

## Setup / Action / Observation per scenario

For each scenario the runner records:

```
/tmp/mc-validation/research-phase-2/<id>/
  setup.md          # commands run pre-action + outputs
  action.md         # the API call / UI step / sweep wait
  observed.json     # SSE events + DB diff (before/after counts)
  evidence/
    snapshot.html   # preview_snapshot output where UI is involved
    screenshot.png  # preview_screenshot for visual scenarios
    transcript.md   # real-agent transcript for S2.* and S6.*
```

Time budget: 5 min per scenario, 90 min for the whole plan including S6.1's real-agent run.
