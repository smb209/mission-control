# Spec Audit — 2026-05-11

Audit of every spec file against current code on `main` (after `feat/audit-action-recommended` merged as #326).

**Updates:**
- **2026-05-11** initial audit run.
- **2026-05-11 (post-merge of #326)** `audit-action-recommended.md` reclassified 2 → 1.
- **2026-05-11 (drift-fix pass)** 17 historical artifacts moved to `docs/archive/`; `memory.md` + `autopilot-build-pipeline-spec.md` merged & deleted; `agent-health-overhaul-spec.md` rewritten and renamed to `agent-health.md`; `workspace-conventions-structured.md` §6 rewritten to match shipped `refine.ts`; `convoy-mode-spec.md` §7 banner + body replaced; 7 aspirational specs got `status: aspirational` frontmatter banners.
- **2026-05-11 (research deep-dive)** `research-area.md` rewritten as a 598-line comprehensive reference for the entire research capability; reclassified 2 → 1.

Detailed per-cluster reports (from the initial audit, pre-drift-fix) live under [`specs/audit-reports/`](audit-reports/).

## Classification rubric

1. **Current & accurate** — describes shipped behavior; matches code.
2. **Current & aspirational** — describes intended behavior, partially or wholly unimplemented.
3. **Feature drift** — spec describes shipped behavior that has since changed.
4. **Historical / superseded** — one-time build plan or validation pass; lives in `docs/archive/`.

## Counts (post drift-fix)

| Class | Count |
|---|---|
| 1. Current & accurate | 20 |
| 2. Current & aspirational | 13 |
| 3. Feature drift | 0 |
| 4. Historical / superseded (in `docs/archive/`) | 17 |
| **Total** | **50** |

Two specs deleted in the drift-fix pass: `memory.md` (merged into `memory-layer.md`), `autopilot-build-pipeline-spec.md` (merged into `product-autopilot-spec.md`).

## Per-spec verdict table

### Active specs (`specs/`)

| Spec | Class | Rationale |
|---|---|---|
| [agent-health.md](agent-health.md) | 1 | Rewritten 2026-05-11 to match `src/lib/agent-health.ts`; appendix lists original unshipped proposals |
| [audit-action-recommended.md](audit-action-recommended.md) | 1 | Shipped in #326 — `audit_verdict` NoteKind, migration 093 (`workspaces.audit_auto_spawn_pm`), `maybeAutoSpawnPmFromVerdict` hook |
| [audit-actions-and-tracking.md](audit-actions-and-tracking.md) | 1 | All six PRs landed (note-lifecycle DAO, runs strip, Ask-PM, NotesRail archive toggle) |
| [autonomous-flow-tightening-spec.md](autonomous-flow-tightening-spec.md) | 1 | Slices match shipped code (`task_evidence` mig 058, `is_failed` 059, `runtime_kind` 060, role souls) |
| [autopilot-resilience-and-activity-feed.md](autopilot-resilience-and-activity-feed.md) | 1 | `research_cycles` phase columns + `ideation_cycles` shipped (`migrations.ts:1177-1212`) |
| [calendar.md](calendar.md) | 2 | Aspirational banner added; `/calendar` is a SpecPage stub |
| [cascade-rules.md](cascade-rules.md) | 1 | Backed by live guardrail test (`src/lib/db/schema-cascade.test.ts`) |
| [convoy-mode-spec.md](convoy-mode-spec.md) | 2 | §7 supersession banner added 2026-05-11 (now points to coordinator-delegation-via-convoy); §9 + §10 status notes added; some §8 / §9 driver use still light |
| [coordinator-delegation-via-convoy-spec.md](coordinator-delegation-via-convoy-spec.md) | 1 | `spawn_subtask` shipped (`work.ts:1146`); `delegate` removed; UNIQUE on `convoys.parent_task_id` dropped (`migrations.ts:2110`) |
| [decisions-assumptions.md](decisions-assumptions.md) | 2 | Aspirational banner added; `/decisions` is a SpecPage stub |
| [dedupe-investigations.md](dedupe-investigations.md) | 2 (residual) | PR #1 shipped; #2 (dispatch-time 409 guard) and #3 (UI cooldown) still open by design. Keep as live backlog until extracted to `audit-dedupe-followups.md` |
| [foia-pipeline.md](foia-pipeline.md) | 2 | Zero code: no `foia_*` tables, no FOIA MCP tools, no `/requests`/`/agencies` routes |
| [gardener.md](gardener.md) | 2 | Aspirational banner added; no gardener/curator agent; depends on unbuilt memory-layer |
| [jobs-in-progress.md](jobs-in-progress.md) | 2 | Migrations 080/081 + API + UI shipped; PR 5 sidebar pip / drill-down status uncertain |
| [long-unattended-feature-dev.md](long-unattended-feature-dev.md) | 1 | Cited by CLAUDE.md; 4-doc pattern observable in every archived `*-validation/` dir |
| [mcp-surface-review.md](mcp-surface-review.md) | 4 | Refactor PRs 1, 2, 4, 5 shipped; PR 3/3.5 (openclaw scripts) + PR 6 (PM SOUL doc) status uncertain |
| [memory-layer.md](memory-layer.md) | 2 | Aspirational banner added; no `memory_entries` table; absorbed `memory.md` intro |
| [parallel-build-isolation-spec.md](parallel-build-isolation-spec.md) | 1 | Workspace columns + `workspace-isolation.ts` shipped; strict mode enforced via autonomous-flow-tightening |
| [pm-chat-prompt.md](pm-chat-prompt.md) | 2 | PR A (SOUL prompt + 1-at-a-time UI) wired; PR B (`steerSession`/`abortSession`, in-flight SSE) absent |
| [pm-revertable-proposals.md](pm-revertable-proposals.md) | 2 | Slices 1/2/4 + capture pattern + revert pipeline shipped; verify activity-timeline UI matches §3 |
| [product-autopilot-spec.md](product-autopilot-spec.md) | 2 | Phase 1+2 shipped; Phase 3 ops + Phase 4 full-loop aspirational. Now incorporates merged `autopilot-build-pipeline-spec.md` content |
| [review-stage-robustness-spec.md](review-stage-robustness-spec.md) | 1 | All six slices (0–5) shipped — roster gate, strict gating, governance hooks, escalate_to_parent, autobounce, role souls |
| [risk-management.md](risk-management.md) | 2 | Aspirational banner added; `/risks` is a SpecPage stub |
| [roadmap-and-pm-spec.md](roadmap-and-pm-spec.md) | 1 | Phases 1–6 + Polish B shipped (initiatives schema, PM agent, MCP tools, standup, `/pm` and `/roadmap` routes) |
| [scope-keyed-sessions.md](scope-keyed-sessions.md) | 1 | Phases A–I shipped (`dispatchScope`, agent_notes spine, agent_role_overrides, per-workspace PMs) |
| [scope-keyed-sessions-phase-j.md](scope-keyed-sessions-phase-j.md) | 1 | `dispatchSubagent` primitive + active-subagent manifest shipped |
| [stakeholders-comms.md](stakeholders-comms.md) | 2 | Aspirational banner added; `/stakeholders` is a SpecPage stub |
| [subagent-orchestration.md](subagent-orchestration.md) | 2 | No `spawn_subagent` tool, no `subagent_runs` table; only the J1 primitive in `dispatch-subagent.ts` |
| [subtree-audit-proposals-spec.md](subtree-audit-proposals-spec.md) | 1 | Phases 1–6 all shipped (#284–#290 + #307); two §9.2 items honestly open |
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
- `audit-dedupe-followups.md` — capture dedupe-investigations' deferred PR #2 (dispatch-time 409 guard) and PR #3 (UI cooldown) before the parent is archived.
- `pm-diff-conventions.md` — promote the `PmDiffCapture` / `invertDiff` pattern that three specs all re-describe (`pm-revertable-proposals`, archived `pm-confirm-task-done`, `audit-action-recommended`) into one reference doc.
- `foia-pipeline-build-plan.md` — when work resumes, pair the aspirational `foia-pipeline.md` with a structured-feature-dev build plan per CLAUDE.md.
- `pm-steer-abort.md` — split `pm-chat-prompt.md` PR B into its own spec; PR A is shipped, PR B has no other home.

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
