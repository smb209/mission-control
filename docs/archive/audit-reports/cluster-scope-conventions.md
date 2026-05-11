# Cluster: Scope / Sessions / Memory / Conventions

## Verdict table

| Spec | Class | Rationale | Evidence |
|---|---|---|---|
| scope-keyed-sessions.md | 1 | Phases A–I shipped: scope_key dispatch, agent_notes spine, agent_role_overrides, per-workspace PMs. | src/lib/agents/dispatch-scope.ts:1-200; migrations.ts:3722,3749 |
| scope-keyed-sessions-phase-j.md | 1 | `dispatchSubagent` primitive + active-subagent manifest exist with tests. | src/lib/agents/dispatch-subagent.test.ts:1-69; briefing.ts:146,246 |
| scope-keyed-sessions-validation/ | 4 | Validation directory; archive candidate per rubric. | docs/archive/scope-keyed-sessions-validation/{00..04}.md |
| memory-layer.md | 2 | Schema/design fully unimplemented — no `memory_entries` table; `knowledge_entries` is the legacy substrate. | migrations.ts grep: zero `memory_entries`; only `knowledge_entries` |
| memory.md | 2 | Self-declared stub ("TBD … placeholder"). Reads as a roadmap shell. | specs/memory.md:1-26 |
| workspace-conventions-structured.md | 3 | PR1+PR2 shipped (templates dir, resolver, local_repo_init, repo_url, base_branch). PR3 refine exists at `refine.ts` but spec mentions `workspace_conventions_proposals` table that wasn't created; templates set missing `code.md` substitute is present but `code.md` does exist — spec drift on the proposals table. | src/lib/workspace-templates/*; src/lib/workspace-conventions/refine.ts; migrations.ts:4441 (082); no `workspace_conventions_proposals` migration |
| workflows.md | 2 | Aspirational. UI is a `SpecPage` placeholder; no workflow DAG engine, no nodes/edges/runs tables. (Note: legacy `workflow_templates` at migrations.ts:240 is the unrelated stages-config table, not this DAG concept.) | src/app/(app)/workflows/page.tsx renders SpecPage |
| cascade-rules.md | 1 | Reference doc backed by live guardrail test. | src/lib/db/schema-cascade.test.ts present; migration 048 cited |
| gardener.md | 2 | No `gardener` agent, no curator role, no promote/prune/verify jobs. Predicated on memory-layer which itself is aspirational. | No `src/lib/agents/gardener*`; no learner|gardener agents on disk |
| long-unattended-feature-dev.md | 1 | Matches reality; referenced by CLAUDE.md; the 4-doc pattern is observable in `scope-keyed-sessions-validation/` (00..04 files match exactly). | scope-keyed-sessions-validation/ has the prescribed 00–04 files |
| timestamp-handling.md | 1 | PR-A (DB read normalization) + PR-B (`<Time>`, `workspaces.display_timezone`, `timestamps.ts`) both shipped. | src/lib/timestamps.ts:1-20; src/components/Time.tsx; migrations.ts:4520 (086) |
| decisions-assumptions.md | 2 | Spec page placeholder only. No `decisions` / `assumptions` tables. | src/app/(app)/decisions/page.tsx is SpecPage |
| risk-management.md | 2 | Spec page placeholder only. No risk/score_history/sweep tables. | src/app/(app)/risks/page.tsx is SpecPage |
| stakeholders-comms.md | 2 | Spec page placeholder only. No stakeholder/draft/update_plan tables. | src/app/(app)/stakeholders/page.tsx is SpecPage |

## Per-spec notes

### scope-keyed-sessions.md  *(Class 1)*
- Spec claims: scope_key dispatch, agent_notes spine, agent_role_overrides, per-workspace PMs, no durable mc-* gateway agents.
- Code reality: `dispatchScope` is the live primitive (src/lib/agents/dispatch-scope.ts), agent_notes table created in migration 065 (migrations.ts:3749) and extended through migration 087, agent_role_overrides in migration 064 (migrations.ts:3722).
- Recommendation: keep as canonical reference. Consider trimming "Why" prose now that it's history.

