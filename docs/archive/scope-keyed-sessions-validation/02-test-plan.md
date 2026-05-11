# Test Plan — Scope-Keyed Sessions

> **Purpose:** Concrete dispatch scenarios that exercise every flow in
> the architecture. Each scenario describes setup, action, observation,
> and what to capture for the validation criteria.

> **Pre-requisite:** [`01-pre-check-initialization.md`](01-pre-check-initialization.md)
> completed with overall status `READY FOR TEST PLAN`.

> **Companion:** [`03-validation-criteria.md`](03-validation-criteria.md)
> for pass/fail thresholds.

> **All real-agent dispatches use `spark-lb/agent` per
> `~/.claude/projects/.../memory/project_openclaw_model.md` —
> self-hosted, no budget cap, run as many rounds as needed.**

> **Convention:** every scenario captures its raw transcript to
> `/tmp/mc-validation/<phase>/<scenario_id>/` for forensic review.

---

## Scenario taxonomy

Scenarios are grouped by the dispatch path they exercise:

- **§1 Disruption** — operator drops a disruption into PM Chat.
- **§2 Plan a draft initiative** — multi-turn refine loop.
- **§3 Decompose** — initiative and story.
- **§4 Notes intake** — operator pastes meeting notes.
- **§5 Task dispatch** — builder/tester/reviewer cycle.
- **§6 Recurring jobs** — researcher on a 2-day cadence (compressed).
- **§7 Heartbeat coordinator** — opt-in observational check-ins.
- **§8 Notes observability** — SSE → UI surfaces fire correctly.
- **§9 Failure modes** — gateway down, ambiguous identity, briefing overflow.
- **§10 Regression** — bugs we've already fixed must stay fixed.

Each scenario runs in **~5 minutes max** real-agent time. Total wall
clock for the full plan is ~90 minutes.

---

## §1 Disruption

### S1.1 Owner-out disruption produces correct shift proposal

**Setup:**
- FOIA workspace from pre-check.
- Seed a worker named "Sarah" as owner of "Agency Profile Schema & Data Model".
  ```sql
  INSERT INTO agents (id, name, role, workspace_id, is_active)
  VALUES ('sarah-uuid', 'Sarah', 'worker', :foia_id, 1);
  UPDATE initiatives SET owner_agent_id = 'sarah-uuid'
  WHERE workspace_id = :foia_id
    AND title = 'Agency Profile Schema & Data Model';
  ```

**Action:** POST a chat message to the FOIA PM Chat:
> "Sarah is out 2026-05-20 to 2026-05-25"

**Observe:**
- Synth placeholder lands within 1 second (UI shows draft proposal).
- Within 30s, the placeholder is *superseded* by the agent's structured proposal (SSE event `pm_proposal_replaced`).
- The accepted proposal contains:
  - 1 `add_availability` diff for Sarah, 2026-05-20 to 2026-05-25.
  - At least 1 `set_initiative_status` or `shift_initiative_target` diff for the initiative she owns (if her absence overlaps with target window).
  - `impact_md` references "Sarah" and the initiative title verbatim.

**Capture:**
- The placeholder row id and the agent row id.
- Time to supersede.
- Full impact_md.
- Any notes the agent took during dispatch (`agent_notes` rows where `scope_key` matches the dispatch).

### S1.2 Disruption with no actionable content

**Action:** Send the literal string "Test" to PM Chat.

**Observe:**
- Synth placeholder ("No structured changes inferred") lands.
- Agent supersedes with a proposal that has `changes: []` and `impact_md` describing why nothing was actionable.

**Halt criterion:** if the agent stalls past 60s (the bug we just fixed), the regression returned. Hard fail.

### S1.3 Refine a draft proposal

**Action:**
- After S1.1 lands, POST to `/api/pm/proposals/<id>/refine` with `additional_constraint: "Don't slip Discovery — defer Cache Persistence instead"`.

