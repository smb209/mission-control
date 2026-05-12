# Mission Control — System Documentation

Audience: **AI subagents primarily, operator secondary.** Every reference doc carries YAML frontmatter with `code-anchors` pointing at the load-bearing source files, so a subagent encountering an unfamiliar capability can read the doc and follow the anchors instead of grepping the codebase.

## Tree

| Folder | Purpose | When to read | When to edit |
|---|---|---|---|
| [`reference/`](reference/) | Current shipped capability docs. `status: current`. Canonical "how does X work today" surfaces. | Before changing code in an area; cite the doc's `code-anchors`. | When the underlying code changes — bump `last-verified` at minimum. |
| [`proposals/`](proposals/) | Aspirational designs not yet built. `status: aspirational`. Many are surfaced in-app via the SpecPage component. | When considering whether to build X. | When the proposal is refined, OR when work starts (promote to `reference/`). |
| [`decisions/`](decisions/) | ADRs — short, dated, immutable records of non-obvious decisions. | When asking "why is X this way?" | Never edit accepted ADRs. Supersede by writing a new ADR. See [`decisions/README.md`](decisions/README.md). |
| [`archive/`](archive/) | Historical: shipped build plans, validation passes, superseded specs. Retained for context. | If you need pre-cutover design rationale. | Don't. These are frozen. |

## Frontmatter contract

```yaml
---
status: current | aspirational | archived | superseded
last-verified: 2026-05-11
audience: ai-subagents-primary, operator-secondary
code-anchors:
  - src/path/to/load_bearing.ts
  - src/path/to/migrations.ts:4520-4540
mcp-tools: [tool_a, tool_b]
db-tables: [table_a]
migrations:
  - "NNN description — migrations.ts:NNNN"
related-specs:
  - other-spec.md — relationship in 5 words
---
```

`yarn docs:check` validates the schema and confirms every `code-anchors` path exists. Files without frontmatter are skipped so the tree can migrate gradually. CLAUDE.md tells subagents to update specs in the same PR as code edits to anchor files.

## Active reference docs

| Spec | Topic |
|---|---|
| [agent-health.md](reference/agent-health.md) | Health states, stalled/stuck/zombie semantics, escalation cycle |
| [audit-pipeline.md](reference/audit-pipeline.md) | Survey + synthesizer, note kinds, verdict + auto-spawn, narrow-vs-subtree post-cutover |
| [autonomous-flow-tightening-spec.md](reference/autonomous-flow-tightening-spec.md) | `task_evidence`, `submit_evidence`, role souls, evidence gates |
| [autopilot-resilience-and-activity-feed.md](reference/autopilot-resilience-and-activity-feed.md) | Research/ideation cycles, recovery routine |
| [cascade-rules.md](reference/cascade-rules.md) | DB cascade matrix; enforced by `schema-cascade.test.ts` |
| [jobs-in-progress.md](reference/jobs-in-progress.md) | `/jobs` page + `agent_runs`-backed long-running job view |
| [long-unattended-feature-dev.md](reference/long-unattended-feature-dev.md) | 4-doc pattern (spec + build-plan + validation/00-04 + results) |
| [pm-chat-prompt.md](reference/pm-chat-prompt.md) | PM SOUL prompt, one-at-a-time UI, steer/abort + in-flight SSE |
| [pm-diff-conventions.md](reference/pm-diff-conventions.md) | `PmDiff` union, capture/invert pattern, 7-step add-a-kind contract |
| [pm-revertable-proposals.md](reference/pm-revertable-proposals.md) | `reverts_proposal_id`, revert trigger, `/pm/activity` |
| [research-area.md](reference/research-area.md) | Topics/briefs/runs envelope, suggest, scheduling, initiative integration |
| [review-stage-robustness-spec.md](reference/review-stage-robustness-spec.md) | Roster gate, strict gating, governance hooks, `escalate_to_parent`, autobounce |
| [roadmap-and-pm-spec.md](reference/roadmap-and-pm-spec.md) | Initiatives schema, PM agent, MCP tools, standup, `/pm` + `/roadmap` |
| [scope-keyed-sessions.md](reference/scope-keyed-sessions.md) | `dispatchScope`, agent_notes spine, agent_role_overrides, per-workspace PMs |
| [scope-keyed-sessions-phase-j.md](reference/scope-keyed-sessions-phase-j.md) | `dispatchSubagent` primitive, active-subagent manifest |
| [task-delegation-and-convoys.md](reference/task-delegation-and-convoys.md) | `spawn_subtask`, convoy lifecycle, workspace isolation, mailbox, rollcall |
| [timestamp-handling.md](reference/timestamp-handling.md) | `<Time>` component, `display_timezone`, ISO-Z normalization |
| [workspace-conventions-structured.md](reference/workspace-conventions-structured.md) | Templates, resolver, refine return-inline persistence |

## Active proposals (aspirational)

| Spec | Status |
|---|---|
| [audit-dedupe-followups.md](proposals/audit-dedupe-followups.md) | Generalize `run_cancelled` guard beyond `take_note`; close brief-dispatch dedupe gap |
| [calendar.md](proposals/calendar.md) | `CalendarEntry` table, PmDiff kinds, MCP tools, `/calendar` views |
| [decisions-assumptions.md](proposals/decisions-assumptions.md) | Decision + Assumption tables, `/decisions` hub |
| [foia-pipeline.md](proposals/foia-pipeline.md) | FOIA agencies/requests/correspondence (separate-scope) |
| [gardener.md](proposals/gardener.md) | Memory curation role (promote/prune/verify) |
| [memory-layer.md](proposals/memory-layer.md) | `memory_entries` substrate, scoped retrieval into dispatch |
| [product-autopilot-spec.md](proposals/product-autopilot-spec.md) | Phase 3-4 — post-launch ops, full-loop autopilot |
| [risk-management.md](proposals/risk-management.md) | Risk + ScoreHistory + Sweep tables, `/risks` heatmap |
| [stakeholders-comms.md](proposals/stakeholders-comms.md) | Stakeholder + Draft + UpdatePlan tables, `/stakeholders` |
| [subagent-orchestration.md](proposals/subagent-orchestration.md) | `spawn_subagent` tool, `subagent_runs` table — only J1 primitive shipped |
| [workflows.md](proposals/workflows.md) | DAG editor, node maturity ladder, escalation sink |

## ADRs

See [`decisions/README.md`](decisions/README.md) for the full index. Eight ADRs currently:

1. Migrations are append-only after recording
2. `spawn_subtask` replaces `delegate`; multiple convoys per parent
3. PM dispatch is async; placeholder + reconciler
4. Workspace refine returns inline; persistence via settings PATCH
5. `take_note` is the only tool that hard-blocks cancelled-run writes
6. Subtree audit is a hard cutover; `mode='subtree'` returns 400
7. PmDiff state lives in `proposed_changes` JSON, not a separate table
8. `agent_runs` is the general dispatch envelope; briefs opt out

## Archive

`docs/archive/` holds shipped build plans, validation directories, and superseded specs. Each archived doc has a supersession banner pointing at its replacement. The original spec audit reports (initial pass that drove this restructure) are preserved under `docs/archive/audit-reports/`.

## Counts

- 18 current reference docs
- 11 aspirational proposals
- 8 ADRs
- 42 archived artifacts
