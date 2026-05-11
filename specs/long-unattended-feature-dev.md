# Long Unattended Feature Development — Workflow Template

A reusable pattern for shipping a multi-slice feature with **agent-driven validation** between slices, where the operator reviews the final result instead of every intermediate diff.

This codifies what worked for `scope-keyed-sessions` (`docs/archive/scope-keyed-sessions-validation/`) and `autonomous-flow-tightening` (`docs/archive/autonomous-flow-validation-plan.md`). Use it as the contract for any feature where the operator says "go build this, I'll review at the end."

## When to use this

✅ Multi-slice features (DB → API → dispatch → UI), 3+ PRs deep
✅ Operator opts into "stacked PRs, no in-between review"
✅ The feature is exercisable by real-agent dispatches against the dev DB
✅ A clear pass/fail bar can be defined up front

❌ Single-PR changes — overhead exceeds benefit
❌ Features whose correctness can't be probed end-to-end (pure refactors, type-only edits)
❌ Anything touching prod systems or external sinks without explicit opt-in

## The four documents

For feature `<feature-name>`, create:

```
specs/<feature-name>.md                       # the spec (pre-existing or co-authored)
specs/<feature-name>-build-plan.md            # this doc — design + slices + PR plan
specs/<feature-name>-validation/
  README.md                                    # index + how to read
  00-baseline-observations.md                  # state before any slice lands
  01-pre-check-initialization.md               # destructive runbook to reach known-good baseline
  02-test-plan.md                              # concrete scenarios with setup/action/observation
  03-validation-criteria.md                    # pass/fail gates per scenario + globals
  04-e2e-run-results.md                        # written DURING/AFTER runs; verdict + evidence
```

## Build-plan doc contents

1. **Audit** — what already exists in the codebase that this feature can reuse; what's missing.
2. **Design decisions** — the load-bearing calls (data model, integration boundary, dispatch model). Each with options considered + rationale + reversibility note.
3. **Slice plan** — ordered PR list. Each slice = one PR with: scope, files-touched estimate, dependencies on prior slices, what becomes testable after it lands.
4. **Test strategy per slice** — unit tests added in-slice, plus which validation scenarios become exercisable.
5. **Open questions** — things to confirm with operator before final slice merges.
6. **Out of scope** — explicit non-goals so scope creep doesn't sneak in.

## Validation directory conventions

### `00-baseline-observations.md`
Read-only snapshot of dev DB + relevant agent rows + open issues. Captured before any slice lands. Diffed against later milestones.

### `01-pre-check-initialization.md`
Destructive runbook to reach known-good baseline before each test-plan run. Every step has a command + expected output. Halt-on-failure. Common steps:
- Repo clean, on feature branch
- Migrations apply on fresh dev DB (`yarn db:reset`)
- Backup taken (`yarn db:backup`)
- Dev server restarted (so new MCP tools register)
- Targeted test slice baseline pass

### `02-test-plan.md`
Concrete scenarios grouped by surface or dispatch path. Each scenario has:
- ID (e.g. `R1.1`)
- Setup (DB state, agent state, env)
- Action (the dispatch / API call / UI action)
- Observation (what to capture: SSE events, DB rows, transcripts, screenshots)
- Capture path (`/tmp/mc-validation/<feature>/<scenario_id>/`)
- Time budget (~5 min real-agent time per scenario)

Convention: **all real-agent dispatches use `spark-lb/agent`** per `project_openclaw_model.md` memory.

### `03-validation-criteria.md`
Per-scenario gates table (AND-ed within a scenario). Plus global gates (e.g. "no unhandled SSE errors across the run"). A milestone passes only if all gates pass. `FLAKE` policy: re-run 3×, pass if ≥ 2/3.

### `04-e2e-run-results.md`
Written during/after runs. Top-level verdict (GREEN / YELLOW / BLOCKED / RED) with one-paragraph summary, then per-scenario results table, then evidence pointers. This is the single document the operator reads to decide "ship it."

## Operator handoff contract

When the operator says "go build this in a structured way, I won't review in between":

1. **Confirm the feature qualifies** (use the ✅/❌ list above).
2. **Write all four docs first.** No code until the operator OKs the build plan.
3. **Cut a feature branch** (`feat/<feature-name>` or `feat/<feature-name>-phase-N`).
4. **Slice into stacked PRs**, each targeting the previous slice's branch (not `main`). Per `feedback_stacked_pr_merges.md`: when ready to merge, retarget children to `main` BEFORE merging the parent with `--delete-branch`.
5. **Per slice**: implement → unit tests → run targeted suite → push → open PR with `## Summary`/`## Changes`/`## Test plan` body, link the build-plan doc, list which validation scenarios are now exercisable.
6. **After all slices**: run `01-pre-check-initialization.md` → execute `02-test-plan.md` → score against `03-validation-criteria.md` → write `04-e2e-run-results.md` with verdict.
7. **Surface for review**: post the verdict + evidence pointers to the operator. If GREEN, ready to merge the stack; if BLOCKED/RED, surface what to fix and ask before continuing.

## Quality bars

- **Don't invent scenarios as you go** — if the test plan isn't written before the code, the feature isn't ready for unattended dev.
- **Capture transcripts** for every real-agent dispatch (`/tmp/mc-validation/<feature>/<scenario_id>/`). Forensic value compounds when something fails.
- **Per-PR test plan in body** isn't optional — the operator has to be able to spot-check any single slice independently.
- **Pre-existing test failures**: list them in the verdict (file + reason) per CLAUDE.md, never silently work around them.
- **Cost ceiling**: declare it up front in the build plan (per `project_openclaw_model.md` it's effectively unlimited for this project, but the discipline transfers if we ever shift models).

## Anti-patterns this prevents

- "I made a bunch of changes; here's a 2000-line PR" — sliced PRs make review tractable.
- "I tested it manually" — without `02-test-plan.md`, "tested" means nothing reproducible.
- "It works on my machine" — `01-pre-check-initialization.md` forces a clean baseline.
- "I'll add tests later" — per-slice unit tests are the contract for that slice's PR.
- "We can validate after merge" — validation runs against the stacked branches before merge so failures don't ship.
