# Pre-Check Initialization — Research Area

> **⚠️ DESTRUCTIVE.** Wipes dev DB. Confirm operator is not using `localhost:4010` or `192.168.50.95:4010` before running.
>
> **When to run:** before each execution of [`02-test-plan.md`](02-test-plan.md). Halt-on-failure — do not skip steps.

---

## 0. Prerequisites

| Check | Command | Expected |
|---|---|---|
| Repo on validation branch | `git rev-parse --abbrev-ref HEAD` | `feat/research-phase-1/...` (not `main`) |
| Repo clean | `git status --porcelain` | empty |
| Build plan present | `test -f docs/archive/research-area-build-plan.md && echo ok` | `ok` |
| Operator off dev server | _(ask)_ | confirmed |
| Dev server stopped | `lsof -ti :4010 \|\| echo none` | `none` (kill if needed: `kill $(lsof -ti :4010)`) |
| Openclaw gateway up | `lsof -ti :18789 \|\| echo none` | non-empty PID |
| `spark-lb/agent` reachable | `curl -sS http://localhost:18789/health \|\| true` | non-error |

If any prerequisite fails, fix it before continuing.

## 1. Backup current dev DB

```
yarn db:backup
yarn db:backup:list | tail -5
```

Expected: latest backup file is from the last few seconds.

## 2. Reset dev DB

```
yarn db:reset
```

Expected log lines (substitute correct migration ID — should be previous-max + 1):
```
[Migration NNN] agent_runs created.
[Migration NNN] topics created.
[Migration NNN] briefs created.
```

Confirm:
```
sqlite3 $DATABASE_PATH "SELECT COUNT(*) FROM agent_runs;"   # → 0
sqlite3 $DATABASE_PATH "SELECT COUNT(*) FROM topics;"       # → 0
sqlite3 $DATABASE_PATH "SELECT COUNT(*) FROM briefs;"       # → 0
```

## 3. Restart MC dev server

```
yarn dev:start  # or whatever the dev-start skill resolves to
```

Wait for ready, then confirm:

```
curl -sS http://127.0.0.1:4010/api/topics     | head -c 200
curl -sS http://127.0.0.1:4010/api/briefs     | head -c 200
curl -sS http://127.0.0.1:4010/api/agent-runs | head -c 200
```

Expected: each returns `[]` (empty workspace) or workspace-scoped JSON.

## 4. Sync agent rows for the workspaces under test

```
yarn dev:sync
```

Expected: `mc-researcher-dev` rows present in `default` and `foia` (or whichever secondary workspace the test plan uses):

```
sqlite3 $DATABASE_PATH "SELECT workspace_id, name, role FROM agents WHERE role='researcher';"
```

## 5. Targeted-test baseline pass

Once slices 1–3 have landed:

```
NODE_ENV=test yarn tsx --test \
  src/lib/db/agent-runs.test.ts \
  src/lib/db/topics.test.ts \
  src/lib/db/briefs.test.ts \
  src/lib/research/run-brief.test.ts
```

Expected: 100% pass on the new files. Pre-existing failures unrelated to this work: list in `04-e2e-run-results.md` per CLAUDE.md.

## 6. Prepare capture directory

```
mkdir -p /tmp/mc-validation/research
rm -rf /tmp/mc-validation/research/*
```

## 7. Sign-off

Mark in `04-e2e-run-results.md`:

```
Pre-check completed at <timestamp> on commit <sha>. STATUS: READY FOR TEST PLAN.
```

If any step above failed: STATUS: BLOCKED — <step> — <reason>. Do not proceed.
