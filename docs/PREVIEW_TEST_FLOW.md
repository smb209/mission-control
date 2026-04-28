# Preview Test Flow

A manual / Claude-driven walkthrough that exercises the primary user-facing surfaces (PM, Initiatives, Roadmap, Agents) against a **fresh database** and a **real openclaw gateway**. Designed to catch the kinds of regressions that unit + e2e tests miss — UX hangs, derivation drift, gateway-session breakage, stale resume drafts, and so on.

Each step is `Action: …` (what to do) + `Expected: …` (what should be true after). When run by Claude via `preview_*` MCP tools, treat the Expected line as the assertion: snapshot, screenshot, or eval to confirm it before moving on. When `Expected` references a count, button text, or row attribute, prove it from the snapshot — not from "looks right".

> **This doc is the source of truth.** If the UI changes, update this file in the same PR — out-of-date selectors silently degrade the test into "Claude clicked something."

---

## Preflight

| # | Action | Expected |
|---|---|---|
| P1 | Confirm the openclaw gateway is up: `curl -fsS http://localhost:18789/healthz` (or the configured gateway port) | HTTP 200 |
| P2 | Confirm Claude Preview is targeting Mission Control: `preview_list` shows a server pointing at this repo on port 4000/4001 | one running server |
| P3 | If a server isn't running, start it: `preview_start` with the `mission-control-real` config | server reaches `[ready]` in logs |

If the gateway isn't reachable, **stop here**: every flow below assumes the gateway path is the one being exercised. The defer-and-replay queue handles the offline case for `propose_from_notes` only; everything else just fails or falls back to deterministic synth, which is not what we're testing.

---

## Reset to a fresh database

| # | Action | Expected |
|---|---|---|
| R1 | `preview_stop` (or kill the dev server manually) — the dev server holds an open handle on `mission-control.db` and a hot reset will leave a stale WAL behind | server stops |
| R2 | `yarn db:reset` (wipes `mission-control.db` + sidecars, runs migrations on first DB access, then runs `db:seed`) | console prints `✅ Database seed complete (agents are gateway-synced; nothing else to seed).` |
| R3 | `preview_start mission-control-real` | server boots; `preview_logs` shows migration log lines (`[Migration NNN]`) and no error |
| R4 | Open `/agents` and confirm pages render before continuing | snapshot shows the **Agents** heading and the workspace switcher |

**Checkpoints.** Any time the doc says “save the DB as a checkpoint named X”, run:

```
preview_stop
yarn db:checkpoint <name>
preview_start mission-control-real
```

Restore later with `yarn db:checkpoint:restore <name>`. List with `yarn db:checkpoint:list`. Snapshots live under `.tmp/checkpoints/`.

---

## Section 1 — Initial Setup

The verbatim flow the user runs after a reset to bring the workspace + agents into a known-good state. Save the result as the checkpoint everything else builds from.

| # | Action | Expected |
|---|---|---|
| 1.1 | Confirm gateway connection in the header (top banner reads `ONLINE`) | snapshot contains `ONLINE` |
| 1.2 | Navigate to `/debug`. Click **Start collection** | button label flips to `Stop collection`; collection counter starts updating |
| 1.3 | Navigate to `/agents`. Confirm gateway-synced agents are present | rows for `Builder`, `Coordinator`, `Learner`, `main`, plus the `Project Manager` PM agent. Each gateway-linked row shows the 🔗 icon |
| 1.4 | Click the edit (✏️) action on the **Coordinator** row. Check the **Master Orchestrator** box. Click **Save** | modal closes; Coordinator row shows the master / orchestrator badge |
| 1.5 | On the **Coordinator** row, click the **OpenClaw** button (or **Connect to OpenClaw** in the edit modal) to associate it with the gateway | row shows it's linked (no error toast) |
| 1.6 | On the **main** row, click the **Disable** button | main row's status flips to disabled; subsequent roll-call should skip it |
| 1.7 | Click **Reset all sessions**. Wait ~60s for sessions to stabilise | `preview_logs --search "session"` shows reconnects; toast/message confirms reset complete |
| 1.8 | Click **Roll Call**. Wait until every active row is green | every non-disabled agent reports back; no rows stuck on "pending" |
| 1.9 | Save checkpoint: `setup-stable` | `.tmp/checkpoints/setup-stable.db` exists |

Everything below assumes you can `yarn db:checkpoint:restore setup-stable` to get back to this exact state.

---

## Section 2 — Initiative flow (Smart Snappy)

Validates the Initiatives surface end-to-end: create → edit → plan with PM → decompose → review proposals.

The reference test data (description, refinement prompt, decompose hint) is in [docs/TEST_DATA.md](TEST_DATA.md). Steps 2.1–2.3 are the verbatim flow; 2.4–2.10 are proposed coverage based on the surface area of `/initiatives` and `/initiatives/[id]` — adjust as needed.

