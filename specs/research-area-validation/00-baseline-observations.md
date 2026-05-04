# Baseline Observations — Pre-Slice-1

> **Purpose:** Snapshot of dev environment state before any Research-Area code lands. Read-only — no DB writes, no service restarts.
>
> **Captured:** _(fill in when build-plan PR is opened)_
> **Branch:** `main` at the build-plan-PR base commit
> **Dev DB:** `${DATABASE_PATH}` (default `./mission-control.db`)

---

## 1. Schema state

> Capture with: `sqlite3 $DATABASE_PATH ".tables" | tr ' ' '\n' | sort | uniq -c | sort -rn`

- **Existing tables:** _(paste output)_
- **Latest migration:** _(paste from `sqlite3 $DATABASE_PATH "SELECT MAX(id) FROM _migrations"`)_
- **Confirm absent (will be added by slice 1):** `agent_runs`, `topics`, `briefs`

## 2. Researcher persona state

> Capture with: `sqlite3 $DATABASE_PATH "SELECT id, name, role, runtime_kind FROM agents WHERE role='researcher' OR name LIKE '%researcher%';"`

- **Researcher rows present:** _(paste)_
- **Per-workspace presence:** confirm `mc-researcher-dev` exists in the workspaces we'll use for validation (default + at least one secondary).
- **Persona files on disk:**
  - `agent-templates/researcher/SOUL.md` ✅
  - `agent-templates/researcher/AGENTS.md` ✅
  - `agent-templates/researcher/IDENTITY.md` ✅

## 3. Web-tool exposure (the main risk)

The phase-1 dispatch path uses `openclaw/send-chat.ts` directly, not the worker-task pipeline. The researcher persona's `send-chat` session must surface web-fetch / web-search tools or briefs cannot cite real sources.

> Capture by: dispatching a simple "what is the current price of GOOG?" probe to the researcher via existing PM chat or a manual `send-chat` invocation, and checking the response for evidence of web access. Document one of:
>
> - **GREEN** — researcher returns a current-day-priced answer with citations, indicating live web access
> - **YELLOW** — researcher returns a non-current answer but acknowledges the missing tool; we'll need to wire web tools into `send-chat` profile in slice 3
> - **BLOCKED** — `send-chat` itself fails or returns nothing usable; deeper fix needed before phase 1 can ship

Result: _(fill in)_

## 4. Recurring scheduler state

Phase 1 doesn't use the scheduler, but capture for diff:
- `recurring_jobs` row count: _(paste)_
- Scheduler currently active: _(yes/no — check `instrumentation.ts` or process status)_

## 5. Test-suite baseline

> Capture with: `yarn test 2>&1 | tail -40`

- **Pass/fail counts:** _(paste)_
- **Pre-existing failures (file + reason):** _(paste; CLAUDE.md requires we list these explicitly so they don't get blamed on our changes)_

## 6. UI surfaces under change

- `(app)/research/page.tsx` — currently the spec-renderer (`SpecPage`); will be replaced in slice 4
- `src/components/shell/AppNav.tsx` — Research nav entry already present; no nav change required this phase

## 7. Dev server state

- Port 4010: _(in use? by what PID?)_
- Operator using dev server actively: _(if yes, halt — `01-pre-check-initialization.md` is destructive)_

---

## Diff target

After phase 1 lands, re-running this capture should show:
- 3 new tables (`agent_runs`, `topics`, `briefs`)
- Latest migration ID = previous + 1
- New API routes mounted
- New activity-log event family `research.brief.*` emitting on dispatch
- `(app)/research/page.tsx` no longer using `SpecPage`
