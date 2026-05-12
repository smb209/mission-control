# Baseline observations — phase 2 schedules

Captured against `feat/research-phase-2/schema` HEAD before any phase-2 code lands. Re-capture if the branch advances.

## DB state

Capture against `mission-control.db` (dev DB at `:4010`). Commands the validator runs:

```
sqlite3 mission-control.db "SELECT COUNT(*) AS n FROM recurring_jobs;"                          -- baseline_recurring_jobs
sqlite3 mission-control.db "SELECT COUNT(*) AS n FROM topics WHERE archived_at IS NULL;"        -- baseline_active_topics
sqlite3 mission-control.db "SELECT COUNT(*) AS n FROM briefs;"                                  -- baseline_briefs
sqlite3 mission-control.db "PRAGMA table_info(recurring_jobs);"                                 -- baseline_recurring_jobs_columns
```

Fill in:

| Metric | Value |
|---|---|
| `baseline_recurring_jobs` | _<n>_ |
| `baseline_active_topics` | _<n>_ |
| `baseline_briefs` | _<n>_ |
| `topic_id` column present? | _no — added in slice 1_ |
| `brief_template` column present? | _no — added in slice 1_ |

## Agent state

```
sqlite3 mission-control.db "SELECT id, role, status FROM agents WHERE workspace_id='<ws>';"
```

Confirm a researcher roster entry + active runner exist for the workspace used in the run. If not, run the workspace-provision flow first (see `01-pre-check-initialization.md` step 4).

## Open issues / known weirdness

- `pm-decompose.test.ts` has two pre-existing TS errors (`@ts-expect-error` directive unused; literal `'theme'` not in `'epic' | 'story'`). Not phase-2 related; surface in `04-e2e-run-results.md` so the verdict is honest.
- WAL on macOS bind mounts has produced one transient `SQLITE_CORRUPT` historically (per project guide). Real corruption is rare; backups exist via `yarn db:backup`.

## Snapshot files

```
git rev-parse HEAD                              # snapshot the branch tip
git status -s                                   # confirm clean tree
```

Paste outputs into a `/tmp/mc-validation/research-phase-2/baseline/` directory before starting the run.
