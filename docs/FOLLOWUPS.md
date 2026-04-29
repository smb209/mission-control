# Followups

Small tasks flagged inline during sessions that don't yet warrant their
own initiative. Promote any of these to a real MC initiative once the
scope clarifies; otherwise grab one when there's a quiet moment between
larger work.

Format: each item names the trigger session / PR, the concrete fix, and
why it was descoped at the time. Strike through and date-mark when done
rather than deleting — the trail is useful retrospectively.

## UI / preview interaction

- [ ] **Refactor browser-style alerts to a custom modal so preview can
  drive them.** ~30 native `alert()` calls remain across `/agents`,
  `/initiatives`, `/debug`, and `AgentsSidebar`. Native `window.alert`
  blocks JS execution and is invisible to `preview_*` tools, so any
  flow that hits one (e.g. error path on agent update, "Reset sent"
  confirmation, delete failures) can't be exercised via the preview
  test flow. `src/components/ConfirmDialog.tsx` already exists and
  replaced the native `window.confirm()` calls per PREVIEW_TEST_FINDINGS
  §1.7 — extend the same pattern with an `AlertDialog` (single-action
  modal) plus a small `useAlert()` hook so the call sites stay terse.
  Triage: error/success toasts probably want a different surface
  entirely (transient, non-blocking) — split this followup into
  "blocking confirm-style alerts → modal" vs "non-blocking notifications
  → toast" before starting.

## Docs hygiene

- [ ] **Scrub stale `localhost:4000` references.** Older docs still
  point dev at port 4000 (the LiteLLM gateway port now). Touched files:
  `docs/ORCHESTRATION_WORKFLOW.md`, `docs/ISSUE-01-LOCAL-GUIDE.md`,
  `docs/TESTING_REALTIME.md`. CLAUDE.md flags them as stale; this
  followup actually fixes them.

## Tooling — dogfood loop

- [ ] **`yarn openclaw:sync` prune.** Today the script only adds /
  updates `-dev` agents; it doesn't detect a `-dev` block whose stable
  counterpart was deleted in `openclaw.json`. Add a confirmation prompt
  ("delete `mc-foo-dev`? its stable `mc-foo` was removed") so the
  rosters stay in lockstep without manual cleanup.

- [ ] **`yarn agents:resync` (and / or a "Resync now" button on
  `/agents`).** Catalog sync runs on startup + every 60s, so today
  changing `MC_AGENT_SYNC_INCLUDE` / `MC_AGENT_SYNC_EXCLUDE` requires
  either a restart (env-var reload) or waiting up to 60s after a
  PATCH. A button/CLI that calls `syncGatewayAgentsToCatalog({force:
  true})` would shorten the env-tuning loop. Skipped on
  PR #94 because the 60s cadence + restart-on-env-change covered the
  immediate dogfood need.

- [ ] **"Hide offline gateway agents" toggle on `/agents` All tab.**
  Operators can already filter to STANDBY to hide them — this is
  cosmetic. Worth doing only if the OFFLINE clutter starts to bug us
  in practice.

## Memory / PM

- [ ] **`refine_proposal` for `decompose_initiative` is LLM-less.** At
  `src/app/api/pm/proposals/[id]/refine/route.ts:163-180`, the
  decompose branch only calls `synthesizeDecompose(init, combinedHint)`
  and skips the named-agent path entirely. Same shape as the
  `plan_initiative` branch already does (lines 80-162) via
  `dispatchPmSynthesized` + `await dispatch.completion` — that's the
  template to mirror. Surfaced during dogfood: a refine on the
  memory-layer epic produced 3 generic Discovery/Implementation/
  Verification stories instead of an actual refinement of the 8
  agent-generated stories. Promote to a real fix soon — refine is
  load-bearing for the planning loop.

- [ ] **`import-workspace` to reload from JSON export.** Out of scope
  on PR #93 (export-only). Output is INSERT-shaped, so an importer
  iterates `tables` in dependency order. Open question: workspace_id
  collision policy (overwrite, rename, abort). Likely waits until we
  actually need to round-trip a snapshot — until then, the export is
  retention-only.

- [ ] **Retire the deterministic `synthesizeImpactAnalysis` fallback.**
  The disruption / refine paths still use it. Once the queue-based
  `notes_intake` pattern proves out, the same defer-and-replay shape
  could replace the synth fallback for those paths too. Called out
  in the original `propose_from_notes` plan as an explicit followup.

- [ ] **Verify proposal review pane handles unknown diff kinds.**
  `propose_from_notes` introduced `create_task_under_initiative`. The
  diff-list renderer should fall back gracefully on kinds it doesn't
  know about rather than crashing. Confirm via preview test, fix if
  needed. Flagged as a verification step in the original plan.

## Promotion criteria

If a followup grows in scope (e.g. "rewire all alerts" turns into "MC
notification system with toasts + modals + Toast queue"), it graduates
out of this doc and becomes an initiative in the prod MC roadmap with
a real description and decomposition. The bar is rough: ≥1 day of work,
or touches more than one subsystem, or wants a design doc — promote.
