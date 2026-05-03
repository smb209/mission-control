# Pre-Check Initialization — Scope-Keyed Sessions

> **Purpose:** Before running the test plan at any milestone, bring the
> dev environment to a known-good baseline. This file is the runbook;
> every step has a concrete command and an expected output. If any
> check fails, **halt** and surface the failure in the observations
> log — do not skip steps.

> **Scope:** This is a **destructive** runbook (wipes the dev DB).
> Never execute it while the operator is actively using the dev server
> at `localhost:4010` or `192.168.50.95:4010`. Confirm the operator
> has signed off before running.

> **Companion files:** [`02-test-plan.md`](02-test-plan.md),
> [`03-validation-criteria.md`](03-validation-criteria.md).

---

## 0. Prerequisites

| Check | Command | Expected |
|---|---|---|
| Repo clean | `git status --porcelain` | empty |
| On feature branch | `git rev-parse --abbrev-ref HEAD` | not `main` |
| Spec exists | `test -f specs/scope-keyed-sessions.md && echo ok` | `ok` |
| Dev server stopped | `lsof -ti :4010 \|\| echo none` | `none` (or kill it: `kill $(lsof -ti :4010)`) |
| Openclaw gateway running | `lsof -ti :18789 \|\| echo none` | non-empty |
| `spark-lb/agent` model reachable | `curl -sS http://localhost:18789/health \|\| true` | non-error |

If any prerequisite fails, fix it before continuing. **Especially** the
dev-server-stopped check — wiping the DB while Next.js holds a
connection corrupts the WAL.

---

## 1. Wipe and reseed the dev DB

```bash
cd /Users/snappytwo/snappytwo-sandbox/mission-control

# Drop the dev database. The /dev-sync skill is canonical for this:
#   wipes mission-control.db, syncs agents from openclaw,
#   imports prod data with mc-* → mc-*-dev remap.
# We run a stricter version — no prod data import, just a clean slate.

rm -f mission-control.db mission-control.db-shm mission-control.db-wal
yarn db:seed
```

**Expected:**
- `mission-control.db` recreated (size > 0).
- All migrations run to head (count line in seed log: `[DB] Migration NNN completed` for each).
- Default workspace exists, no other workspaces.

**Validation:**
```bash
sqlite3 mission-control.db "SELECT count(*) FROM workspaces;"  # expect 1
sqlite3 mission-control.db "SELECT count(*) FROM agents;"       # expect 0 or 1 (PM placeholder per workspace)
sqlite3 mission-control.db "SELECT MAX(version) FROM migration_history;"  # expect latest applied
```

---

## 2. Verify migrations include this spec's additions

After Phase A, the schema must include:

```bash
sqlite3 mission-control.db ".schema agent_role_overrides" \
  | grep -q "soul_md" && echo "agent_role_overrides ok" || echo "FAIL"

sqlite3 mission-control.db ".schema agent_notes" \
  | grep -q "run_group_id" && echo "agent_notes ok" || echo "FAIL"

sqlite3 mission-control.db ".schema mc_sessions" \
  | grep -q "scope_key" && echo "mc_sessions ok" || echo "FAIL"

sqlite3 mission-control.db ".schema recurring_jobs" \
  | grep -q "cadence_seconds" && echo "recurring_jobs ok" || echo "FAIL"
```

**Halt if any prints `FAIL`.** Pre-Phase-A baselines will fail this
check as expected — record that as the baseline, don't treat it as a
test failure.

---

## 3. Sync agents from openclaw

```bash
# Start the dev server (briefly, just to drive the sync).
PORT=4010 yarn dev > /tmp/mc-dev.log 2>&1 &
DEV_PID=$!

# Wait for the gateway to connect.
for i in {1..30}; do
  curl -sS http://localhost:4010/api/agents 2>/dev/null \
    | grep -q "mc-runner" && break
  sleep 1
done

# Force a sync.
curl -sS -X POST http://localhost:4010/api/agents/sync \
  -H "Content-Type: application/json" -d '{}'
```

**Expected agents table after Phase F:**