**Observe:**
- A new proposal row lands within 30s with `parent_proposal_id = <S1.1 id>`.
- The refined `changes` reflect the constraint (Discovery's `target_end` unchanged; Cache Persistence shifted).
- The session key for refine matches S1.1's session key (continuity).

---

## §2 Plan a draft initiative

### S2.1 Plan a fresh initiative draft

**Action:**
- Create a draft initiative in the FOIA workspace with title "Public-records analytics dashboard" and minimal description.
- POST `/api/pm/plan-initiative` with `initiative_id` and a one-line guidance ("Goal: weekly insights from incoming requests").

**Observe:**
- Within 60s a `pm_proposals` row with `trigger_kind='plan_initiative'` lands.
- `plan_suggestions` field populated with all required keys: `refined_description`, `complexity` ∈ {S,M,L,XL}, `target_start`, `target_end`, `status_check_md`, `dependencies`.
- `proposed_changes` is `[]` (advisory only).
- `refined_description` is meaningfully different from input (length > 3x input).

### S2.2 Refine the plan twice

**Action:**
- POST refine: `additional_constraint: "Make this M-sized, not L"`.
- POST refine again: `additional_constraint: "Add a dependency on Implementation for FOIA Request Pipeline"`.

**Observe:**
- Each refine produces a new proposal with `parent_proposal_id` chain back to S2.1.
- All three proposals share the same `planSessionKey` in dispatch (verify via `mc_sessions.scope_key`).
- Refine 2's `dependencies` array includes the Implementation initiative id.
- Each refine completes in <60s.

**Capture:** the chain length and all three impact_md/plan_suggestions.

---

## §3 Decompose

### S3.1 Decompose an epic into stories

**Action:** POST `/api/pm/decompose-initiative` with the FOIA epic
"Discovery for FOIA Request Pipeline" and guidance "We have 7 stories
already; suggest if any are missing."

**Observe:**
- A `pm_proposals` row with `trigger_kind='decompose_initiative'` lands within 90s.
- `proposed_changes` contains one or more `create_child_initiative` diffs OR an empty array if the agent finds the existing 7 stories complete (acceptable).
- `impact_md` explains the agent's reasoning (covers what's missing or confirms completeness).

### S3.2 Decompose a story into tasks

**Action:** POST `/api/pm/decompose-story` with story "Agency Profile
Schema & Data Model" and guidance "Need a backend slice and a UI slice".

**Observe:**
- A `pm_proposals` row with `trigger_kind='decompose_story'` lands.
- `proposed_changes` contains ≥2 `create_task_under_initiative` diffs.
- Tasks have non-trivial `description` fields (>50 chars each).

---

## §4 Notes intake

### S4.1 Operator pastes meeting notes

**Action:** Call MCP tool `propose_from_notes` directly with a 600-word
meeting transcript covering FOIA work:

> "Stand-up notes Monday: Sarah's done with the agency schema, ready
> for review. Statute lookup is blocked on the lawyer review — Mike's
> chasing it. Email intake detection: Jen prototyped via SpamAssassin
> rules; works for ~80% of agencies. Cache persistence: Dan has a draft
> design, will share Wednesday. Fee policy: nothing yet, low priority.
> Verification harness: blocker — we need a test fixture set."

**Observe:**
- A `pm_proposals` row with `trigger_kind='notes_intake'` lands within 90s.
- `proposed_changes` is heterogeneous: some `set_initiative_status` ('blocked' for statute lookup), maybe a `create_task_under_initiative` for the test fixture set.
- `impact_md` summarizes what was extracted.

### S4.2 Notes intake with gateway down

**Setup:** Stop the openclaw gateway (`kill $(lsof -ti :18789)`).

**Action:** Same as S4.1.

**Observe:**
- The MCP call returns an error (allowFallback=false → throws PmDispatchGatewayUnavailableError).
- A `pm_pending_notes` row is enqueued (verify in DB).
- Restart openclaw, wait 60s for the drain → the queued note dispatches and lands a proposal.

