# Autonomous Flow Tightening — Validation Plan

Status: ready to execute
Owner: smb209
Date: 2026-04-30 (validate next session)
Covers: PRs #113–#120 (all merged into main on 2026-04-30)

## What landed today

| PR | What it does | Key surface to validate |
|----|--------------|------------------------|
| [#113](https://github.com/smb209/mission-control/pull/113) | Spec under `specs/autonomous-flow-tightening-spec.md` | (reference doc — no runtime validation) |
| [#114](https://github.com/smb209/mission-control/pull/114) | `submit_evidence` MCP tool + parsed-stdout gate | `task_evidence` table; gate parsers; `checkStageEvidence` strict path |
| [#115](https://github.com/smb209/mission-control/pull/115) | `register_deliverable` count readback | Tool response shape |
| [#116](https://github.com/smb209/mission-control/pull/116) | `tasks.is_failed` flag + `whyCannotBeDone` | Migration 059; `taskCanBeDone` behavior |
| [#117](https://github.com/smb209/mission-control/pull/117) | Builder/Tester/Reviewer souls + `.mc/gates.json` + dispatch injection | Dispatch message content |
| [#118](https://github.com/smb209/mission-control/pull/118) | Strict workspace isolation for repo-backed tasks | 503 / 409 dispatch responses; reused workspace |
| [#119](https://github.com/smb209/mission-control/pull/119) | Pending roll-calls surfaced on every dispatch | Dispatch message; `rollcall_entries` durable lookup |
| [#120](https://github.com/smb209/mission-control/pull/120) | `agents.runtime_kind` picks deliverables-path perspective | Migration 060; dispatch path differs by runtime |

## Pre-flight (do once before validation)

1. **Pull main + verify migrations land cleanly.** A merged `db:reset` is the safest way to confirm migrations 058/059/060 apply in order on a fresh database (otherwise stale dev state can mask failures).
   ```
   git pull origin main
   yarn install
   yarn db:reset                # ⚠️ destructive — only on dev DB
   ```
   Expect the log lines:
   ```
   [Migration 058] task_evidence created.
   [Migration 059] tasks.is_failed added + backfilled.
   [Migration 060] agents.runtime_kind added.
   ```

2. **Backup before validation.** Manual snapshot in case something goes sideways:
   ```
   yarn db:backup
   yarn db:backup:list
   ```

3. **Restart the MC dev server** so the new MCP tool surface (`submit_evidence`) is registered. Confirm in the startup log.

4. **Run the targeted suite once** to baseline:
   ```
   NODE_ENV=test yarn tsx --test \
     src/lib/services/task-evidence.test.ts \
     src/lib/services/services.test.ts \
     src/lib/gates/config.test.ts \
     src/lib/agents/role-souls.test.ts \
     src/lib/workspace-isolation.test.ts \
     src/lib/rollcall.test.ts \
     src/lib/deliverables/storage.test.ts
   ```
   Expect **75 / 75 pass**. Pre-existing `pm-decompose.test.ts` errors are still there and unrelated.

## Per-PR validation

### 1. #114 — `submit_evidence` and the run-and-forward gate

**Goal:** confirm the parser correctly accepts real command output and rejects fabricated attestation.

**Steps:**
1. Pick (or create) a task in `in_progress` and grab its id.
2. From an authorized MCP client (or `curl` against the MCP HTTP endpoint), call:
   ```
   submit_evidence({
     agent_id: "<assigned>", task_id: "<id>",
     gate: "build_fast",
     command: "yarn tsc --noEmit",
     stdout: "", stderr: "", exit_code: 0
   })
   ```
   **Expect:** `passed: true`, `parsed_summary.fingerprints: ["tsc"]`, no `reject_reason`.

3. Repeat with the AlertDialog Builder's exact phrase:
   ```
   submit_evidence({ ..., gate: "build_fast",
     command: "verified manually",
     stdout: "TS clean, dev server verified",
     exit_code: 0 })
   ```
   **Expect:** `passed: false`, `reject_reason` contains `"no recognizable typecheck/lint/test output"`.

4. Inspect the row directly:
   ```
   sqlite3 ~/.mission-control/db.sqlite \
     "SELECT gate, passed, reject_reason, length(stdout), stdout_hash FROM task_evidence WHERE task_id = '<id>' ORDER BY created_at DESC;"
   ```
   **Expect:** rejected attempts persisted with `passed=0`; `stdout_hash` is 64 hex chars (sha256).

5. **Strict path:** with at least one `task_evidence` row present, attempt to transition the task to `testing` via `update_task_status` **without** a passing `build_fast` row.
   **Expect:** `evidence_gate` rejection with reason `"build_fast required to enter testing"`.

6. Submit a passing `build_fast`, then transition. **Expect:** transition succeeds.

**Rollback signal if it fails:** evidence rows aren't being persisted, or the strict path doesn't engage when rows exist. Check `hasAnyEvidence()` and the gate map in `task-governance.ts:39`.

### 2. #115 — `register_deliverable` count readback

**Quick check:**
```
register_deliverable({ ..., title: "x", deliverable_type: "file", path: "/tmp/x" })
```
**Expect** the response JSON to include `total_output_deliverables_on_task` and `total_deliverables_on_task`. Register a second one — the counts should increment.

### 3. #116 — `is_failed` flag

1. Fail a `testing` task back to `in_progress` via `fail_task`. Inspect:
   ```
   sqlite3 ... "SELECT id, status, is_failed, status_reason FROM tasks WHERE id = '<id>';"
   ```
   **Expect:** `is_failed = 1`, `status_reason` starts with `Failed:`.

2. Attempt `update_task_status(new_status='done')` while `is_failed=1`.
   **Expect:** `cannot_mark_done` with reason starting `code:task_marked_failed`.

3. Re-progress the task forward (in_progress → testing → review → done). Inspect after each forward transition.
   **Expect:** `is_failed` flips to `0` on the first forward transition; `status_reason` cleared at the same time.

4. **Backfill spot-check** on any pre-migration tasks:
   ```
   sqlite3 ... "SELECT COUNT(*) FROM tasks WHERE status_reason LIKE 'Failed:%' AND is_failed = 0;"
   ```
   **Expect:** `0` — the migration's backfill should have caught all of them.

### 4. #117 — Role souls + gate config + dispatch injection

1. **Static check on this repo's gate config:**
   ```
   cat .mc/gates.json
   ```
   **Expect:** `build_fast` / `test_full` / `runtime_smoke` blocks are present.

2. **Dispatch a builder task** (any repo-backed product). Capture the message MC sends to the agent (debug log: `chat.send` outbound). Search for:
   - `📜 ROLE: BUILDER` header
   - The full `builder-soul.md` text
   - `🧪 PRESCRIBED VERIFICATION COMMANDS` section
   - `### build_fast (budget: 60s)`
   - `submit_evidence({...})` template with the agent_id and task_id pre-filled
   - `.mc/gates.json` source-line at the bottom (`Commands from /…/.mc/gates.json.`)

3. **Same for tester / reviewer** dispatches. Confirm:
   - Tester sees `test_full` and (if the repo has it) `runtime_smoke`.
   - Reviewer sees ROLE: REVIEWER and **no** prescribed commands (judgment gate only).

4. **Auto-discovery test:** point a product at a repo without `.mc/gates.json` but with a `package.json` containing `"test": "jest"`. Dispatch and confirm the message says "Commands auto-discovered from package.json" and prescribes `yarn test`.

5. **Lockfile detection:** swap `yarn.lock` for `pnpm-lock.yaml` in a test fixture (or a scratch repo) and confirm the auto-discovered command becomes `pnpm test`.

### 5. #118 — Strict workspace isolation

1. **Builder happy path:** dispatch a fresh repo-backed builder task. Inspect the task row:
   ```
   sqlite3 ... "SELECT workspace_path, workspace_strategy, workspace_port FROM tasks WHERE id = '<id>';"
   ```
   **Expect:** populated; `existsSync(workspace_path)` returns true.

2. **Builder re-dispatch:** dispatch the same task again (e.g. simulate a Tester→Builder bounce). Tail the MC log.
   **Expect:** `[Dispatch] builder reusing workspace for ...` (no `Created`).

3. **Forced failure:** rename or chmod-deny the rsync target / projects path so `createTaskWorkspace` throws. Dispatch a fresh builder task.
   **Expect:** **HTTP 503** with body `{"error":"workspace_isolation_failed", "detail":"..."}`. **Confirm the task did not get dispatched** (no chat.send debug entry; `task.workspace_path` is still null).

4. **Tester without builder workspace:** manually `UPDATE tasks SET workspace_path = NULL` for a repo-backed task already in `testing`. Dispatch.
   **Expect:** **HTTP 409** with `error: 'no_workspace_for_quality_stage'`. The Tester is **not** allowed to silently exercise main.

5. **Tester reuses Builder workspace:** in the happy path from step 1, transition the task to `testing` and dispatch. Capture the message — the `🔒 ISOLATED WORKSPACE` block should show the same path the Builder used, with the new copy "this is the same tree the Builder produced".

### 6. #119 — Roll-call propagation

1. Initiate a rollcall from the master orchestrator UI (or via `initiateRollCall`). Verify entries land in `rollcall_entries` for each target.

2. **Without replying**, transition one of the targets' active tasks across a stage boundary so a fresh stage-isolated session is created. Dispatch.

3. Capture the dispatch message. **Expect:** a `📣 PENDING ROLL-CALLS` block listing the rollcall id with `roll_call_reply:<id>` in the body.

4. Have the agent (or you, manually) `send_mail` with the prescribed subject. Confirm `rollcall_entries.replied_at` populates and the entry no longer appears on the next dispatch.

5. **Expiry:** wait past the rollcall's `expires_at` (default 30s) and dispatch again. **Expect:** the section disappears (the helper filters expired sessions).

### 7. #120 — `runtime_kind` path resolution

1. **Default `host`:**
   ```
   sqlite3 ... "SELECT name, runtime_kind FROM agents LIMIT 5;"
   ```
   **Expect:** all rows show `runtime_kind = 'host'`.

2. **Flip an agent to container:**
   ```
   sqlite3 ... "UPDATE agents SET runtime_kind = 'container' WHERE id = '<id>';"
   ```

3. **Dispatch a task to that agent.** Capture the dispatch message and grep for the `DELIVERABLES DIR` line.
   **Expect:** the path uses the value of `MC_DELIVERABLES_CONTAINER_PATH` (typically `/app/workspace/...`), not the host path.

4. Flip back to `host` and re-dispatch. **Expect:** path returns to `/Users/...`.

5. **Negative check:** try to set `runtime_kind = 'lambda'` — the CHECK constraint should reject it.

## End-to-end replay: re-run an autonomous convoy

This is the load-bearing validation. Pick a small surface change (e.g. tweak a label or constant) and run the full Builder → Tester → Reviewer convoy. The success criteria mirror the original post-mortem failure modes:

| Post-mortem behavior | Now-required behavior |
|----------------------|----------------------|
| Builder shipped `TASK_COMPLETE` with no real verification | Builder transition to `testing` rejected without a passing `build_fast` evidence row |
| Builder imported component but never rendered | Builder must register a `wiring_trace` deliverable per `builder-soul.md` |
| Reviewer's `yarn test` SIGKILLed → fell back to "static OK" | Reviewer doesn't run tests at all (per `reviewer-soul.md`); bounces to Tester if `test_full` is missing |
| Tester wrote `/app/workspace/...` screenshot, ENOENT | Dispatch path matches `agent.runtime_kind` |
| All sessions replied with `rollcall_matched: false` | Pending roll-calls surface on every dispatch via `formatPendingRollcallsForDispatch` |
| Builder ran on `main` because isolation silently fell back | Repo-backed builder failure is HTTP 503; Tester without workspace_path is HTTP 409 |
| `agent_not_coordinator` on first `get_task` | (FM4 was a misattribution — `get_task` has no ACL gate; spot-check by calling it from any assigned agent) |
| Stale `status_reason` survived forward transitions | `is_failed` flag clears on forward transition; `status_reason` becomes purely descriptive |

**Concrete e2e steps:**
1. Pick a trivial UI change (e.g. modify a string in a component).
2. Create a task with full Builder/Tester/Reviewer workflow.
3. Dispatch the Builder. Watch:
   - `[Dispatch] builder created workspace ...` log line
   - Builder receives a message with role soul + `.mc/gates.json` prescribed commands
   - Builder runs `yarn tsc --noEmit && yarn eslint <changed>` and submits via `submit_evidence`
   - Builder registers `wiring_trace` deliverable
   - Builder transitions to `testing` — gate admits because `build_fast` passed
4. Dispatch the Tester. Watch:
   - Same workspace path as Builder (reused)
   - Tester runs `yarn test`, submits `test_full` evidence
   - Tester runs a Playwright/preview exercise, submits `runtime_ui` with screenshot artifact
   - Transition to `review` admitted
5. Dispatch the Reviewer. Watch:
   - No prescribed commands in dispatch
   - Reviewer reads diff + Tester's evidence rows
   - Submits `review_static` notes
   - Transitions to `done`

If any step regresses, the per-PR rollback signal in the section above tells you which surface to inspect.

## Rollback plan

Each PR is independently revertable on `main`:
```
git revert <merge-sha>
```
Order doesn't matter for #115 / #116. For #117–#120, revert in **reverse merge order** since later PRs build on earlier ones (e.g. dispatch path changes stack).

Migrations 058–060 are non-destructive (additive columns / new tables) — reverting the code keeps the column but stops using it. To purge the schema additions you'd need a 061 migration; not recommended.

## After validation

If everything passes:
- Set `runtime_kind = 'container'` on Docker-bound openclaw workers (operator action).
- Add `.mc/gates.json` to every product repo whose autopilot will run autonomously. The default discovery from `package.json` works but is conservative.
- Move on to the worker-side budget enforcement (deferred per spec — openclaw repo, not MC).

If something fails: capture the failing step's evidence (DB row, debug log, dispatch message) and we'll triage by PR.
