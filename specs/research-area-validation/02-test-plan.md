# Test Plan — Research Area Phase 1

> **Purpose:** Concrete real-agent scenarios exercising every Phase 1 surface. Each captures setup, action, observation, and evidence for [`03-validation-criteria.md`](03-validation-criteria.md).
>
> **Pre-requisite:** [`01-pre-check-initialization.md`](01-pre-check-initialization.md) completed with status `READY FOR TEST PLAN`.
>
> **All real-agent dispatches use `spark-lb/agent`** (per `project_openclaw_model.md` memory — self-hosted, no budget cap).
>
> **Convention:** every scenario captures its raw transcript and DB snapshot to `/tmp/mc-validation/research/<scenario_id>/`.

---

## Scenario taxonomy

- **§R1 Topic CRUD** — create, list, archive
- **§R2 One-shot brief (no topic)** — minimal flow
- **§R3 Topic-attached brief** — context propagation
- **§R4 Streaming progress** — SSE / activity-log signal during run
- **§R5 Failure handling** — agent error, malformed response, dispatched-session lost
- **§R6 Eval harness** — fixture briefs scored against rubric
- **§R7 UI surfaces** — hub dashboard, topic detail, brief detail
- **§R8 Cross-workspace isolation** — workspace A cannot see workspace B's topics/briefs
- **§R9 Regression** — bugs found during validation must stay fixed

Each scenario ≤ 5 min real-agent time. Total ≤ 60 min.

---

## §R1 — Topic CRUD

### R1.1 Create a topic via API
- **Setup:** `default` workspace selected
- **Action:** `POST /api/topics` with `{name: "GLP-1 regulation", description: "Watch for FDA actions and pricing pressure", tags: ["pharma", "regulation"]}`
- **Observe:**
  - HTTP 201, response body includes `id`, timestamps, `archived_at: null`
  - `sqlite3 $DATABASE_PATH "SELECT id, name, workspace_id FROM topics;"` → 1 row
- **Capture:** request, response, DB row → `/tmp/mc-validation/research/R1.1/`

### R1.2 List topics is workspace-scoped
- **Setup:** topic from R1.1 exists in `default`; create one in `foia`
- **Action:** `GET /api/topics` with each workspace header
- **Observe:** each call returns only that workspace's row
- **Capture:** both responses

### R1.3 Archive a topic
- **Action:** `DELETE /api/topics/:id` (soft-delete via `archived_at`)
- **Observe:** subsequent `GET /api/topics` does not include it; `GET /api/topics?include=archived` does
- **Capture:** before/after responses

---

## §R2 — One-shot brief (no topic)

### R2.1 Create + run a `general_brief` with no topic
- **Setup:** clean DB after R1
- **Action:**
  - `POST /api/briefs` with `{template: "general_brief", title: "What is the current state of WebGPU browser support?", prompt: "Survey WebGPU support across Chrome/Safari/Firefox as of today, including what's still behind flags."}` → returns `brief_id` + `agent_run_id`
  - `POST /api/briefs/:id/run` → kicks dispatch
- **Observe:**
  - Initial `agent_runs.status = queued`, then `running` within 5s
  - `research.brief.started` event in activity log within 5s of dispatch call
  - Brief completes within 5 min
  - `agent_runs.status = complete`
  - `briefs.result_md` non-empty, contains "Executive summary" / "Key findings" / "Citations" or similar (matches researcher SOUL output format)
  - `briefs.citations_json` is non-null with ≥ 1 citation (or YELLOW with explicit "no web access" note in result)
- **Capture:** brief detail page screenshot; raw `result_md`; DB row state at queued/running/complete; full event log

---

## §R3 — Topic-attached brief

### R3.1 Brief inherits topic context
- **Setup:** topic from R1.1 (GLP-1 regulation) present
- **Action:** `POST /api/briefs` with `{topic_id: <id>, template: "general_brief", title: "Q4 2025 FDA actions on GLP-1 drugs", prompt: "What FDA enforcement or guidance touched GLP-1 drugs in Q4 2025?"}`; then `POST /api/briefs/:id/run`
- **Observe:**
  - The dispatched prompt fed to the researcher includes the topic's `description` as context
  - Brief detail shows the topic linkage