| # | Action | Expected |
|---|---|---|
| 2.1 | Navigate to `/initiatives`. Click **New initiative**. Fill: title `Smart Snappy`, kind `Epic`, no parent. Save | new row appears at the top of the list with kind=Epic, status=planned, no parent |
| 2.2 | Click into **Smart Snappy**. Click into the **DESCRIPTION** section (or its "Add a description" CTA on a fresh initiative). Paste the **INITIATIVE 1** body from [TEST_DATA.md](TEST_DATA.md). Save | detail page shows the description; markdown renders |
| 2.3 | On the detail page, click the icon button with `aria-label="Run with operator guidance"` that sits next to **Plan with PM** (it expands a guidance prompt input). Paste the **REFINE WITH PM GUIDANCE** prompt from [TEST_DATA.md](TEST_DATA.md). Click **Plan with PM** to dispatch | a draft proposal row appears with `trigger_kind = plan_initiative`; the panel either shows a streaming/loading indicator or a synthesised plan. `preview_logs --search "pm-dispatch"` shows a named-agent dispatch (not a synth fallback) |
| 2.4 | When the plan proposal is ready, click into the proposal. Read the impact summary | impact_md is non-empty; structured `plan_suggestions` (refined description / complexity / target dates / deps) renders |
| 2.5 | Click **Apply suggestions** (or equivalent) to populate the initiative draft. Save | the initiative's description / dates / complexity reflect the suggestions |
| 2.6 | Back on the detail page, click **Decompose with PM**. (Optional: provide a hint such as "focus on backend first") | a draft proposal with `trigger_kind = decompose_initiative` lands; reviewing it shows 3–7 `create_child_initiative` diffs all parented to Smart Snappy |
| 2.7 | Open the decompose proposal. Click **Accept** | proposal flips to `accepted`; child stories appear under Smart Snappy on `/initiatives`; each child has a `task_initiative_history` entry |
| 2.8 | Pick one child. Click **Add child**, create a sub-story (e.g. "Daily checklist v0"). Save | new sub-story attaches under the child; tree view shows nested rows |
| 2.9 | On a child, add a dependency (Add dependency dropdown → pick a sibling). Save | sibling appears in the child's deps list |
| 2.10 | Save checkpoint: `smart-snappy-decomposed` | `.tmp/checkpoints/smart-snappy-decomposed.db` exists |

**Regressions to watch for during 2.x:**
- Plan-with-PM panel hangs forever (no timeout, no proposal lands) → this is the regression class that motivated this doc.
- Resume-on-reopen: close the panel mid-stream, navigate away, navigate back. Expected: same draft proposal resumes, not a fresh dispatch.
- Multiple Plan-with-PM clicks dispatch repeatedly (should be idempotent until the parent draft is rejected).
- `preview_logs --search "session"` should show a fresh `plan-<uuid>` session per Plan/Decompose conversation, not the stable `dispatch-main` session.

---

## Section 3 — PM (disruption + chat + propose_from_notes)

The PM surface is at `/pm` (chat + recent proposals) and `/pm/proposals/<id>` (review). The disruption flow is the original PM use case; `propose_from_notes` is the new one and is MCP-only — exercise it via `curl` from this doc.

