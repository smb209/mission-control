# Preview Test Findings

A running log of regressions, UX issues, and doc-drift items surfaced by walking through [PREVIEW_TEST_FLOW.md](PREVIEW_TEST_FLOW.md). Append entries here during a walkthrough; triage / file follow-ups afterwards.

## Format

```
### YYYY-MM-DD · <step ref> · <short title>

- Severity: blocker (RESOLVED) | regression | polish | doc-drift
- Repro: <one-line repro from a known checkpoint>
- Expected: <what the doc says>
- Actual: <what we observed>
- Notes: <root-cause hint, file paths, follow-up link>
```

---

## 2026-04-27 · §1 Initial Setup walkthrough

### §1.3 · Stock `Builder Agent` / `Learner Agent` rows seeded alongside gateway-synced agents

- Severity: regression (RESOLVED — `bootstrapCoreAgents` / `bootstrapCoreAgentsRaw` are now no-ops; worker roster is gateway-only, PM is the one MC-side agent created by `ensurePmAgent`)
- Repro: from a wiped DB → `yarn db:reset` → `preview_start` → open `/agents`
- Expected: only gateway-synced rows (`Builder`, `Coordinator`, `Learner`, `main`, `Project Manager`) plus any workspace-local PM. Total ≈ 5–6 agents.
- Actual: 13 rows. Duplicates appear because the local-source rows `Builder Agent` (role=builder) and `Learner Agent` (role=learner) are seeded next to the gateway-linked `Builder` / `Learner` rows.
- Notes: source is `bootstrapCoreAgentsRaw()` ([src/lib/bootstrap-agents.ts:64](src/lib/bootstrap-agents.ts:64), [:142](src/lib/bootstrap-agents.ts:142)) called from:
  - migrations runner for the `default` workspace ([src/lib/db/migrations.ts:648](src/lib/db/migrations.ts:648))
  - `POST /api/workspaces` ([src/app/api/workspaces/route.ts:110](src/app/api/workspaces/route.ts:110))

  Now that gateway sync owns the worker roster, this path should be reduced. Decision needed:
  1. Make `bootstrapCoreAgents` a no-op (workspace + workflow templates only).
  2. Mint only the **PM** agent (MC-side, unique — gateway sync doesn't produce it).
  3. Keep stock Builder/Learner placeholders only when no gateway is connected.

  Recommendation: option 2 — PM is genuinely MC-owned; everything else is gateway. See the spawned follow-up task.

---

### §1.7 · "Reset all sessions" uses native `window.confirm()` — blocks automation

- Severity: regression / polish (RESOLVED)
- Repro: from `setup-stable` baseline → /agents → click **Reset all sessions**
- Expected: in-app modal we can drive via DOM (matching the rest of the UI's modal pattern, e.g. agent edit panel).
- Actual: native browser `confirm()` dialog. Cannot be dismissed by `preview_eval` / `preview_click` — pauses automation until a human clicks through. Also looks out of place vs. the rest of the styled UI.
- Notes: probably a `window.confirm("…")` call in the click handler. Replace with the same modal/dialog component the agent-edit panel uses. Until then, the test flow doc must call out that this step requires manual click-through.

### §2.3 · Plan-with-PM guidance popup is too narrow / clips heading

- Severity: polish (RESOLVED)
- Repro: from `setup-stable` → /initiatives → click into Smart Snappy → click ▾ chevron next to **Plan with PM**
- Expected: popup wide enough to show heading "What should the PM focus the plan on?" and the placeholder text in full.
- Actual: heading is clipped on the left edge ("PM focus the plan on?" visible); placeholder shows truncated like ".."; the **Submit** label is also clipped.
- Notes: likely `max-width` on the popover is too small for the heading + actions row. Probably one Tailwind class change.

### §2.3 · Plan-with-PM races: 60s timeout fires before agent responds, late agent proposal is orphaned

- Severity: blocker (RESOLVED)
- Repro: from `setup-stable` → /initiatives → click into Smart Snappy → ▾ chevron next to **Plan with PM** → paste the REFINE WITH PM GUIDANCE prompt → click **Plan with guidance**. (Reproes most reliably on a freshly-warmed PM session — cold sessions take longer.)
- Expected: gateway PM agent's `propose_changes` lands and is shown to the operator; no duplicate synth proposal.
- Actual: TWO proposals for one click. Confirmed via the openclaw session log:
  - `19:19:13` — dispatch sent to PM agent (correlation `9c60387b-…`).
  - `19:19:35` — agent calls `whoami` to gather context (22s in).
  - `19:20:12` — MC's 60s `NAMED_AGENT_TIMEOUT_MS` elapses → `dispatchPmSynthesized` falls back to deterministic `synthesizePlanInitiative` → proposal `789c26d2-…` saved with `refined_description == input`. THIS is what the UI displays.
  - `19:20:23` — agent finishes its turn and calls `propose_changes` (id `05591c6f-…`) with the actual high-quality refinement (full rewrite, resolved decisions table, owner-tagged follow-ups). Lands ~11s after the timeout. Orphaned — UI never shows it.
- Notes: two underlying issues, separable:
  1. **Timeout too aggressive for plan/decompose dispatches.** 60s default is fine for one-line disruption dispatches; it's clearly too tight for plan_initiative on a sizable epic where the agent has to read input + roadmap snapshot + compose structured output. Either bump the default specifically for plan/decompose (e.g. 120s), make the timeout configurable per dispatch kind, or auto-extend on the first observed token from the agent.
  2. **Late-arriving agent proposals are orphaned, not reconciled.** `dispatchPmSynthesized`'s post-hoc trigger_kind / target_initiative_id stamping only runs if the agent's `propose_changes` lands inside the wait window. When it lands later, the row stays with `trigger_kind: 'manual'`, `target_initiative_id: null`, and no link back to the originally-dispatched intent — and no one supersedes the synth fallback. We need the listener (or a short tail-window after the timeout) to catch these and either (a) supersede the synth row + promote the agent row, or (b) at least mark the agent row as related to the original correlation_id.

  Worth noting that the agent's actual output was excellent — full description rewrite, resolved-decisions table with owner-area columns, scoped Phase 2 deferrals — exactly what the operator guidance asked for. The bug is purely in the orchestration around it.

### §2.3 · Self-dependency suggestion (initiative depends on itself)

- Severity: regression (RESOLVED)
- Repro: same as above
- Expected: deterministic synth must not propose `depends_on_initiative_id == target_initiative_id`.
- Actual: `dependencies[0]` in `plan_suggestions` is `{ depends_on_initiative_id: 15d41a5f-… (Smart Snappy itself), kind: 'informational', note: 'Title shares \"smart, snappy\" — confirm if this is a real dependency.' }`.
- Notes: the title-substring matcher in `synthesizePlanInitiative` doesn't exclude the target initiative from its own candidate set. Easy fix; also: validator should reject this at proposal-create time (PmDiff `add_dependency` already rejects self-deps; the same rule should apply to plan_suggestions before they're persisted).

### §2.3 · Legacy `<!--pm-plan-suggestions {json}-->` sidecar still emitted alongside structured column

- Severity: regression (RESOLVED)
- Repro: same as above; inspect `proposal.impact_md` and `proposal.plan_suggestions` returned by `/api/pm/plan-initiative?workspace_id=…&target_initiative_id=…`.
- Expected: per #85, structured suggestions live in the `plan_suggestions` column only — no markdown sidecar.
- Actual: impact_md trails with `<!--pm-plan-suggestions {…full json…} -->`; same JSON also appears in `plan_suggestions` column.
- Notes: probably `synthesizePlanInitiative` (deterministic path) still appends the sidecar even after the column was added. Strip the appender now that the column is canonical.

### §2.3 · `/api/pm/proposals?workspace_id=default` returns empty list while plan_initiative draft exists

- Severity: polish (NOT REPRODUCIBLE — false alarm from eval response-shape parsing; endpoint returns the array correctly)
- Repro: after a plan_initiative dispatch lands a draft, GET `/api/pm/proposals?workspace_id=default`.
- Expected: at least the new draft proposal in the response.
- Actual: `[]`. The proposal IS reachable via `/api/pm/plan-initiative?…&target_initiative_id=…` and `/pm/proposals/<id>`, just not in the workspace-wide list.
- Notes: likely an intentional filter to keep advisory plan_initiative rows out of the operator's "open proposals" list — but the filter isn't documented anywhere and surprised us during the walkthrough. Either expose them with a flag (`?include=advisory`) or drop the filter; current behavior makes the workspace list misleading for anyone debugging.

### §2.3 · Plan-with-PM concurrent dispatches cross-supersede

- Severity: regression (edge case) (RESOLVED — reconciler now filters `dispatch_state !== 'pending_agent'`)
- Repro: trigger two POST `/api/pm/plan-initiative` for the same `target_initiative_id` in quick succession (e.g. UI double-fire / accidental double-click after Discard).
- Expected: each placeholder is superseded only by an actual agent row, never by another placeholder.
- Actual: each background reconciler's `pollForAgentProposal` matches "any draft that isn't my placeholder" — the OTHER concurrent placeholder satisfies that filter, so placeholder A gets superseded by placeholder B (and vice versa) before the agent's row even arrives. The supersede chain ends up tangled.
- Notes: tighten the reconciler's filter to also require `dispatch_state !== 'pending_agent'` on candidates. Fix is local to `pollForAgentProposal` in `pm-dispatch.ts`. Also worth fixing the upstream UI double-fire on the `Discard` → `Plan with guidance` path so this rarely matters in practice.

### §2.4-2.5 · Agent's plan_suggestions occasionally omits target_start / target_end

- Severity: polish (RESOLVED — reconciler now backfills `target_start` / `target_end` from synth's `plan_suggestions` when the agent's row leaves them null)
- Repro: from `setup-stable` → /initiatives → Smart Snappy → Plan with PM with the standard refinement guidance; inspect the resulting `plan_suggestions` and the post-Apply initiative row.
- Expected: target window populated (synth fallback always proposes today + N weeks based on complexity).
- Actual: agent's `plan_suggestions.target_start` / `.target_end` are both `null`; Apply leaves them null on the initiative row.
- Notes: low-cost fix paths:
  1. SOUL.md instructs the agent to always propose target_* (and that's currently in there) — perhaps the agent is omitting because the prompt also says "operator can set later." Sharpen the language.
  2. Reconciler-side: when the agent's `plan_suggestions` is missing dates, fall back to synth-derived dates rather than nulls. Cleaner than fighting the prompt.

### §2.6 · Agent's `propose_changes` first call sometimes stringifies array args (intermittent retry)

- Severity: regression (latency)
- Repro: trigger Decompose with PM with a substantial hint; observe openclaw session log. The agent's tool-use layer occasionally serializes the `changes` array as a JSON string ("[{...}, ...]") rather than a real array. Validation rejects it (`changes: must be array`); the agent retries with a properly structured payload and the second call succeeds.
- Expected: server accepts both shapes — array, or string-that-decodes-to-array — without forcing an agent retry. Retrying costs ~30-60s of agent latency on top of the already-slow plan/decompose round trip.
- Actual: `propose_changes` MCP tool's zod schema requires `changes: array` and rejects stringified payloads outright.
- Notes: cheap fix in `roadmap-tools.ts` `propose_changes` handler — pre-process `args.changes` and `args.plan_suggestions`: if string, attempt `JSON.parse`, fall back to current behavior on parse error. Same for `plan_suggestions`.

### §2.6 · DecomposeWithPmModal not wired to SSE supersede flow

- Severity: regression
- Repro: from `setup-stable` → /initiatives → Smart Snappy → Decompose with PM (with hint) → wait for agent.
- Expected: modal shows "PM agent is composing" indicator while `dispatch_state === 'pending_agent'`, then auto-swaps to the agent's children when supersede broadcasts `pm_proposal_replaced`.
- Actual: modal renders only the synth placeholder (3 generic children: Discovery / Implementation / Verification). The agent's better decomposition is in the DB but the modal never updates. Operator must close + reopen, and even then the GET endpoint can't find the agent's row (next finding).
- Notes: mirror the PlanWithPmPanel SSE wiring into DecomposeWithPmModal. Same hooks: subscribe on open + pending_agent, handle pm_proposal_replaced + pm_proposal_dispatch_state_changed, refetch on supersede, soft-disable Accept while pending.

### §2.6 · Decompose GET endpoint can't find agent's row after supersede

- Severity: regression (RESOLVED — supersede now copies trigger_text from placeholder)
- Repro: after a Decompose dispatch supersedes, `GET /api/pm/decompose-initiative?initiative_id=…` returns the synth row (or null) instead of the live agent row.
- Root cause: GET filters on `json_extract(trigger_text, '$.initiative_id')`. The agent's freeform `trigger_text` (whatever it passed via `propose_changes`) doesn't carry that JSON envelope, so the lookup misses it.
- Fix shipped: `supersedeWithAgentProposal` in `pm-proposals.ts` now copies the placeholder's `trigger_text` onto the agent's row during supersede. Preserves the JSON envelope MC built and keeps lookups stable.

### §2.8 · "Add child" not available on story-kind initiatives — doc assumed universal

- Severity: doc-drift
- Repro: from a decomposed Smart Snappy → click into any child story (e.g. "Snappy Service Architecture") → toolbar shows `Promote to task / Plan with PM / Move / Convert kind / Add dependency / View history / Detach / Delete`. No `Add child`.
- Expected per the doc: `Add child` is always available.
- Actual: stories are roadmap leaves. Adding sub-children requires `Convert kind` to epic first.
- Notes: update PREVIEW_TEST_FLOW.md §2.8 to either (a) call out the convert-kind prerequisite, or (b) target a non-story child (epic/milestone) so Add child is exposed naturally. We picked (b)-style: skip 2.8 in this walkthrough and exercise convert_initiative as its own step in a later section.

### §3.1 · Disruption dispatch (`dispatchPm`) didn't get Tier 1/2/3 — same race as plan/decompose

- Severity: regression (RESOLVED — `dispatchPm` refactored to mirror `dispatchPmSynthesized`)
- Repro: from `smart-snappy-decomposed` → /pm → type "Researcher is out next week — dental surgery, back the following Monday." → Dispatch.
- Expected: same async behavior as plan/decompose — synth placeholder returned immediately with `dispatch_state: pending_agent`, agent's row supersedes via SSE.
- Actual: `POST /api/pm/proposals` blocks for 60s (named-agent timeout), then synth fallback creates a row at 15:40:20. The agent's row lands at 15:40:21 (right after the timeout) but is NOT superseded — both rows live in `Recent proposals` as separate drafts. Chat panel shows the synth content; the agent's better summary ("Researcher unavailable Apr 28 – May 2 (staged in owner_availability)") is orphaned.
- Notes: extend the same `dispatchPmSynthesized`-style refactor to `dispatchPm`. They share the named-agent + reconciler primitives — this is mostly plumbing the placeholder + supersede + SSE through the disruption code path.

### §3.1 · Synth and agent disagree on "next week" semantics

- Severity: polish (RESOLVED — synth's `nextWeekStart` now uses conversational "tomorrow / next Monday on weekends" semantics, with a unit test pinning the behavior)
- Repro: same as §3.1 above — observe the two competing proposals.
- Expected: consistent date interpretation across synth and agent (both should produce Apr 28 – May 2 OR both May 4 – 10 — not divergent).
- Actual: synth uses ISO-week semantics (Monday after next Monday → 2026-05-04 → 05-10). Agent uses conversational semantics (this Tue-Fri → 2026-04-28 → 05-02).
- Notes: bias toward agent's interpretation ("next week" = next 5 weekdays from today) — that's how operators talk. Update synth's `nextWeekStart` to use today + 1 (or strict "tomorrow through next Friday") and add a unit test to lock it.

### §3.4 · Refine flow recursively dispatches — agent calls `refine_proposal` MCP, which calls dispatchPm again

- Severity: regression (high) (RESOLVED — refine route now strips the `[refine]` envelope and instructs the agent to use `propose_changes`)
- Repro: from a draft proposal → click Refine → enter a constraint → Send. Watch `pm_proposals` rows appear over the next minutes.
- Expected: ONE refine cycle — child row patched with the agent's content, transient placeholder cleaned up.
- Actual: cascade of pending_agent placeholders + agent rows. The original child row (`624053b6` in this run) sits at "_(refining…)_" forever because the dispatchPm.completion never settles cleanly.
- Root cause: `refineProposalDb` writes `trigger_text = "<original>\n\n[refine] <constraint>"`. When dispatchPm forwards that to the PM agent, the `[refine]` prefix nudges the agent to call `refine_proposal` (an MCP tool it has access to) instead of `propose_changes`. Inside the MCP handler at `roadmap-tools.ts:754`, `refine_proposal` itself calls `dispatchPm(...)` — closing the loop. Every refine triggers another refine, which triggers another refine.
- Fix paths (pick one):
  1. Strip the `[refine]` token before the prompt is built; pass the raw `additional_constraint` to the agent with explicit instructions to call `propose_changes` (NOT `refine_proposal`).
  2. Make the refine MCP tool detect "we're being called from a dispatch in progress" via correlation_id and short-circuit to creating a propose_changes-style proposal instead of dispatching again.
  3. Agent SOUL.md: tighten "you call propose_changes only" — refine_proposal isn't really meant for the agent to call, it's an operator/MCP UI affordance.
- Recommendation: combine (1) and (3). The MCP tool should still exist for operator/UI use; the prompt-side guidance just keeps the agent from accidentally calling it.

### §4.3 · Owner availability has no derivation effect when no children have `owner_agent_id`

- Severity: doc-drift
- Repro: from `smart-snappy-decomposed` → /roadmap → Recompute. Observe child schedules. Then check `owner_availability` and child `owner_agent_id` columns.
- Expected per the doc: adding an availability window for an owner shifts initiatives that owner is on. Doc test step assumed owner attribution would be in place.
- Actual: agent's `decompose_initiative` doesn't assign owners (it has no way to know which gateway agent each story will go to). All seven children have `owner_agent_id = null`. Two `owner_availability` rows already exist (from prior agent `add_owner_availability` calls during disruption dispatches), but they affect zero rows because the join `initiatives.owner_agent_id = owner_availability.agent_id` matches nothing.
- Notes: not a bug — it's the cold-start state on a workspace where the operator hasn't made owner assignments yet. Two doc-side options:
  1. PREVIEW_TEST_FLOW.md §4.3 should explicitly call out "first assign owners (Coordinator → backend stories, Builder Agent → mobile)" before staging availability.
  2. The agent's `decompose_initiative` SOUL.md guidance could nudge it to suggest owners based on the description's "Owner: Backend / Mobile / Design" labels (which the agent itself wrote in the Smart Snappy refined description). That'd make the ripple test work end-to-end out of the box.

### §4.4 · Quarter zoom doesn't render month/quarter headers on short ranges

- Severity: polish (RESOLVED — `axisTicks` includes the boundary at-or-before windowStart so the leftmost edge always carries a label; canvas renderer clamps negative-x labels to render at the left edge instead of off-screen)
- Repro: from `roadmap-after-disruption` → /roadmap → Quarter zoom on a window that doesn't span Apr→Jul (or any quarter boundary).
- Notes: live confirmed — Quarter zoom on the Smart Snappy Apr-May window now shows `Q2 2026` anchor label.

<!-- new entries below -->