- **Capture:** assembled prompt (log via dispatch debug or DB column if persisted), final `result_md`

---

## §R4 — Streaming progress

### R4.1 SSE events fire during run
- **Setup:** SSE consumer subscribed to `research.brief.*` filter on the workspace
- **Action:** dispatch any brief from R2/R3
- **Observe:**
  - `research.brief.started` within 5s of dispatch
  - At least one `research.brief.progress` event (token chunk or status heartbeat) before completion
  - `research.brief.completed` within 5s of `agent_runs.status = complete`
- **Capture:** SSE event sequence as JSON

---

## §R5 — Failure handling

### R5.1 Agent returns malformed response
- **Setup:** stub the researcher persona to return `<empty>` for one dispatch (use a test-only persona override or a deliberately malformed prompt)
- **Action:** dispatch; observe failure
- **Observe:** `agent_runs.status = failed`; `briefs.error_md` populated with a usable error string; `research.brief.failed` event emitted; brief detail UI shows the failure cleanly with a "Retry" button (button non-functional in phase 1 but visible)
- **Capture:** `error_md`, event payload, screenshot

### R5.2 Dispatch fails (gateway down)
- **Setup:** stop openclaw gateway temporarily
- **Action:** dispatch a brief
- **Observe:** brief enters `failed` quickly (≤ 30s); error message identifies gateway/connection issue clearly; no orphaned `running` rows after failure
- **Capture:** `error_md`, timing, no orphan check (`SELECT * FROM agent_runs WHERE status='running' AND started_at < datetime('now','-2 minutes')` → empty)
- **Cleanup:** restart gateway

---

## §R6 — Eval harness

### R6.1 Fixture run produces stable scores
- **Setup:** slice 5 landed; `yarn research:eval` script available; fixture topics + prompts checked in
- **Action:** run `yarn research:eval` end-to-end
- **Observe:** all fixture briefs complete, judge produces a per-brief score on each rubric axis (citations / structure / length), aggregate score reported, results saved to `tmp/research-eval/<run_id>/`
- **Capture:** the `tmp/research-eval/...` output dir, copied into `/tmp/mc-validation/research/R6.1/`

### R6.2 Eval rubric flags a deliberately bad brief
- **Setup:** seed the fixture set with one brief whose result we know to be poor (no citations, single sentence)
- **Action:** run eval
- **Observe:** rubric flags the bad brief with a low score on the relevant axes; aggregate score for the run is dragged down accordingly
- **Capture:** judge's per-axis scores for the bad fixture

---

## §R7 — UI surfaces

### R7.1 Hub dashboard
- **Action:** navigate to `/research`
- **Observe:** "In progress / Upcoming (placeholder for phase 1) / Recent results" lanes; topic library on left; SSE updates the in-progress lane live during a brief run
- **Capture:** screenshots before/during/after a brief run

### R7.2 Topic detail
- **Action:** navigate to `/research/topics/<id>`
- **Observe:** topic metadata; brief history list; "Run a brief" affordance with template chooser (only `general_brief` enabled)
- **Capture:** screenshot

### R7.3 Brief detail
- **Action:** navigate to `/research/briefs/<id>` for a complete brief
- **Observe:** rendered markdown body; citations panel; status; cost (if telemetry hooked up); "Re-run" button (non-functional in phase 1)
- **Capture:** screenshot

---

## §R8 — Cross-workspace isolation

### R8.1 Workspace A cannot read workspace B briefs
- **Setup:** brief in `default` (R2.1); separate brief in `foia`
- **Action:** `GET /api/briefs` against each workspace
- **Observe:** each call returns only its workspace's briefs; cross-workspace fetch by ID returns 404 or 403 (not 200)
- **Capture:** both responses

---

## §R9 — Regression

> Populated as bugs are found and fixed during phase 1 validation. Each entry: scenario ID + description + commit that fixed it. Re-runs must continue to pass.

(empty at start)
