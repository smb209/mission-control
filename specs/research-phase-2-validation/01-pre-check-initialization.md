# Pre-check initialization — phase 2 schedules

Destructive runbook. Halt on first failure. The dev DB at `:4010` is fully separate from prod (`project_dev_prod_db_split.md`) so wipes are routine.

## 1. Repo on the right branch, clean tree

```
git status -s                                   # expect: empty
git branch --show-current                       # expect: feat/research-phase-2/<slice> or the merged-up tip
```

If untracked/modified files: stop. Resolve before running validation.

## 2. Reset the dev DB and apply migrations

```
yarn db:reset                                   # destroys mission-control.db at /Users/snappytwo/snappytwo-sandbox/mission-control
```

Expected: console shows migrations 001 → 076+ applying, last line `[Migration 076] research schedules columns added.` (or whatever slice 1's migration id ends up being).

## 3. Take a backup

```
yarn db:backup
ls -1 backups/ | tail -3                        # confirm a fresh file with today's stamp
```

## 4. Provision a research-ready workspace

```
yarn workspace:provision --slug rp2 --name "Phase 2 Validation"
yarn agents:add --workspace rp2 --role researcher
yarn agents:add --workspace rp2 --role pm
```

Confirm via API:
```
curl -s http://localhost:4010/api/workspaces | jq '.[] | select(.slug=="rp2")'
curl -s "http://localhost:4010/api/agents?workspace_id=<id>" | jq '.[].role' | sort | uniq -c
                                                # expect at least: researcher, runner, pm
```

If preflight fails, the schedule run-now will refuse to dispatch — exactly the same failure mode as phase 1's manual run. That's fine for `RP2.S5.*` (preflight-fail scenarios) but not for `RP2.S1-S4`.

## 5. Restart the dev server so new MCP tools register

```
yarn dev:restart                                # uses the dev-restart skill / port 4010
yarn dev:status
```

Expected: server bound on `:4010`, `[startup]` log shows recurring-scheduler enabled.

## 6. Targeted test slice baseline pass

Before kicking off scenarios, confirm slice-level units green:
```
yarn test src/lib/db/recurring-jobs.test.ts
yarn test src/lib/agents/recurring-scheduler.test.ts
yarn test src/lib/research/run-brief.test.ts
```

If any fail, halt — fix before running the e2e plan. Pre-existing failures (e.g. `pm-decompose.test.ts`) get listed in `04-e2e-run-results.md` per CLAUDE.md.

## 7. Seed a baseline topic

```
curl -s -X POST http://localhost:4010/api/topics \
  -H 'content-type: application/json' \
  -d '{"workspace_id":"<id>","name":"WAL on macOS","description":"recurring survey"}' | jq .
```

Note the returned topic id — it's referenced as `<topic_wal>` throughout `02-test-plan.md`.