```
sqlite3 -header mission-control.db \
  "SELECT id, name, gateway_agent_id, source, is_pm
     FROM agents
    ORDER BY workspace_id, name;"
```

Should return only:

| name | gateway_agent_id | source | is_pm |
|---|---|---|---|
| `mc-runner-dev` | `mc-runner-dev` | `gateway` | 0 |
| `Project Manager` (per workspace) | NULL | `local` | 1 |

**Pre-Phase-F baseline** will additionally show: `mc-builder-dev`,
`mc-coordinator-dev`, `mc-tester-dev`, `mc-reviewer-dev`,
`mc-writer-dev`, `mc-researcher-dev`, `mc-learner-dev`,
`mc-project-manager-dev`. Record this as the baseline; do not treat
as failure pre-migration.

**Halt criterion:** if `mc-runner-dev` is NOT in the list at any phase,
that's a real failure — the gateway-bound source agent is missing.

---

## 4. Confirm openclaw connection

```bash
# The /api/health/openclaw endpoint should report connected=true.
curl -sS http://localhost:4010/api/health/openclaw | tee /tmp/openclaw-health.json
```

**Expected fields:**
- `connected: true`
- `gateway_url: "ws://127.0.0.1:18789"`
- `agent_count: ≥1`

If `connected: false`: check openclaw is running (`lsof -ti :18789`),
restart if needed, retry the sync, halt if still failing.

---

## 5. Verify role templates load

```bash
ls agent-templates/                         # expect: _shared, builder, coordinator, learner, pm, researcher, reviewer, runner-host, tester, writer
ls agent-templates/_shared/                 # expect: messaging-protocol.md, notetaker.md, shared-rules.md
test -f agent-templates/builder/SOUL.md && echo "builder template ok"
test -f agent-templates/runner-host/SOUL.md && echo "runner-host template ok"
```

**Pre-Phase-A baseline:** `agent-templates/` doesn't exist; record as
baseline. Phase A creates the directory + seeds it.

---

## 6. Load the FOIA initiative tree

The FOIA tree is the canonical fixture for dispatch tests. It exercises
all scopes (initiatives, epics, stories, tasks) at meaningful depth.

```bash
# A new fixture script seeds the tree under a 'foia' workspace.
yarn tsx scripts/seed-foia-fixture.ts
```

**The script must:**
1. Create a workspace named `FOIA` with slug `foia`.
2. Insert one milestone: "FOIA Request Pipeline" (target_end 90d out).
3. Insert one epic: "Discovery for FOIA Request Pipeline" (parent: milestone).
4. Insert seven stories under the epic, mirroring the production fixture seen in dispatch traces:
   - "Agency Profile Schema & Data Model"
   - "Governing Statute & Records Officer Lookup"
   - "Intake Channel Detection (Email, Portal Form, Mail)"
   - "Fee Policy & Statutory Response Deadline Extraction"
   - "Profile Validation & Screenshot Evidence"
   - "Cache Persistence & Query Layer"
   - "Verification for FOIA Request Pipeline"
5. Insert "Implementation for FOIA Request Pipeline" as a sibling story to the epic above.
6. Print the workspace_id and tree summary on stdout.

**Validation:**
```bash
WS_ID=$(sqlite3 mission-control.db "SELECT id FROM workspaces WHERE slug='foia';")
echo "FOIA workspace_id: $WS_ID"
sqlite3 mission-control.db \
  "SELECT kind, status, title FROM initiatives WHERE workspace_id='$WS_ID' ORDER BY kind, title;"
```

Expect 1 milestone, 1–2 epics, ≥7 stories, all `status='planned'`.

**Halt criterion:** if the script fails or the tree shape doesn't match,
the rest of the test plan can't run — halt.

---

## 7. Confirm SSE channel up

```bash
# Open the SSE stream for the FOIA workspace and capture for 5 seconds.
timeout 5 curl -sN \
  -H "Accept: text/event-stream" \
  "http://localhost:4010/api/sse?workspace_id=$WS_ID" \
  > /tmp/sse-precheck.log || true

grep -q "event: connected\|event: heartbeat" /tmp/sse-precheck.log \
  && echo "SSE ok" || echo "FAIL"
```