### scope-keyed-sessions-phase-j.md  *(Class 1)*
- Spec claims: PM-as-parent worker dispatch via `sessions_spawn`, behind a flag.
- Code reality: `dispatchSubagent` primitive ships with tests (dispatch-subagent.test.ts); briefing manifests active subagents (briefing.ts:246).
- Recommendation: keep. Mark phase status if not already.

### scope-keyed-sessions-validation/  *(Class 4)*
- Archive candidate per `*-validation/` rubric. Numbered 00–04 files match `long-unattended-feature-dev.md` template exactly.

### memory-layer.md  *(Class 2)*
- Spec claims: `memory_entries` table with embeddings, org+initiative scopes, `getRelevantMemory()` injected into dispatch.
- Code reality: zero references to `memory_entries` in src/. Only `knowledge_entries` (the older confidence-weighted lessons table) exists. Dispatch does not inject scoped memory.
- Recommendation: keep as roadmap; rename to `memory-layer-roadmap.md` or annotate at top with "Not yet implemented." Cross-cluster: overlaps with `memory.md` stub and `decisions-assumptions.md` §Integrations.

### memory.md  *(Class 2)*
- Spec claims: stub for future memory system; self-declares "TBD."
- Recommendation: merge into `memory-layer.md` or delete once memory-layer is approved. Currently it's a nav-only placeholder.
- Cross-cluster overlap: `memory-layer.md`.

### workspace-conventions-structured.md  *(Class 3)*
- Spec claims: PR1 templates + resolver + AgentPromptPreview, PR2 columns (repo_url, default_base_branch, local_repo_init), PR3 refine via new `workspace_conventions_proposals` table.
- Code reality: PR1 + PR2 fully landed (src/lib/workspace-templates/{blank,code,research,writing,ops}.md, src/lib/workspace-conventions/resolve-variables.ts, migration 082 at migrations.ts:4441 adds local_repo_init). PR3 has `src/lib/workspace-conventions/refine.ts` shipped, but **no `workspace_conventions_proposals` migration exists** — proposals appear to flow through existing pm_proposals or refine returns directly. Templates list omits `research.md`/`writing.md` in the "Initial set" enumeration but they exist on disk.
- Recommendation: small update — confirm refine persistence shape vs. spec, and either add the table or amend the spec to reflect the chosen path.

### workflows.md  *(Class 2)*
- Spec claims: visual DAG editor with node maturity ladder (draft→solidified), `/workflows/[id]`, escalation sink, run traces.
- Code reality: `/workflows` is a `SpecPage` placeholder (src/app/(app)/workflows/page.tsx). No node/edge/run/escalation tables. `workflow_templates` table at migrations.ts:240 is the *legacy stages-config* table (planning→assigned→…), unrelated to this DAG concept — naming collision risk.
- Recommendation: keep aspirational; clearly label as not-yet-built. Rename the collision-prone legacy `workflow_templates` table mention internally, or note it explicitly in the spec.

### cascade-rules.md  *(Class 1)*
- Spec claims: cascade matrix is enforced by `src/lib/db/schema-cascade.test.ts`.
- Code reality: test file present.
- Recommendation: keep. Living reference.

### gardener.md  *(Class 2)*
- Spec claims: curation role over memory: promote / prune / verify / seed / disseminate / quarantine.
- Code reality: no gardener agent, no curator schemas, depends on the unbuilt memory-layer. Spec acknowledges "role, not necessarily new agent."
- Recommendation: keep as aspirational follow-on to memory-layer. Cross-cluster overlap with `memory-layer.md`.

### long-unattended-feature-dev.md  *(Class 1)*
- Spec claims: 4-doc pattern (spec + build-plan + validation/00–04 + results).
- Code reality: pattern observed in scope-keyed-sessions-validation/, autonomous-flow-validation-plan.md, research-area-validation/, mcp-surface-v2-validation/, etc. CLAUDE.md cites it.
- Recommendation: keep canonical.