| # | Action | Expected |
|---|---|---|
| 3.1 | From `setup-stable` (or `smart-snappy-decomposed`), navigate to `/pm`. Type `Sarah out next week` (or any teammate name on the workspace) into the chat input. Send | a draft proposal lands in the **Recent proposals** list; impact_md mentions `add_availability` for that owner. `preview_logs` shows the named-agent path won (not synth fallback) |
| 3.2 | Click into the new draft. Click **Reject**. Navigate back to `/pm` | proposal status flips to `rejected`; the PM chat shows the reject acknowledgement; no stale draft remains visible in the chat panel |
| 3.3 | Send a second disruption: `Customer demo delayed until 2026-06-15`. Click into the draft | proposal includes a `shift_initiative_target` diff if any initiative title matches "demo"; otherwise an availability/at-risk diff with the explicit date |
| 3.4 | On that proposal, click **Refine** with the constraint `keep launch on schedule, defer analytics`. Save | parent proposal flips to `superseded`; a new draft inherits the trigger and shows the constraint reflected in the new impact |
| 3.5 | Accept the refined proposal | parent superseded chain stays; the accepted proposal has applied changes (verifiable on `/initiatives` or `/roadmap`) |
| 3.6 | **propose_from_notes** (MCP, gateway up). From a terminal: `curl -X POST http://localhost:4001/api/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"propose_from_notes","arguments":{"agent_id":"<any agent id>","workspace_id":"default","notes_text":"Stand-up notes:\n- ship onboarding\n- fix #123"}}}'` (replace agent_id with an active row's id from `/agents`) | response `{ status: "dispatched", proposal_id: "<uuid>" }`. Open the proposal at `/pm/proposals/<uuid>` and confirm it carries a heterogeneous PmDiff[] (creates + tasks). |
| 3.7 | **propose_from_notes** (gateway down). Disable openclaw temporarily (e.g. firewall the port or stop the gateway), re-issue the same curl | response `{ status: "queued", pending_id: "<uuid>" }`. Row exists in `pm_pending_notes` with status=`pending` |
| 3.8 | Re-enable the gateway. Wait up to 60s for the periodic drain | `preview_logs --search "pm-pending-drain"` shows a successful drain; the row's status flips to `dispatched`; a new proposal exists; UI on `/pm` reflects it |

**Regressions to watch for:**
- Proposal lands but the PM chat panel never updates (SSE/listener regression).
- Refine creates a new draft but inherits *empty* impact/changes (the synth/agent never re-fills).
- After accept, derived dates on `/roadmap` don't reflect the change → derivation cache stale.

---

## Section 4 — Roadmap (derivation, owner availability, ripple)

The roadmap timeline lives at `/roadmap` with Week / Month / Quarter zoom. The derivation engine reads availability + dependencies + complexity to compute target dates.

| # | Action | Expected |
|---|---|---|
| 4.1 | After accepting decompose in §2, navigate to `/roadmap`. Pick the **Quarter** zoom | Smart Snappy + its children render on the timeline with derived target dates; arrows show dep edges |
| 4.2 | Click **Recompute now** | "Last computed" timestamp updates; visible target dates may shift slightly; no error toasts |
| 4.3 | Add an owner-availability window via PM (`Sarah out 2026-05-01 to 2026-05-15`) and accept the proposal. Return to `/roadmap` and Recompute | initiatives owned by Sarah whose target windows overlap the unavailability shift later; arrow/dep chain remains consistent |
| 4.4 | Toggle Week ↔ Month ↔ Quarter | bars resize; nothing renders off-screen; no infinite scroll |
| 4.5 | Save checkpoint: `roadmap-after-disruption` | `.tmp/checkpoints/roadmap-after-disruption.db` exists |

**Regressions to watch for:**
- Recompute spins forever (derivation cache deadlock).
- Bars overlap or duplicate when zoom changes.
- Owner-availability impact lands in the proposal but not in derivation output.

---

## Section 5 — Cross-surface regressions

A short pass that goes through several surfaces in sequence to catch subtle interaction bugs.

| # | Action | Expected |
|---|---|---|
| 5.1 | From `roadmap-after-disruption`, on `/initiatives` pick a story and **Promote to task** | a draft task appears on `/workspace/default` (Task Board, draft column); the story's link to that task is visible in detail |
| 5.2 | Move the task draft → inbox via the Task Board | task transitions to inbox; no "ghost" duplicate row remains; events feed shows `task_promoted_to_inbox` |
| 5.3 | Open the PM chat and send any message. While streaming, navigate to `/initiatives` and back | streaming finishes; chat history is consistent on return; no duplicate user message |
| 5.4 | `/debug` → **Run diagnostic**. Export the collection started in 1.2 | diagnostic completes; export downloads a JSON file |

---

## Stubs (to be expanded once PM/Initiatives/Roadmap are stable)

Not yet covered — keep these as placeholders so the doc is honest about scope. We'll fill them in next.

### Section 6 — Task Board

- TBD: Inbox triage → assigned → in_progress → review → done; failure path; dispatching to a worker; deliverable acceptance flow.

### Section 7 — Deliverables

- TBD: Listing, opening a deliverable, diff vs prior, accept / reject from the UI.

### Section 8 — Autopilot / Products

- TBD: Product creation, research cycles, the autopilot loop end-to-end.

---

## Reporting regressions

When a step fails:

1. Capture `preview_screenshot` + `preview_snapshot` + the relevant `preview_logs` slice (filter by `[pm-`, `[Migration`, `[OpenClaw]`, `chat_event`, etc.).
2. Note **which checkpoint** you were on, the **step number**, and the **first observed deviation** from `Expected`.
3. If the regression repros from a clean `setup-stable`, file a follow-up. If it only repros from an in-flight checkpoint, copy that `.tmp/checkpoints/<name>.db` to `.tmp/db-backups/` so we can re-load it later.

---

## Maintenance

- When a UI affordance moves or renames, update the matching `Action` cell in the same PR. Stale selectors are worse than no selectors.
- New surfaces should land here as a new section before merging the feature, not after a regression.
- This file is intentionally one document. Splitting per-surface docs caused them to drift out of sync.
