---
status: aspirational
last-verified: 2026-05-13
audience: ai-subagents-primary, operator-secondary
code-anchors:
  - src/lib/mcp/shared.ts:285-299
  - src/lib/db/pm-proposals.ts
  - src/lib/agents/pm-agent.ts
  - src/lib/convoy.ts
  - src/lib/mcp/groups/work.ts:1565-1872
  - src/lib/services/task-status.ts:78-192
  - src/app/api/pm/proposals/[id]/accept/route.ts
  - src/components/DecomposeWithPmModal.tsx
  - src/components/DecomposeStoryToTasksModal.tsx
  - src/components/PlanWithPmPanel.tsx
mcp-tools: [propose_changes, plan_convoy, spawn_subtask]
db-tables: [pm_proposals, convoys, convoy_subtasks, tasks, initiatives]
related-specs:
  - pm-diff-conventions.md — adds the new diff kind to that table
  - task-delegation-and-convoys.md — shifts decomposition upstream from coordinator
  - roadmap-and-pm-spec.md — PM's decompose-flow output changes shape
  - pm-revertable-proposals.md — revert semantics for the new diff kind
  - review-stage-robustness-spec.md — parent review→done gets the AC gate
---

# PM convoy mandate — decomposition produces convoys, not flat task lists

## Status

Aspirational. The mandate replaces the current `decompose_story` / `decompose_initiative` / `plan_initiative` output shape (an array of `create_task_under_initiative` diffs) with a `create_convoy_under_initiative` diff carrying a slice DAG. The wholistic fix to two locality bugs we keep re-hitting.

## Problem

Mission Control today has **two decomposition steps**, and only the second one uses convoy machinery:

```
Story  →  PM emits flat list of create_task_under_initiative diffs  (no inter-task deps)
       →  Operator accepts → N independent task rows created
       →  Coordinator dispatched on one of them
       →  Coordinator emits spawn_subtask / plan_convoy        (gates appear HERE for the first time)
       →  Convoy slices run with dep + evidence gates
```