**Halt criterion:** if SSE is dead, observability tests in
[`02-test-plan.md`](02-test-plan.md) §4 can't run.

---

## 8. Confirm MCP tools enumerate

```bash
# The MCP server should list all tools, including the notes family
# after Phase A.
curl -sS http://localhost:4010/api/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MC_API_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | tee /tmp/mcp-tools.json | jq -r '.result.tools[].name' | sort > /tmp/mcp-tool-names.txt
```

**Expected (post Phase A):**
- `whoami`, `propose_changes`, `log_activity`, `register_deliverable`, `update_task_status`, `save_checkpoint`, `send_mail`, `fetch_mail`, `list_peers`, `get_task` (existing).
- `take_note`, `read_notes`, `mark_note_consumed`, `archive_note` (new in Phase A).
- `propose_from_notes`, `refine_proposal`, `spawn_subtask`, `cancel_subtask`, `accept_subtask`, `reject_subtask` (existing).

```bash
diff <(cat /tmp/mcp-tool-names.txt) \
     <(printf "accept_subtask\narchive_note\ncancel_subtask\nfetch_mail\nget_task\nlist_peers\nlog_activity\nmark_note_consumed\npropose_changes\npropose_from_notes\nread_notes\nrefine_proposal\nregister_deliverable\nreject_subtask\nsave_checkpoint\nsend_mail\nspawn_subtask\ntake_note\nupdate_task_status\nwhoami\n")
```

**Pre-Phase-A baseline:** the four notes tools are missing. Record as
baseline.

---

## 9. Confirm baseline pages render

UI smoke. Fast — used to catch broken builds before running real-agent
dispatches that take minutes each.

```bash
# Each of these should return HTTP 200 in <2s.
for path in / /pm /tasks /agents /feed /workspace/foia/initiatives; do
  status=$(curl -sS -o /dev/null -w "%{http_code} %{time_total}\n" \
    "http://localhost:4010$path")
  echo "$path -> $status"
done
```

`/feed` is new in Phase D; pre-Phase-D baseline returns 404, that's
expected.

---

## 10. Snapshot baseline state

Capture state for diff against post-test-plan state:

```bash
mkdir -p /tmp/mc-validation/baseline
sqlite3 mission-control.db ".dump" > /tmp/mc-validation/baseline/db-dump.sql
cp /tmp/mc-dev.log /tmp/mc-validation/baseline/dev.log
ls -la /tmp/mc-validation/baseline/
```

This snapshot lets the test plan compare "what was inserted by the
test" vs "what existed before".

---

## 11. Stop the dev server

```bash
kill $DEV_PID 2>/dev/null
wait $DEV_PID 2>/dev/null || true
```

Pre-check complete. Proceed to [`02-test-plan.md`](02-test-plan.md).

---

## Pre-check Result Summary Template

When running this checklist, append to `/tmp/mc-validation/precheck-result.md`:

```markdown
# Pre-Check Result — <date> <commit>

| Step | Status | Notes |
|---|---|---|
| 0. Prerequisites | PASS / FAIL | … |
| 1. Wipe and reseed | PASS / FAIL | <NNN migrations applied> |
| 2. Spec migrations present | PASS / FAIL / N/A (pre-Phase-A) | … |
| 3. Agent sync | PASS / FAIL | <list of synced agents> |
| 4. Openclaw connection | PASS / FAIL | … |
| 5. Role templates | PASS / FAIL / N/A (pre-Phase-A) | … |
| 6. FOIA tree loaded | PASS / FAIL | <workspace_id, tree summary> |
| 7. SSE channel | PASS / FAIL | … |
| 8. MCP tools enumerate | PASS / FAIL | <list of present + missing> |
| 9. Baseline pages | PASS / FAIL | … |
| 10. Baseline snapshot | DONE | <paths> |
| 11. Cleanup | DONE | … |

**Overall:** READY FOR TEST PLAN / NEEDS REWORK / BLOCKED — <one-line reason>
```

If overall is `BLOCKED`, log the blocking issue and halt — do not run
the test plan against a degraded baseline.
