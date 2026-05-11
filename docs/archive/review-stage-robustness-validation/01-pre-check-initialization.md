# 01 · Pre-Check / Initialization

Destructive runbook to reach a known-good baseline before each test-plan run. **Halt on any unexpected output.**

## Step 0 · Repo
```sh
git status -s
git branch --show-current
```
Expected: clean working tree (or only validation `04` edits); branch starts with `feat/review-robust-`.

## Step 1 · Dev DB reset
```sh
yarn db:backup        # rolling backup
yarn db:reset         # nuke + re-migrate dev DB
yarn db:sync-agents   # repopulate openclaw roster
```
Expected: no migration errors; agent count > 0.

## Step 2 · Roster check
Confirm dev workspace has at minimum one builder, one reviewer, one PM/coordinator agent online.

```sh
sqlite3 mission-control.db "
  SELECT role, COUNT(*) FROM agents
  WHERE workspace_id = 'default' AND COALESCE(disabled,0)=0 AND status != 'offline'
  GROUP BY role;
"
```
Expected: at least `builder ≥ 1`, `reviewer ≥ 1`, `pm ≥ 1` (or equivalent gateway-id-derivable rows). If reviewer missing, onboard one before continuing.

## Step 3 · Queue depth (HMR-runaway watchdog)
```sh
sqlite3 mission-control.db "SELECT COUNT(*) FROM agent_runs WHERE status IN ('queued','running');"
```
Expected: ≤ 5. If higher, restart dev server cleanly and wait for drain.

## Step 4 · Dev server restart
```sh
# /dev-restart  (skill)
yarn dev:status   # confirm :4010 listening
```
Expected: dev server up; `/api/health` returns 200.

## Step 5 · Targeted-suite baseline
```sh
yarn test --runInBand src/lib/services/task-status.test.ts \
                     src/lib/task-governance.test.ts \
                     src/lib/dispatch/roster-gate.test.ts \
                     src/lib/stall-detection.test.ts
```
Expected: all green. Pre-existing failures elsewhere are listed in `04-e2e-run-results.md` per CLAUDE.md.

## Step 6 · Capture dir
```sh
mkdir -p /tmp/mc-validation/review-robust
ls /tmp/mc-validation/review-robust   # should be empty for first scenario
```

## Step 7 · Feature flags (per scenario, enabled selectively)
- `MC_ROSTER_GATE` — Slice 0 scenarios.
- `MC_REVIEW_STRICT_GATING` — Slice 1 scenarios.
- `MC_REVIEW_AUTOBOUNCE` — Slice 4 scenarios.

Set as env vars before `yarn dev` boots; scenario doc names which.
