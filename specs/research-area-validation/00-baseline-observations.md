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

## 2. Researcher roster + runner state

**Updated for phase 2:** the researcher is a **role-only roster entry** (no gateway binding). The actual chat session is hosted by the workspace runner via `dispatchScope`, which composes the researcher persona from `agent-templates/researcher/{SOUL,AGENTS,IDENTITY}.md` at briefing time.

> Capture with:
> ```
> sqlite3 $DATABASE_PATH \
>   "SELECT name, role, source, gateway_agent_id FROM agents
>      WHERE workspace_id = '<ws_id>' AND role IN ('researcher','runner','pm');"
> ```

- **Researcher roster entries:** _(paste — should be `source='local'`, `gateway_agent_id=NULL`; provisioned via the Add Agents picker)_
- **Runner present:** _(paste — single `mc-runner-dev` row in `default` workspace)_
- **Persona files on disk:**
  - `agent-templates/researcher/SOUL.md` ✅
  - `agent-templates/researcher/AGENTS.md` ✅
  - `agent-templates/researcher/IDENTITY.md` ✅

## 3. Web-tool exposure (the main risk)

The phase-2 dispatch path uses `dispatchScope` against the runner. The runner's `send-chat` session must surface web-fetch / web-search tools or briefs cannot cite real sources.

> Capture by: dispatching a simple "what is the current price of GOOG?" probe to the runner via existing PM chat or a manual `send-chat` invocation, and checking the response for evidence of web access. Document one of:
>
> - **GREEN** — runner returns a current-day-priced answer with citations, indicating live web access
> - **YELLOW** — runner returns a non-current answer but acknowledges the missing tool; web-tool wiring on the runner needs follow-up
> - **BLOCKED** — `send-chat` itself fails or returns nothing usable; deeper fix needed before phase 1 can ship

Result: _(fill in — Run 2 confirmed GREEN against `main` agent with web access)_

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