The gates exist (`depends_on_subtask_ids` since PR #344, `required_evidence_gates` per slice, parent auto-promote, `QUALITY_STAGES` evidence check) but they only operate **inside** a convoy. Everything **before** the convoy — i.e. the PM's actual story decomposition — is gate-free. Two failure modes we've audited:

1. **Layer-sliced narrow tasks** (PR #348 audit). The PM decomposed "In-flight proposal card replaces synth-as-placeholder" into 4 tasks, one of which was "Implement cancel endpoint POST /api/pm/proposals/[id]/cancel". The builder shipped exactly that endpoint and stopped. The convoy was locally correct (1 builder slice, 7 acceptance criteria, all green) and globally wrong (no SSE broadcast, no frontend wiring, no dispatcher short-circuit, no orphan-sweep exclusion). Each layer was locally consistent; the system had no notion of feature-level completeness.

2. **No sibling ordering at the PM layer.** [`src/lib/mcp/shared.ts:285-299`](../src/lib/mcp/shared.ts) defines `create_task_under_initiative` without a `depends_on` field. The PM cannot express "task B waits for task A" inside a `propose_changes` call. The only way to get ordered, gated, multi-step work is to skip task creation and dispatch a coordinator who'll emit a convoy. So coordinator decomposition is doing double duty as both delegation and dependency planning, and the PM's plan is impoverished.

The bug class is structural, not a one-off. SOUL-prompt nudges to "be a better decomposer" are bandaids — they patch each instance, the system stays unable to express what the operator needs.

## The mandate

When the PM emits a `propose_changes` call with `trigger_kind ∈ {decompose_story, decompose_initiative, plan_initiative}`, it MUST emit at least one `create_convoy_under_initiative` diff and MUST NOT emit `create_task_under_initiative` diffs. The zod refinement on [`shared.ts`](../src/lib/mcp/shared.ts) enforces this server-side.

Every multi-step work output from PM decomposition is now a DAG with explicit deps, per-slice acceptance criteria, and parent-level acceptance criteria the convoy must satisfy before auto-promoting the parent task to `done`.

### Carve-outs

`create_task_under_initiative` survives, but only from non-decomposition contexts:

| trigger_kind | Allowed diff kinds for task creation |
|---|---|
| `decompose_story`, `decompose_initiative`, `plan_initiative` | `create_convoy_under_initiative` only |
| `notes_intake` | `create_task_under_initiative` (scattered tactical capture across initiatives; not coordinated work) |
| `manual` | `create_task_under_initiative` (operator-driven; not PM decomposition) |
| Audit follow-ups, `audit_finding`-triggered proposals | `create_task_under_initiative` (tactical, not strategic) |
| `create_child_initiative` placeholder pattern | `create_task_under_initiative` still works for stubs against just-proposed child initiatives — those tasks are registered for FUTURE decomposition, not as the decomposition output |

The distinction is already encoded in `trigger_kind` on the proposal row, so the rule is mechanically enforceable.

### Single-slice convoys are allowed and UI-collapsed

A story that genuinely is "one builder owns this end-to-end" decomposes to a 1-slice convoy. Convoy machinery underneath, plain-task surface above. The Task Board renders 1-slice convoys as if they were the parent task; the Convoy tab elides the ceremony. Schema stays uniform; UX stays light.

## Data model

### New diff kind: `create_convoy_under_initiative`

Add to [`src/lib/mcp/shared.ts`](../src/lib/mcp/shared.ts) `DiffSchema` union:

```ts
z.object({
  kind: z.literal('create_convoy_under_initiative'),
  initiative_id: z.string().min(1),
  // Symbolic-ref placeholders ($0..$N) for create_child_initiative in
  // the same proposal still resolve here, mirroring the current pattern.

  // Parent-level acceptance criteria the convoy must satisfy before the
  // parent task can transition from `review` to `done`. These are
  // operator-facing, feature-level — NOT the per-slice contract criteria.
  // Example: "Operator clicks Cancel on any InFlightProposalCard surface
  // → card disappears + late agent reply doesn't resurrect."
  parent_acceptance_criteria: z.array(z.string().min(10).max(500)).min(1),

  // The DAG. Mirrors plan_convoy's slice schema (same fields the
  // coordinator-driven path uses today) so a single apply-pass helper
  // serves both entry points.
  slices: z.array(z.object({
    id: z.string().min(1).max(40).regex(/^[a-zA-Z0-9_-]+$/),
    role: z.string().min(1).optional(),
    peer_agent_id: z.string().min(1).optional(),
    peer_gateway_id: z.string().min(1).optional(),
    slice: z.string().min(10).max(500),
    message: z.string().min(1).max(10000),
    expected_deliverables: z.array(z.object({
      title: z.string().min(1).max(200),
      kind: z.enum(['file', 'note', 'report']),
    })).min(1),
    acceptance_criteria: z.array(z.string().min(10).max(500)).min(1),
    expected_duration_minutes: z.number().int().min(5).max(240),
    checkin_interval_minutes: z.number().int().min(5).max(60).optional(),
    depends_on: z.array(z.string().min(1).max(40)).optional(),
    // Per-slice evidence gate override; default ['test_full'] for tester
    // slices, none for others. Inherits today's convoy_subtasks behavior.
    required_evidence_gates: z.array(z.string()).optional(),
  })).min(1).max(12),
}),
```

DAG validation (Kahn's topological sort, cycle detection, peer resolution) reuses the same code path as `plan_convoy` — see [`src/lib/mcp/groups/work.ts:1565-1872`](../src/lib/mcp/groups/work.ts).

### Schema additions to `pm_proposals` table

None directly — the convoy plan lives in `proposed_changes` JSON. Apply-pass materializes it.

### Schema additions to `convoys` table

```sql
ALTER TABLE convoys ADD COLUMN acceptance_criteria TEXT;
-- JSON array of strings. Populated when the convoy is spawned from
-- a create_convoy_under_initiative diff. NULL for coordinator-spawned
-- convoys (back-compat).
```

### Apply pass: zod-validated `acceptProposal`

When a proposal accept walks a `create_convoy_under_initiative` diff:

1. Resolve `initiative_id` (real or placeholder `$N` from a sibling `create_child_initiative` diff in the same proposal).
2. Find-or-create the parent task for the initiative (mirrors `promote_initiative_to_task` semantics — story-kind initiatives without a task row get one created at this moment).
3. Validate the DAG (cycles, unknown refs, peer resolution). Identical to `plan_convoy`'s validation.
4. Create the `convoys` row with `acceptance_criteria` populated from the diff.
5. Create per-slice `tasks` + `convoy_subtasks` rows in topological order with resolved `depends_on_subtask_ids`. Reuses [`spawnDelegationSubtask`](../src/lib/convoy.ts).
6. Call `dispatchReadyConvoySubtasks(convoyId)` to fire root slices. Dep gate (PR #344) keeps dependents in `inbox`.

The atomic-fail-on-validation invariant is critical: if any slice's peer resolution fails or any cycle is detected, the entire diff rejects and nothing materializes. Today's behavior (apply N tasks, leave whichever ones validated) is replaced by all-or-nothing.

## Gate at parent `review → done`

The convoy auto-promote ([`checkConvoyCompletion`](../src/lib/convoy.ts) line 230-264) currently flips the parent task to `review` when all subtasks reach `done`. This is the existing rail. The operator-driven `review → done` click becomes the AC gate.

Add a check in [`src/lib/services/task-status.ts`](../src/lib/services/task-status.ts):

```ts
// In transitionTaskStatus, after the existing QUALITY_STAGES evidence
// check, before the actual UPDATE:
if (newStatus === 'done' && !boardOverride) {
  const convoy = queryOne<{ acceptance_criteria: string | null }>(
    `SELECT acceptance_criteria FROM convoys WHERE parent_task_id = ? AND status = 'done'`,
    [taskId],
  );
  if (convoy?.acceptance_criteria) {
    return {
      ok: false,
      code: 'parent_ac_check_pending',
      error: `Parent task has convoy ACs requiring explicit review. Operator must acknowledge each before transitioning to done.`,
    };
  }
}
```

The frontend transitions become two-step: operator sees parent task in `review`, opens the AC review surface, ticks each criterion (or types why it's not satisfied), then transitions to `done`. The "tick each AC" surface is a small modal — much simpler than the convoy plan approval surface.

`board_override: true` bypasses the AC check (operator escape hatch). Same pattern as evidence gate bypass today.

## UX surface: operator-approves-the-DAG

The current [`DecomposeWithPmModal`](../src/components/DecomposeWithPmModal.tsx) renders a checkbox list of `create_task_under_initiative` diffs. The new shape is a slice DAG. V1 UX:

- Slices rendered in topological order, top-to-bottom.
- Each slice row shows: role, slice title, expected duration, deliverable count, and a `depends on: X, Y` label.
- Parent acceptance criteria rendered as a separate section above the slices (the feature-level contract).
- Accept button labeled "Plan and dispatch convoy (N slices)" — clearer blast radius than the current "Accept all 4 draft tasks."
- Refine input behaves the same way it does today (revises the proposal; details below).

DAG visualization (arrows, swim lanes) is future polish. Topological list with explicit deps is enough for V1.

### Two-stage commit (optional)

For high-stakes parents the Accept button can split into "Accept plan" (creates convoy in `paused` status, no dispatch) and "Dispatch" (flips to `active`, fires root slices). Reduces blast radius and gives the operator time to review the plan before agents start running. Defer to V2.

## Refine semantics

`POST /api/pm/proposals/[id]/refine` creates a child proposal with revised content. Refining a convoy proposal:

- **Before any slice dispatches** (`status='draft'`, convoy not yet spawned): replace the entire DAG. Easy — the child proposal carries the new plan.
- **After dispatch starts** (any slice is `assigned`/`in_progress`/`done`): use [`addSubtasks`](../src/lib/convoy.ts) to append new slices to the existing active convoy. The previous DAG isn't replaced; the convoy grows. Symbolic deps in the refined proposal resolve against the existing convoy's subtask ids.

Both paths inherit the dedupe-by-existing-draft-child guard from PR #343.

## PM SOUL changes

`agent-templates/pm/SOUL.md` (or the equivalent prompt loaded by the PM agent):

- Add a "decomposition output contract" section:
  > **When you decompose a story or initiative**, emit a single `create_convoy_under_initiative` diff carrying the full DAG. Do NOT emit a flat list of `create_task_under_initiative` diffs — that path is reserved for notes-intake and tactical follow-ups, and the schema will reject it from a decompose-flow proposal.
- Add a "DAG smell checklist" the PM consults before emitting:
  > Before emitting the convoy diff, check: does every slice have observable operator-facing behavior on its own? A bare "endpoint" or "component" slice without its consumer slice is a smell — fuse them, or add the consumer slice explicitly with a `depends_on`. If a slice's acceptance criteria are all contract-shaped (status codes, type fields, function signatures) and none are feature-shaped (operator can click X, the system does Y), the slice is too narrow.
- Add a "parent ACs are feature-level" instruction:
  > Each `create_convoy_under_initiative` diff must include `parent_acceptance_criteria` — these are the operator's observable criteria for the feature being done, not per-slice contract criteria. Example good AC: "Operator clicks Cancel on any in-flight proposal card → card disappears and late agent reply doesn't resurrect." Example bad AC: "Endpoint returns 200 on valid input."

## Coordinator SOUL changes

`agent-templates/coordinator/SOUL.md` becomes narrower:

- Remove the "decompose the parent task" responsibility. Decomposition happens at PM-emit time.
- Coordinator's job: monitor convoy slices via `list_my_subtasks`, accept delivered slices via `update_subtask({action: 'accept'})`, reject on miss, escalate failures.
- The `spawn_subtask` and `plan_convoy` tools remain available for follow-up work discovered mid-flight (a builder reports a missing slice; coordinator can append). Not the primary decomposition path.

## Migration plan

Phased. None of these need to land atomically.

### Phase 1 — bandaid (1-2 days)

- SOUL nudges: "no naked-endpoint tasks" for the PM, "broaden if parent's intent is wider than the task description" for the coordinator.
- Parent-task ACs as advisory metadata on the existing `create_task_under_initiative` apply pass — store on the task row, surface in the UI, no enforcement.

These help today's decompositions without touching the schema. Buy time.

### Phase 2 — structural mandate (~1 week)

- Add `create_convoy_under_initiative` diff kind + zod schema.
- Add `convoys.acceptance_criteria` column.
- Apply-pass: route the new diff through `spawnDelegationSubtask` loop.
- PM SOUL updates to emit the new diff for decompose flows.
- Schema refinement that REJECTS `create_task_under_initiative` in decompose-flow proposals.
- DAG approval UX in the three modals/panels.
- Parent `review → done` AC check.

### Phase 3 — cleanup (~3 days, can lag)

- Task Board renders convoy slices as first-class rows (with parent-task collapse for 1-slice convoys).
- Coordinator SOUL shrinks to monitor + accept + escalate.
- Historical `create_task_under_initiative` diffs from decompose-flow proposals stay valid (no data migration needed) — only forward emissions are constrained.
- Spec edits per the table below.

## Edge cases handled

- **Cross-initiative decomposition.** PM may emit multiple `create_convoy_under_initiative` diffs in one proposal (one per target initiative). Schema rule: each diff targets exactly one initiative. Operator reviews K convoy plans on one Accept.
- **Story has no parent task yet.** Apply-pass auto-creates the parent task at spawn time (mirrors `promote_initiative_to_task`).
- **Failed slice → rework.** Existing `update_subtask({action: 'reject'})` flow unchanged.
- **`create_child_initiative` + tasks under it.** PM can still emit child-initiative + placeholder tasks against it in a notes-intake proposal. The tasks are stubs, not decomposition output. Convoy mandate doesn't apply.
- **Operator manually creates tasks.** Not a PM emission. Unaffected.
- **Audit follow-ups.** `audit_finding`-triggered proposals are tactical, not strategic. Mandate doesn't apply.
- **Workflow templates and convoy interaction.** PR #346 already removed `workflow_template_id` from convoy children. The mandate continues that — parent stories have no workflow template either, only convoy ACs.

## Open questions / things to settle before Phase 2

- Two-stage commit (Accept plan → Dispatch) or single-stage? Single-stage matches today's friction profile; two-stage is safer. Lean: single-stage for V1, add a feature flag for two-stage.
- DAG editing in the approval modal. V1: read-only display of the PM's proposal; operator can `/refine` to revise. V2: inline slice edit / remove / add.
- Should `plan_convoy` (the coordinator's MCP tool) survive once the PM is the primary convoy emitter? Yes — coordinators still need it for mid-flight slice appends and for tasks that were created via non-PM paths.
- Should the AC check use a free-text "why each AC is satisfied" or a checkbox? Free-text is more honest, checkbox is faster. Lean: free-text required for ACs that aren't auto-verifiable; checkbox-only is too easy to bypass.

## Specs that need edits when this ships

| Spec | Edit | Severity |
|---|---|---|
| [`docs/reference/pm-diff-conventions.md`](../docs/reference/pm-diff-conventions.md) | Add `create_convoy_under_initiative` row to the diff-kind table; add "decompose-flow-only / non-decompose-flow-only" column or note; document the new shape. | Material |
| [`docs/reference/task-delegation-and-convoys.md`](../docs/reference/task-delegation-and-convoys.md) | Note that convoys now have two entry points (PM-emit at proposal-accept time AND coordinator `spawn_subtask`/`plan_convoy` for mid-flight); shrink the coordinator's described scope; document `convoys.acceptance_criteria`. | Material |
| [`docs/reference/roadmap-and-pm-spec.md`](../docs/reference/roadmap-and-pm-spec.md) | Section ~line 499 describes today's flat-list decompose output. Replace with the convoy mandate; describe the parent-task auto-create-on-accept; describe `parent_acceptance_criteria`. | Material |
| [`docs/reference/pm-revertable-proposals.md`](../docs/reference/pm-revertable-proposals.md) | Define `invertDiff` for `create_convoy_under_initiative`: cancel the convoy + delete unscheduled child tasks; refuse revert if any slice has reached `done`. Material edit to [`src/lib/pm/invertDiff.ts`](../src/lib/pm/invertDiff.ts) needed alongside the spec. | Material |
| [`docs/reference/review-stage-robustness-spec.md`](../docs/reference/review-stage-robustness-spec.md) | Document the parent `review → done` AC gate; how it composes with evidence gate; how `board_override` bypasses. | Material |
| `docs/reference/pm-chat-prompt.md` (and any pm SOUL file under `agent-templates/pm/`) | Add the decompose-flow output contract, the DAG smell checklist, and the parent-AC instruction. | Material |
| [`docs/reference/agent-model-cleanup.md`](../docs/reference/agent-model-cleanup.md) | Coordinator described as decomposer; needs the role-shift (monitor + accept + escalate). | Light |
| [`docs/reference/audit-pipeline.md`](../docs/reference/audit-pipeline.md) | Add an explicit "audit follow-ups bypass the convoy mandate" note so future readers don't think the mandate applies universally. | Light |
| [`docs/reference/autonomous-flow-tightening-spec.md`](../docs/reference/autonomous-flow-tightening-spec.md) | Verify nothing in the autonomous flow assumes coordinator-led decomposition. Likely a frontmatter `last-verified` bump after a re-read; no content edit. | Light / re-verify |
| [`docs/proposals/subagent-orchestration.md`](../docs/proposals/subagent-orchestration.md) | Re-read for overlap. Aspirational doc; might be subsumed by this proposal or might describe an adjacent layer. Decide at Phase 2 ship time. | Re-read |

When this proposal is promoted to `reference/` (Phase 2 ships), file gets renamed `pm-convoy-mandate.md` → stays the same name; `status: aspirational` → `current`; `last-verified` updated.

## Acceptance for "this proposal itself ships"

- [ ] Phase 1 (SOUL nudges + advisory ACs) merged.
- [ ] Phase 2 schema + apply-pass + UX merged behind a feature flag (`MC_PM_CONVOY_MANDATE=1`).
- [ ] Schema validator rejects `create_task_under_initiative` in decompose-flow proposals when the flag is on.
- [ ] AC gate enforces parent `review → done`.
- [ ] DAG approval UX renders and accepts; refine semantics tested for both pre- and post-dispatch.
- [ ] One real-world dogfood: the PM uses this flow to decompose a follow-up to this proposal itself.
- [ ] Spec edits per the table above land in the same PR as Phase 2.
- [ ] Phase 3 cleanup (Task Board, coordinator SOUL) merged.

Then this file moves to `docs/reference/`.
