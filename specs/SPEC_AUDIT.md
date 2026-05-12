# Spec Audit — 2026-05-11

Audit of every spec file against current code on `main` (after `feat/audit-action-recommended` merged as #326).

**Updates:**
- **2026-05-11** initial audit run.
- **2026-05-11 (post-merge of #326)** `audit-action-recommended.md` reclassified 2 → 1.
- **2026-05-11 (drift-fix pass)** 17 historical artifacts moved to `docs/archive/`; `memory.md` + `autopilot-build-pipeline-spec.md` merged & deleted; `agent-health-overhaul-spec.md` rewritten and renamed to `agent-health.md`; `workspace-conventions-structured.md` §6 rewritten to match shipped `refine.ts`; `convoy-mode-spec.md` §7 banner + body replaced; 7 aspirational specs got `status: aspirational` frontmatter banners.
- **2026-05-11 (research deep-dive)** `research-area.md` rewritten as a 598-line comprehensive reference for the entire research capability; reclassified 2 → 1.
- **2026-05-11 (extractions wave)** New canonical specs: `pm-diff-conventions.md` (616 lines) + `audit-dedupe-followups.md` (81 lines). `dedupe-investigations.md` archived. `roadmap-and-pm-spec.md` got "post-merge addenda" callout. `pm-chat-prompt.md` rewritten to reflect both PR A *and* PR B shipped (audit had it as half-aspirational — code says otherwise). Two more class-2 specs reclassified to class 1.
- **2026-05-11 (frontmatter contract)** All 34 active specs now carry YAML frontmatter (`status`, `last-verified`, `audience`, `code-anchors`, `mcp-tools`, `db-tables`, `migrations`, `related-specs`). `scripts/docs-check.ts` validates `code-anchors` paths exist; wired as `yarn docs:check`. CLAUDE.md got a 25-line "Spec Frontmatter Contract" section instructing subagents to update specs in the same PR as code edits to anchor files. Check passes clean: 34/34 frontmatter, 0 violations.
- **2026-05-11 (body-text cleanup)** Wave-4 surfaced specs whose body prose cited stale paths (`src/lib/mcp/tools.ts` from before the groups split, `src/app/feed/page.tsx` from before scope-keyed-sessions). Fixed in 3 specs; 4th verified clean.
- **2026-05-11 (audit-pipeline consolidation)** Three audit specs (`subtree-audit-proposals-spec.md`, `audit-actions-and-tracking.md`, `audit-action-recommended.md`) consolidated into a single 943-line `specs/audit-pipeline.md` deep-dive. The three sources archived to `docs/archive/` with supersession banners. 39 inbound references rewritten.
- **2026-05-11 (task-delegation consolidation)** Three task-delegation specs (`coordinator-delegation-via-convoy-spec.md`, `convoy-mode-spec.md`, `parallel-build-isolation-spec.md`) consolidated into a single 903-line `specs/task-delegation-and-convoys.md` deep-dive (`spawn_subtask`, convoy lifecycle, workspace isolation, evidence gates, escalate_to_parent, checkpoints, mailbox, rollcall). Three sources archived.
- **2026-05-11 (ADRs)** New `docs/decisions/` folder with 8 ADRs extracted from existing content: append-only migrations, `spawn_subtask` replaces `delegate`, async PM dispatch + placeholder/reconciler, workspace refine returns inline, `take_note` `run_cancelled` guard scope, subtree-audit hard cutover, PmDiffs as JSON, `agent_runs` envelope + brief opt-out. `scripts/docs-check.ts` extended to validate ADR frontmatter (`adr-number`, `status ∈ {proposed, accepted, superseded}`, code-anchors). CLAUDE.md got a small "Architecture Decisions" subsection.

Detailed per-cluster reports (from the initial audit, pre-drift-fix) live under [`specs/audit-reports/`](audit-reports/).

## Classification rubric

1. **Current & accurate** — describes shipped behavior; matches code.
2. **Current & aspirational** — describes intended behavior, partially or wholly unimplemented.
3. **Feature drift** — spec describes shipped behavior that has since changed.
4. **Historical / superseded** — one-time build plan or validation pass; lives in `docs/archive/`.

## Counts (post drift-fix)

| Class | Count |
|---|---|
| 1. Current & accurate | 19 |
| 2. Current & aspirational | 10 |
| 3. Feature drift | 0 |
| 4. Historical / superseded (in `docs/archive/`) | 24 |
| **Total** | **53** |

Two specs deleted in the drift-fix pass: `memory.md` (merged into `memory-layer.md`), `autopilot-build-pipeline-spec.md` (merged into `product-autopilot-spec.md`).

## Per-spec verdict table

### Active specs (`specs/`)

| Spec | Class | Rationale |
|---|---|---|
| [agent-health.md](agent-health.md) | 1 | Rewritten 2026-05-11 to match `src/lib/agent-health.ts`; appendix lists original unshipped proposals |
| [audit-pipeline.md](audit-pipeline.md) | 1 | **New 2026-05-11** — 943-line canonical deep-dive consolidating subtree-audit-proposals + audit-actions-and-tracking + audit-action-recommended. Covers vocabulary, data model, note-body schemas, dispatch flow, narrow-vs-subtree mode (post-cutover), verdict + auto-spawn bridge, resynthesize endpoint, operator UI, PM hand-off, dedupe, MCP surface, configuration. Three source specs archived. |
| [autonomous-flow-tightening-spec.md](autonomous-flow-tightening-spec.md) | 1 | Slices match shipped code (`task_evidence` mig 058, `is_failed` 059, `runtime_kind` 060, role souls) |
| [autopilot-resilience-and-activity-feed.md](autopilot-resilience-and-activity-feed.md) | 1 | `research_cycles` phase columns + `ideation_cycles` shipped (`migrations.ts:1177-1212`) |
| [calendar.md](calendar.md) | 2 | Aspirational banner added; `/calendar` is a SpecPage stub |
| [cascade-rules.md](cascade-rules.md) | 1 | Backed by live guardrail test (`src/lib/db/schema-cascade.test.ts`) |
| [task-delegation-and-convoys.md](task-delegation-and-convoys.md) | 1 | **New 2026-05-11** — 903-line canonical consolidating coordinator-delegation + convoy-mode + parallel-build-isolation. Covers `spawn_subtask`, convoy lifecycle, workspace isolation, evidence gates, `escalate_to_parent`, checkpoints, mailbox, rollcall. Three sources archived. |
| [decisions-assumptions.md](decisions-assumptions.md) | 2 | Aspirational banner added; `/decisions` is a SpecPage stub |
| [audit-dedupe-followups.md](audit-dedupe-followups.md) | 2 | New 2026-05-11. Owns the two genuinely-open dedupe items: generalize `run_cancelled` guard beyond `take_note`, and close the brief-dispatch dedupe gap (`skip_run_row: true` bypasses `agent_runs`). Parent `dedupe-investigations.md` archived after subagent verified PR #1/#2/#3 all shipped |
| [pm-diff-conventions.md](pm-diff-conventions.md) | 1 | New 2026-05-11. Canonical reference for the `PmDiff` discriminated union + the 7-step contract for adding a new diff kind. 11-kind inventory with capture/inverter columns. Cites `src/lib/db/pm-proposals.ts` + `src/lib/pm/invertDiff.ts` |
| [foia-pipeline.md](foia-pipeline.md) | 2 | Zero code: no `foia_*` tables, no FOIA MCP tools, no `/requests`/`/agencies` routes |
| [gardener.md](gardener.md) | 2 | Aspirational banner added; no gardener/curator agent; depends on unbuilt memory-layer |
| [jobs-in-progress.md](jobs-in-progress.md) | 2 | Migrations 080/081 + API + UI shipped; PR 5 sidebar pip / drill-down status uncertain |
| [long-unattended-feature-dev.md](long-unattended-feature-dev.md) | 1 | Cited by CLAUDE.md; 4-doc pattern observable in every archived `*-validation/` dir |
| [mcp-surface-review.md](mcp-surface-review.md) | 4 | Refactor PRs 1, 2, 4, 5 shipped; PR 3/3.5 (openclaw scripts) + PR 6 (PM SOUL doc) status uncertain |
| [memory-layer.md](memory-layer.md) | 2 | Aspirational banner added; no `memory_entries` table; absorbed `memory.md` intro |
| [pm-chat-prompt.md](pm-chat-prompt.md) | 1 | Rewritten 2026-05-11 — both PR A (SOUL + 1-at-a-time UI) AND PR B (`steerSession`/`abortSession`, `pm_dispatch_in_flight` SSE) verified shipped (`src/lib/openclaw/client.ts:636,645`, `src/lib/agents/pm-dispatch.ts:419-458`, `src/app/(app)/pm/page.tsx:374-405`). One open sub-scope: queue-mode UI affordance (cite `client.ts:629-634`) |
| [pm-revertable-proposals.md](pm-revertable-proposals.md) | 2 | Slices 1/2/4 + capture pattern + revert pipeline shipped; verify activity-timeline UI matches §3 |
| [product-autopilot-spec.md](product-autopilot-spec.md) | 2 | Phase 1+2 shipped; Phase 3 ops + Phase 4 full-loop aspirational. Now incorporates merged `autopilot-build-pipeline-spec.md` content |
| [review-stage-robustness-spec.md](review-stage-robustness-spec.md) | 1 | All six slices (0–5) shipped — roster gate, strict gating, governance hooks, escalate_to_parent, autobounce, role souls |
| [risk-management.md](risk-management.md) | 2 | Aspirational banner added; `/risks` is a SpecPage stub |
| [roadmap-and-pm-spec.md](roadmap-and-pm-spec.md) | 1 | Phases 1–6 + Polish B shipped (initiatives schema, PM agent, MCP tools, standup, `/pm` and `/roadmap` routes) |
| [scope-keyed-sessions.md](scope-keyed-sessions.md) | 1 | Phases A–I shipped (`dispatchScope`, agent_notes spine, agent_role_overrides, per-workspace PMs) |
| [scope-keyed-sessions-phase-j.md](scope-keyed-sessions-phase-j.md) | 1 | `dispatchSubagent` primitive + active-subagent manifest shipped |
| [stakeholders-comms.md](stakeholders-comms.md) | 2 | Aspirational banner added; `/stakeholders` is a SpecPage stub |
| [subagent-orchestration.md](subagent-orchestration.md) | 2 | No `spawn_subagent` tool, no `subagent_runs` table; only the J1 primitive in `dispatch-subagent.ts` |
| [timestamp-handling.md](timestamp-handling.md) | 1 | PR-A + PR-B both shipped; `src/lib/timestamps.ts` header cites the spec |
| [workflows.md](workflows.md) | 2 | Aspirational banner added; `/workflows` is a SpecPage stub; no DAG engine |
| [workspace-conventions-structured.md](workspace-conventions-structured.md) | 1 | §6 rewritten 2026-05-11 to drop phantom `workspace_conventions_proposals` table; now reflects `refine.ts` inline-return persistence |
| [research-area.md](research-area.md) | 1 | Rewritten 2026-05-11 as a comprehensive deep-dive over the entire research capability (598 lines): topics/briefs/agent_runs envelope, run-brief lifecycle, suggest pipeline, scheduling, initiative integration, audit hand-off, dedupe semantics, UI surfaces, MCP tools. §14 lists not-yet-built items (phase 3 templates, explicit proposals-from-briefs, dedupe PR #2/#3, FOIA). |

### Archived specs (`docs/archive/`)

All class 4. Listed for reference:

- [autonomous-flow-validation-plan.md](../docs/archive/autonomous-flow-validation-plan.md)
- [initiative-investigate.md](../docs/archive/initiative-investigate.md)
- [initiative-research-loop.md](../docs/archive/initiative-research-loop.md) + [build-plan](../docs/archive/initiative-research-loop-build-plan.md) + [validation/](../docs/archive/initiative-research-loop-validation/)
- [mcp-surface-v2-build-plan.md](../docs/archive/mcp-surface-v2-build-plan.md) + [validation/](../docs/archive/mcp-surface-v2-validation/)
- [pm-confirm-task-done.md](../docs/archive/pm-confirm-task-done.md)
- [pm-dispatch-async.md](../docs/archive/pm-dispatch-async.md)
- [research-area-build-plan.md](../docs/archive/research-area-build-plan.md) + [validation/](../docs/archive/research-area-validation/)
- [research-phase-2-schedules-build-plan.md](../docs/archive/research-phase-2-schedules-build-plan.md) + [validation/](../docs/archive/research-phase-2-validation/)
- [review-stage-robustness-build-plan.md](../docs/archive/review-stage-robustness-build-plan.md) + [validation/](../docs/archive/review-stage-robustness-validation/)
- [roadmap-navigation-polish.md](../docs/archive/roadmap-navigation-polish.md)
- [scope-keyed-sessions-validation/](../docs/archive/scope-keyed-sessions-validation/)
- [dedupe-investigations.md](../docs/archive/dedupe-investigations.md) — archived 2026-05-11; live followups extracted to `audit-dedupe-followups.md`
- [subtree-audit-proposals-spec.md](../docs/archive/subtree-audit-proposals-spec.md) — archived 2026-05-11 (superseded by `audit-pipeline.md`)
- [audit-actions-and-tracking.md](../docs/archive/audit-actions-and-tracking.md) — archived 2026-05-11 (superseded by `audit-pipeline.md`)
- [audit-action-recommended.md](../docs/archive/audit-action-recommended.md) — archived 2026-05-11 (superseded by `audit-pipeline.md`)
- [coordinator-delegation-via-convoy-spec.md](../docs/archive/coordinator-delegation-via-convoy-spec.md) — archived 2026-05-11 (superseded by `task-delegation-and-convoys.md`)
- [convoy-mode-spec.md](../docs/archive/convoy-mode-spec.md) — archived 2026-05-11 (superseded by `task-delegation-and-convoys.md`)
- [parallel-build-isolation-spec.md](../docs/archive/parallel-build-isolation-spec.md) — archived 2026-05-11 (superseded by `task-delegation-and-convoys.md`)

## Consolidation progress

### Done (drift-fix pass 2026-05-11)

- ✅ Archived 17 historical artifacts to `docs/archive/`; rewrote all internal references.
- ✅ Merged `autopilot-build-pipeline-spec.md` → `product-autopilot-spec.md` §3.5 / §3.7; deleted source.
- ✅ Merged `memory.md` intro → `memory-layer.md`; deleted source.
- ✅ Rewrote `agent-health-overhaul-spec.md` against shipped `src/lib/agent-health.ts`; renamed to `agent-health.md`.
- ✅ Fixed `workspace-conventions-structured.md` §6 drift (dropped phantom `workspace_conventions_proposals` table).
- ✅ Added supersession banner + revised §7 / §9 / §10 status notes in `convoy-mode-spec.md`.
- ✅ Added `status: aspirational` frontmatter + visible banner to 7 SpecPage-backed specs (calendar, workflows, risk-management, stakeholders-comms, decisions-assumptions, memory-layer, gardener).

### Remaining

**Annotate**:
- `roadmap-and-pm-spec.md` — add "post-merge addenda" pointer at top to layered specs (audit-action-recommended, pm-revertable-proposals).

**New specs to write (gaps)**:
- ✅ `audit-dedupe-followups.md` (extracted 2026-05-11; parent archived).
- ✅ `pm-diff-conventions.md` (extracted 2026-05-11).
- ~~`pm-steer-abort.md`~~ — not needed; PR B turned out to be shipped. `pm-chat-prompt.md` rewritten to reflect.
- `foia-pipeline-build-plan.md` — when work resumes, pair the aspirational `foia-pipeline.md` with a structured-feature-dev build plan per CLAUDE.md.

**Out-of-band fold-in (deferred)**:
- Fold `audit-action-recommended.md` into `subtree-audit-proposals-spec.md` as a §4.6 "audit_verdict (narrow-mode bridge)" subsection. Both are class 1; consolidation is cosmetic, not a drift fix.

## Remaining punch-list items

1. **`subtree-audit-proposals-spec.md` §9.2 Q4** — spec flagged needing a regression test on `findInFlightAudits` filtering by `source_kind='fanout'`; not visibly addressed in shipping commits.
2. **`mcp-surface-review.md` PRs 3 / 3.5 / 6 unverified** — no `openclaw:apply-mc-servers` / `openclaw:sync-named-agents` scripts found; PM SOUL doesn't codify the "extend `propose_changes`, don't add new tools" principle by name. Either land them or strike them from the queue.
3. **`workflow_templates` table name collision** — legacy stages-config table at `src/lib/db/migrations.ts:240` shares its name with the future DAG primitive in `workflows.md`. Rename one before workflows ships.

The three high-priority class-3 drift items (workspace-conventions, autopilot-build-pipeline, agent-health-overhaul) from the previous punch list have all been resolved this pass.

## Cross-cluster overlap themes (carried over)

- **PmDiff capture/revert pattern** — `pm-revertable-proposals` ↔ archived `pm-confirm-task-done` ↔ `audit-action-recommended`. Three specs re-derive the same convention. Target for `pm-diff-conventions.md`.
- **Audit pipeline** — `subtree-audit-proposals` ↔ `audit-action-recommended` ↔ `audit-actions-and-tracking` ↔ archived `initiative-investigate` ↔ `dedupe-investigations` all touch the same `agent_notes` body schemas, MCP `take_note` surface, and the `agent_runs` envelope.
- **Memory cluster** — `memory-layer.md` ↔ `gardener.md` ↔ `decisions-assumptions.md` §Integrations ↔ `stakeholders-comms.md` open questions — all predicated on the same unbuilt `memory_entries` substrate.
- **Aspirational hub cluster** — `workflows`, `risk-management`, `decisions-assumptions`, `stakeholders-comms`, `calendar` all share the `/X` SpecPage placeholder pattern and assume each other as integration points.
