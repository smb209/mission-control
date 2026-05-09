# 01 — Pre-check initialization

Destructive runbook. Run to a clean baseline before each test-plan execution. **Halt on any unexpected output.**

## P0. Repo state

```bash
git status                       # clean working tree
git rev-parse --abbrev-ref HEAD  # on feat/research-loop-5-ui (or whichever tip)
```

Expect: `working tree clean`, branch is the stack tip (slice 5).

## P1. Dev DB reset + migration apply

```bash
yarn dev:stop || true            # ensure no dev server holding the DB
yarn db:backup                   # safety net
yarn db:reset                    # wipe dev DB
yarn db:migrate                  # apply migrations including the slice-1 add
```

Expect: migration 0NN (whatever number slice 1 lands as) listed as applied. Failure here = halt + investigate before any agent dispatch.

## P2. Confirm schema additions are live

```bash
sqlite3 $(node -e 'console.log(require("./src/lib/db/path").DATABASE_PATH)') \
  "SELECT name FROM pragma_table_info('briefs') WHERE name IN ('initiative_id','summary');"
sqlite3 $(node -e 'console.log(require("./src/lib/db/path").DATABASE_PATH)') \
  "SELECT name FROM pragma_table_info('agent_notes') WHERE name IN ('source_kind','source_ref');"
```

Expect both queries to list the four new columns. If empty, migration didn't take — halt.

## P3. HMR runaway guard

```bash
sqlite3 $DB_PATH "SELECT COUNT(*) FROM briefs b JOIN agent_runs r ON b.agent_run_id = r.id WHERE r.status IN ('queued','running');"
```

Expect `0`. **If non-zero**, dispatch is in progress — abort, investigate per `project_research_hmr_runaway.md`. Do not start the dev server until the queue is drained.

## P4. Dev server cold start

```bash
yarn dev:start                   # background on :4010
yarn dev:status                  # confirm pid + recent log
```

Expect: server up, no compile errors in tail of log. **A clean restart is mandatory** between any code edit to `src/lib/research/run-brief.ts`, `suggest.ts`, or any dispatcher and the first dispatch of a validation run.

## P5. Targeted test slice baseline

```bash
yarn test src/lib/db/briefs.test.ts \
          src/lib/db/agent-notes.test.ts \
          src/lib/research/suggest.test.ts \
          src/lib/research/run-brief.test.ts
```

Expect all green. **Pre-existing failures elsewhere in `yarn test`** get listed in `00-baseline-observations.md` and the verdict doc — never silently worked around per CLAUDE.md.

## P6. Workspace + initiative seed

Create a single throwaway initiative through the UI or DAO that the test plan acts on:

- Title: `[VALIDATION] Theme: how to model X`
- Description: 2 sentences, intentionally fuzzy so there's room for research to add value.
- Status: `proposed` (or whatever the default exploratory status is).

Capture the `initiative_id` to `/tmp/mc-validation/research-loop/seed.txt`. All scenarios reference it.

## P7. MCP smoke

```bash
yarn mcp:smoke
```

Expect green. The new `read_brief` tool should be discoverable; the smoke run is enough to catch a broken registration.

## Halt-on-failure

Any halt in P0–P7 means the validation run does not start. Surface the halt to the operator with the failing command output verbatim.