### timestamp-handling.md  *(Class 1)*
- Spec claims: PR-A DB-read normalization to ISO-Z; PR-B `workspaces.display_timezone` + `src/lib/timestamps.ts` + `<Time>` + sweep.
- Code reality: timestamps.ts header (lines 1-20) explicitly cites "docs/reference/timestamp-handling.md §PR-B" and PR #281 for PR-A. Migration 086 added `display_timezone` (migrations.ts:4520). `<Time>` component present.
- Recommendation: keep as historical reference; consider moving to a `shipped/` folder later.

### decisions-assumptions.md  *(Class 2)*
- Spec claims: Decision + Assumption tables; `/decisions` hub with ADR rendering, supersession chains, sweep proposals.
- Code reality: `/decisions` is a `SpecPage` placeholder. No tables.
- Recommendation: keep as roadmap. Cross-cluster overlaps: `risk-management.md` (assumption→risk promotion), `memory-layer.md` (decisions-as-memory), `workflows.md` (`propose` sink).

### risk-management.md  *(Class 2)*
- Spec claims: Risk + ScoreHistory + Sweep tables; `/risks` heatmap dashboard; revertable proposals for adds/rescores.
- Code reality: `/risks` is a `SpecPage` placeholder. No risk tables.
- Recommendation: keep as roadmap. Cross-cluster overlaps: `decisions-assumptions.md`, `workflows.md` (sweep as workflow), `stakeholders-comms.md` (risk in updates).

### stakeholders-comms.md  *(Class 2)*
- Spec claims: Stakeholder + Draft + UpdatePlan tables; `/stakeholders` list; templates (weekly_status, investor_update, etc.).
- Code reality: `/stakeholders` is a `SpecPage` placeholder. No tables.
- Recommendation: keep as roadmap. Cross-cluster overlaps: `memory-layer.md`, `workflows.md` (event-triggered drafts).

## Cross-cluster overlap flags

- **Memory cluster collision**: `memory.md` (stub) ↔ `memory-layer.md` (full design) ↔ `gardener.md` (curator) ↔ `decisions-assumptions.md` §Integrations ("Memory") ↔ `stakeholders-comms.md` Open Questions ("Stakeholder ↔ Memory layer"). All assume the same unbuilt substrate.
- **Aspirational hub cluster**: `workflows.md` / `risks` / `decisions` / `stakeholders` all share the `/X` SpecPage placeholder pattern, all envision revertable-proposal-shaped flows. Each references the others (workflow `propose` sink → risks/decisions/calendar; risks `source: brief:<id>`; stakeholders sources cite risks/initiatives).
- **`workflow_templates` naming collision**: legacy stages-config table (migrations.ts:240) shares a name with the future workflows.md DAG primitive — risk of confusion when workflows.md is implemented.

## Consolidation suggestions

1. **Merge `memory.md` into `memory-layer.md`** — `memory.md` is a self-acknowledged stub that exists only for nav. Either delete or fold the "where this fits" framing into memory-layer.md's intro.
2. **Annotate aspirational specs with status banner**: workflows.md, decisions-assumptions.md, risk-management.md, stakeholders-comms.md, memory-layer.md, gardener.md all benefit from a one-line "Status: not yet built — `/X` page renders this doc" header so readers don't mistake them for living docs.
3. **Archive `scope-keyed-sessions-validation/`** under `specs/_archive/` once the parent stack is uncontested.
4. **Reconcile `workspace-conventions-structured.md` §6 with `refine.ts`**: either ship the `workspace_conventions_proposals` migration the spec calls for, or amend the spec to document the actual persistence (likely reuses pm_proposals).
5. **Rename collision**: when workflows.md gets built, the legacy `workflow_templates` table should be renamed (e.g. `task_stage_templates`) to free the name.