**Halt criterion:** if the queued note doesn't drain within 90s of gateway restart.

---

## §5 Task dispatch (worker stages)

### S5.1 Builder dispatch on a story task

**Setup:**
- Pick story "Cache Persistence & Query Layer".
- Use `decompose_story` (S3.2) to seed it with one builder task.
- Promote the task `draft → inbox → assigned` and assign to the synthetic builder.

**Action:** POST `/api/tasks/<task_id>/dispatch`.

**Observe:**
- Within 90s, the task transitions through: `assigned → in_progress`.
- Builder calls `take_note` ≥3 times during work (verify `agent_notes` rows tagged with the builder's scope_key).
- Builder calls `register_deliverable` ≥1 time.
- Builder calls `log_activity(activity_type='completed')` before transitioning.
- Builder transitions to `review` (or `testing` if the workflow demands that).

**Note quality:**
- ≥1 `kind='discovery'` or `decision`.
- ≥1 `kind='breadcrumb'` with `audience='next-stage'`.
- All notes have non-empty `attached_files` when discussing code.

### S5.2 Tester dispatch on the same task

**Action:** Tester picks up the task post-builder (or operator dispatches manually).

**Observe:**
- Tester reads the builder's notes via `read_notes(task_id)` (verify in MCP call log).
- Tester calls `mark_note_consumed` for each builder breadcrumb it processes.
- Tester takes its own notes (≥2).
- Tester transitions task to `review`.

### S5.3 Reviewer dispatch and rejection

**Action:** Reviewer picks up; we'll script a forced rejection scenario by injecting a known issue in the deliverable.

**Observe:**
- Reviewer calls `read_notes` first (audience='next-stage' OR 'reviewer').
- Reviewer takes a `kind='blocker'` or `decision` note explaining the rejection.
- Reviewer calls `fail_task` with a reason.
- Task transitions back to `in_progress` for re-dispatch.

### S5.4 Builder retry attempt 2 (Q3 A/B sample)

**Action:** Re-dispatch the builder. Per `agent_role_overrides.attempt_strategy`:
- If `fresh`: scope key segment increments to `:builder:2`, agent gets a fresh briefing including reviewer's notes.
- If `reuse`: same `:builder:1` key, agent sees its own prior reasoning.

**Observe:**
- Verify `mc_sessions` row for the new attempt.
- Verify the briefing includes reviewer's blocker note.
- Verify the second attempt completes (transition to `review`).

**Capture for Q3 decision:**
- Time-to-deliverable per strategy.
- Number of `take_note` calls per strategy.
- Whether the second attempt repeats the prior approach (failed) or chose a different one.

---

## §6 Recurring jobs

### S6.1 Create a recurring researcher job

**Action:**
- POST `/api/recurring-jobs` for a job:
  - `role: 'researcher'`
  - `name: "Watch DGX Spark forum for new posts"`
  - `cadence_seconds: 60` (compressed for testing — production would be 172800)
  - `briefing_template: "Check /tmp/synthetic-forum.txt for new lines since last run. Report any deltas via take_note(kind='observation', audience='pm', task_id=<linked>)."`
  - `task_id: <linked task in FOIA workspace>`

**Setup:**
- Pre-create `/tmp/synthetic-forum.txt` with 5 lines.

**Action timeline:**
- T+0: trigger job manually (skip the cadence wait).
- T+0+30s: append 2 new lines to the file.
- T+0+60s: scheduler should fire the second run.

**Observe:**
- Run 1 produces ≥1 note describing the initial 5 lines.
- Run 2 produces ≥1 note describing the 2 new lines.
- Both runs share the same scope_key (since `attempt_strategy='reuse'`).
- `recurring_jobs.run_count` is 2; `last_run_at` and `next_run_at` updated.

**Halt criterion:** Run 2 not firing within 90s of cadence elapsing → scheduler is broken.

### S6.2 Recurring job with no new data

**Action:** After S6.1, trigger Run 3 without changing the file.

**Observe:** Researcher takes a note `kind='observation', body='No new posts since last check'`. Don't penalize the silence.

### S6.3 Recurring job failure escalation

**Setup:** Make the briefing template invalid (e.g., reference a non-existent file).

**Action:** Trigger 3 consecutive runs (force-trigger).

**Observe:**
- Each run fails (the agent reports it can't find the file via a note `kind='blocker'`).
- After 3 consecutive failures, `recurring_jobs.status` flips to `paused`.
- An `importance: 2` note auto-posts to PM Chat.

---

## §7 Heartbeat coordinator

### S7.1 Enable heartbeat on a task and verify check-ins

**Action:**
- Set `tasks.coordinator_mode = 'heartbeat'` on the in-progress task from S5.1.
- Set `coordinator_heartbeat_seconds = 60`.

**Observe over 5 minutes:**
- 4–5 coordinator dispatches fire (one every 60s).
- Each dispatch produces ≥1 note. Most should be `kind='observation', body~"ok"` or similar.
- If the underlying task hasn't moved in 2 cycles, coordinator takes a `kind='question', audience='pm'` or `importance:2` escalation note.

### S7.2 Heartbeat auto-removal on task completion

**Action:** Force the underlying task to `status='done'`.

**Observe:**
- The heartbeat `recurring_jobs` row flips to `status='done'` (or is deleted, depending on impl choice).
- No further coordinator dispatches fire after the task completes.

---

## §8 Notes observability

### S8.1 SSE → Task detail rail

**Setup:** Open `/workspace/foia/tasks/<task_id>` in a headless browser (or use the API directly).

**Action:** Trigger an agent dispatch that takes a note for that task.

**Observe:**
- Within 2 seconds of the `take_note` MCP call, the task detail page receives an SSE `agent_note_created` event with matching `task_id`.
- The Notes Rail component shows the new note (verify via `preview_*` snapshot).

### S8.2 SSE → Initiative rollup

**Action:** Take a note on a task that's a child of an initiative. View `/workspace/foia/initiatives/<initiative_id>`.

**Observe:**
- The initiative panel shows the note in its rollup (filtered by `task_id IN getInitiativeTaskIds(initiative_id)`).

### S8.3 SSE → Workspace feed

**Action:** Open `/feed?workspace_id=<foia>` (or its real path post-Phase-D). Trigger 5 notes across different tasks.

**Observe:**
- All 5 notes appear in the feed.
- Filter chips work (filter by `kind='blocker'` shows only blockers, etc.).

### S8.4 SSE → PM Chat for importance=2

**Action:** Have an agent take a note with `importance: 2`.

**Observe:**
- Within 2 seconds, the FOIA workspace's PM Chat shows an assistant-role message with the note's body and a "(from <role>)" attribution.

### S8.5 Card badge updates

**Action:** Open the task list view at `/tasks?workspace_id=<foia>`. Trigger 3 notes on one task.

**Observe:**
- That task's card badge updates from "0 notes" → "1 note" → "2" → "3" without a page refresh.
- Timestamp updates to the most recent note's timestamp.

---

## §9 Failure modes

### S9.1 Gateway down on dispatch

**Setup:** `kill $(lsof -ti :18789)`.

**Action:** Send a disruption to PM Chat.

**Observe:**
- Synth placeholder lands.
- `dispatch_state='synth_only'` (no background reconciler runs).
- Operator can still accept the synth proposal manually if they want.

### S9.2 Gateway recovers during dispatch

**Setup:** Start dispatch, then immediately kill the gateway, then restart it 10s later.

**Observe:**
- The reconciler re-attempts during the 60s tail window.
- If the gateway came back fast enough, the agent's proposal still supersedes.
- Otherwise: synth_only as in S9.1.

### S9.3 Briefing overflow

**Setup:** Force a task with 200+ notes.

**Action:** Dispatch a builder for that task.

**Observe:**
- Briefing builder caps notes at 50, oldest-first truncation.
- Total briefing < 12,000 chars.
- The agent does NOT see the older notes (verify via tool call log: it reads only the truncated set).
- Truncation is logged as a metric.

### S9.4 Ambiguous gateway_agent_id (the bug we fixed)

**Setup:**
- Manually insert a second `agents` row with `gateway_agent_id='mc-runner-dev'` in a different workspace.

**Action:** Trigger any dispatch.

**Observe:**
- The identity preamble in the briefing carries the correct workspace's UUID.
- The agent does NOT call `whoami({ agent_id: 'mc-runner-dev' })` — it uses the UUID directly.
- If the agent does call `whoami`, the response is `ambiguous_gateway_id` but the agent already has its UUID and proceeds anyway.

**Cleanup:** delete the inserted row.

---

## §10 Regression tests

### S10.1 The PM dispatch ambiguity bug stays fixed

Verified by S9.4. Additionally:

```bash
# Inspect the dispatch session's first message — must include "Your agent_id is".
sqlite3 mission-control.db \
  "SELECT trigger_text FROM pm_proposals
   WHERE workspace_id = '<foia>'
   ORDER BY created_at DESC LIMIT 1;"
```

The dispatch message in openclaw's session log must contain the
identity preamble lines.

### S10.2 cloneAgentsFromWorkspace leaves no broken refs

**Action:** Create a new workspace via POST `/api/workspaces` with `clone_agents_from = <foia_id>`.

**Observe:**
- New workspace has its own PM placeholder.
- No worker rows are cloned (post-Phase-F: cloning is no-op for non-PM).
- The new workspace can dispatch without the ambiguity error.

### S10.3 Workspace switcher preserves current page (PR #131)

**Action:** Navigate to `/workspace/foia/initiatives/<id>`. Switch workspace via the switcher to `default`.

**Observe:** URL becomes `/workspace/default/initiatives` (preserving the page type). No 404.

### S10.4 Drawer portals (PR #134)

**Action:** Open a side drawer that has a sub-modal (e.g., Edit Initiative → Confirm).

**Observe:** Inner modal is portalled to body, not trapped offscreen.

### S10.5 PR #136 — agent-catalog-sync handles duplicates

**Action:** Run `/api/agents/sync` while two `agents` rows share `gateway_agent_id`.

**Observe:** Both rows get the gateway-truth values via `WHERE gateway_agent_id = ?` (not Map collapse). Verify via the `model` column on both rows.

---

## Run instructions

A test plan executor must:

1. Run pre-check ([`01-pre-check-initialization.md`](01-pre-check-initialization.md)).
2. For each scenario in order:
   a. Create `/tmp/mc-validation/<phase>/<scenario_id>/`.
   b. Capture pre-action DB state to `pre.sql`.
   c. Execute the action.
   d. Wait for terminal state (or timeout per scenario).
   e. Capture post-action DB state to `post.sql`, openclaw session trajectory to `trajectory.jsonl`, dev log slice to `dev.log`, MCP tool call log to `mcp.log`, SSE captures to `sse.log`.
   f. Append result to `/tmp/mc-validation/<phase>/test-plan-result.md`:
      ```markdown
      ## <scenario_id>: <name>
      Status: PASS / FAIL / FLAKE
      Duration: <s>
      Observations: <one-paragraph>
      Failures: <bullet list, if any>
      Capture path: /tmp/mc-validation/<phase>/<scenario_id>/
      ```
3. After all scenarios run, compute summary against
   [`03-validation-criteria.md`](03-validation-criteria.md).
4. Halt if total `FAIL` count > 0.

**Real-agent runtime budget:** ≤ 90 minutes wall-clock for the full
plan. If a scenario hangs past its cap (per scenario), kill it and mark
`FLAKE` rather than waiting forever.

**Dispatch via `spark-lb/agent`:** every real-agent dispatch in this
plan uses the self-hosted load-balanced model. No external API calls.
