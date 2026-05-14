---
status: current
last-verified: 2026-05-14
audience: ai-subagents-primary, operator-secondary
code-anchors:
  - src/lib/db/pm-proposals.ts
  - src/lib/pm/invertDiff.ts
  - src/lib/pm/invertDiff.test.ts
  - src/lib/db/pm-proposals.test.ts
  - src/lib/agents/pm-dispatch.ts
  - src/lib/agents/pm-soul.md
  - src/lib/db/migrations.ts
mcp-tools: [propose_changes]
db-tables: [pm_proposals]
related-specs:
  - roadmap-and-pm-spec.md — original PM design (Phase 5)
  - pm-convoy-mandate.md — create_convoy_under_initiative diff + decompose-flow mandate
  - pm-revertable-proposals.md — revert pipeline + capture pattern
  - audit-action-recommended.md — audit_verdict bridge (note kind, not diff kind)
  - autonomous-flow-tightening-spec.md — async dispatch overlay
  - ../docs/archive/pm-confirm-task-done.md — confirm_task_done diff kind (shipped)
  - ../docs/archive/pm-dispatch-async.md — pm_proposal_replaced / dispatch_state machinery
---

# PM Diff Conventions

> **Status: current as of 2026-05-11.** Canonical reference for the
> `PmDiff` discriminated union, the capture-for-revert pattern, and the
> contract for adding new diff kinds. Future specs that add a diff kind
> should cite **this** doc rather than re-derive the contract.

This is the single point of truth for the **diff layer** of the PM
system. It is not a primer on the PM agent's role (see
[`pm-soul.md`](../src/lib/agents/pm-soul.md)) or on the dispatch/SSE
machinery (see [`pm-dispatch.ts`](../src/lib/agents/pm-dispatch.ts) and
[docs/archive/pm-dispatch-async.md](../docs/archive/pm-dispatch-async.md));
it is a reference manual for everyone whose job is to **add a new diff
kind**, **invert one**, or **understand why a diff has a `prev_*`
field on it**.

---

## 1. What `PmDiff` is, in one paragraph

A **`PmDiff`** is one row in the JSON array stored on
`pm_proposals.proposed_changes` ([src/lib/db/pm-proposals.ts:92-201](../src/lib/db/pm-proposals.ts)).
It is emitted by the PM agent through the `propose_changes` MCP tool,
or synthesized by MC itself in the take_note auto-flow / plan /
decompose paths in [src/lib/agents/pm-dispatch.ts](../src/lib/agents/pm-dispatch.ts).
On operator accept, `acceptProposal` in
[src/lib/db/pm-proposals.ts:891-1174](../src/lib/db/pm-proposals.ts)
walks the array transactionally, validating then applying each diff
through `applyDiff` ([:1182-1353](../src/lib/db/pm-proposals.ts)) or
one of the two out-of-band pass-2 paths
(`applyCreateChildInitiative` and the `confirm_task_done` /
`create_task_under_initiative` cases inside `acceptProposal`'s loop).
**There is no separate `pm_diffs` table** — diffs are persisted only as
the JSON column on the parent proposal row. Capture state for revert
is written **in place** onto that JSON at apply time
([:1130-1135](../src/lib/db/pm-proposals.ts)).

---

## 2. The `PmDiff` discriminated union

Defined at [src/lib/db/pm-proposals.ts:92-201](../src/lib/db/pm-proposals.ts).
Each variant is an intersection of a literal-`kind`-tagged shape with
the `PmDiffCapture` interface ([:58-90](../src/lib/db/pm-proposals.ts))
so capture fields are uniformly optional across all kinds.

**Current `kind` values (11 total):**

> **Decompose-flow restriction (PM convoy mandate).** When
> `MC_PM_CONVOY_MANDATE=1`, proposals with `trigger_kind` ∈
> {`decompose_story`, `decompose_initiative`, `plan_initiative`} MUST
> emit at least one `create_convoy_under_initiative` diff and MUST NOT
> emit `create_task_under_initiative`. The `notes_intake`, `manual`,
> and audit-follow-up paths are unaffected. See
> [pm-convoy-mandate.md](pm-convoy-mandate.md) and the enforcement at
> [src/lib/db/pm-proposals.ts](../../src/lib/db/pm-proposals.ts)
> (`validateProposedChanges`, mandate block near the top).

| kind | line | mutable target | revert support |
|---|---|---|---|
| `shift_initiative_target` | [:93-99](../src/lib/db/pm-proposals.ts) | `initiatives.target_*` | full |
| `add_availability` | [:100-106](../src/lib/db/pm-proposals.ts) | `owner_availability` (INSERT) | **limited** — no inverter |
| `set_initiative_status` | [:107-115](../src/lib/db/pm-proposals.ts) | `initiatives.status` | full |
| `add_dependency` | [:116-121](../src/lib/db/pm-proposals.ts) | `initiative_dependencies` (INSERT) | full |
| `remove_dependency` | [:122](../src/lib/db/pm-proposals.ts) | `initiative_dependencies` (DELETE) | full |
| `reorder_initiatives` | [:123-127](../src/lib/db/pm-proposals.ts) | `initiatives.sort_order` (bulk) | full |
| `update_status_check` | [:128-132](../src/lib/db/pm-proposals.ts) | `initiatives.status_check_md` | full |
| `create_child_initiative` | [:133-151](../src/lib/db/pm-proposals.ts) | `initiatives` (INSERT) | tombstone (status=cancelled) |
| `create_task_under_initiative` | [:152-164](../src/lib/db/pm-proposals.ts) | `tasks` (INSERT) | tombstone (status=cancelled) |
| `create_convoy_under_initiative` | [:187-204](../src/lib/db/pm-proposals.ts) | `tasks` (parent) + `convoys` + `convoy_subtasks` (INSERT) — decompose-flow only | **limited** (full revert deferred — see [pm-convoy-mandate.md](pm-convoy-mandate.md)) |
| `set_task_status` | [:165-188](../src/lib/db/pm-proposals.ts) | `tasks.status` | full (revert proposals only on the forward path) |
| `confirm_task_done` | [:189-201](../src/lib/db/pm-proposals.ts) | `tasks.status` (via `transitionTaskStatus`) | full |

> Both `set_task_status` and `confirm_task_done` end at `tasks.status`,
> but they are kept as separate kinds because the validation policy is
> different: forward `set_task_status` is restricted to `'cancelled'`
> (the tombstone case) at
> [:498-521](../src/lib/db/pm-proposals.ts), while `confirm_task_done`
> requires evidence and late-stage source status at
> [:522-590](../src/lib/db/pm-proposals.ts).

> **There is no delete kind, by design.** PM cancels via
> `set_initiative_status='cancelled'` or `set_task_status='cancelled'`;
> the operator owns hard delete. See [pm-revertable-proposals.md:14-26](pm-revertable-proposals.md).

### `PmDiffCapture` interface

Every variant inherits the same optional capture bag at
[src/lib/db/pm-proposals.ts:58-90](../src/lib/db/pm-proposals.ts):

```ts
prev_status?:               // set_initiative_status
prev_status_check_md?:      // update_status_check
prev_target_start?:         // shift_initiative_target
prev_target_end?:           // shift_initiative_target
created_dependency_id?:     // add_dependency
removed_dependency_row?:    // remove_dependency (full snapshot row)
prev_child_ids_in_order?:   // reorder_initiatives
created_initiative_id?:     // create_child_initiative
created_task_id?:           // create_task_under_initiative
created_availability_id?:   // add_availability
prev_task_status?:          // set_task_status + confirm_task_done
```

These fields are **absent on draft proposals** and are **populated in
place by the apply path** ([:1182-1353](../src/lib/db/pm-proposals.ts))
before `acceptProposal` writes the augmented JSON back to the row at
[:1130-1135](../src/lib/db/pm-proposals.ts).

---

## 3. Trigger kinds

`pm_proposals.trigger_kind` records what produced the proposal.

**TypeScript union** ([src/lib/db/pm-proposals.ts:38-47](../src/lib/db/pm-proposals.ts)):

```ts
'manual'
'scheduled_drift_scan'
'disruption_event'
'status_check_investigation'
'plan_initiative'
'decompose_initiative'
'decompose_story'    // ⚠️ in DB CHECK but NOT in TS union — see note
'notes_intake'
'revert'
```

> ⚠️ The TS `PmProposalTriggerKind` union at
> [:38-47](../src/lib/db/pm-proposals.ts) lists only the 8 values
> above **minus `decompose_story`**, but migration 063 at
> [src/lib/db/migrations.ts:3657-3720](../src/lib/db/migrations.ts)
> added `'decompose_story'` to the DB CHECK constraint. If you are
> adding another trigger_kind, restore `decompose_story` to the TS
> union in the same PR (this is a known drift, not load-bearing — the
> DB CHECK is the gate that fires at write time).

**DB CHECK constraint** (current, post-migration 063,
[src/lib/db/migrations.ts:3694-3695](../src/lib/db/migrations.ts)):
the same nine values.

**Migration history**:

| Migration | What it added | Line |
|---|---|---|
| initial `pm_proposals` | manual / scheduled_drift_scan / disruption_event / status_check_investigation | [migrations.ts:2458-2470](../src/lib/db/migrations.ts) |
| 047 | `plan_initiative`, `decompose_initiative` | [:2783-2840](../src/lib/db/migrations.ts) |
| 054 | `notes_intake` | [:3309-3378](../src/lib/db/migrations.ts) |
| 055 | `dispatch_state` column (default `agent_complete`) | [:3383-3406](../src/lib/db/migrations.ts) |
| 062 | `reverts_proposal_id` + `revert` trigger_kind | [:3588-3652](../src/lib/db/migrations.ts) |
| 063 | `decompose_story` | [:3657-3720](../src/lib/db/migrations.ts) |

---

## 4. Lifecycle

### `status` column

Four values, enforced by CHECK
([src/lib/db/migrations.ts:3695-3697](../src/lib/db/migrations.ts)) and
mirrored in the TS `PmProposalStatus` type at
[src/lib/db/pm-proposals.ts:36](../src/lib/db/pm-proposals.ts):

- `'draft'` — created by `createProposal` ([:698-746](../src/lib/db/pm-proposals.ts)), pending operator review.
- `'accepted'` — flipped by `acceptProposal` ([:1138-1142](../src/lib/db/pm-proposals.ts)) after the transaction commits.
- `'rejected'` — flipped by `rejectProposal` ([:1408-1419](../src/lib/db/pm-proposals.ts)).
- `'superseded'` — flipped by `refineProposal` ([:1437-1478](../src/lib/db/pm-proposals.ts)) or by `supersedeWithAgentProposal` ([:777-811](../src/lib/db/pm-proposals.ts)) when an async dispatch lands after a synth placeholder was already persisted.

Legal transitions enforced by `acceptProposal` / `rejectProposal`:

```
draft → accepted    (acceptProposal)
draft → rejected    (rejectProposal)
draft → superseded  (refineProposal | supersedeWithAgentProposal)
accepted → (terminal — idempotent_noop on re-accept; reject throws)
rejected → (terminal)
superseded → (terminal)
```

Idempotency: `acceptProposal` on an already-accepted row returns
`idempotent_noop: true` without mutating
([:899-906](../src/lib/db/pm-proposals.ts)). `rejectProposal` on an
already-rejected row is a silent no-op ([:1411](../src/lib/db/pm-proposals.ts)).

### `dispatch_state` overlay

Three values
([src/lib/db/pm-proposals.ts:37](../src/lib/db/pm-proposals.ts)):

- `'pending_agent'` — synth placeholder persisted; named-agent dispatch in flight.
- `'agent_complete'` — agent returned and its `propose_changes` landed. Default for pre-migration / non-dispatched rows ([:627](../src/lib/db/pm-proposals.ts)).
- `'synth_only'` — agent timed out / disconnected; the synth placeholder is the durable record. Set by `setDispatchState` ([:753-755](../src/lib/db/pm-proposals.ts)) from `pm-dispatch.ts:589` / `:1067`.

This overlay is orthogonal to `status` — a placeholder row with
`status='draft'` may have any of the three dispatch states. See
[docs/archive/pm-dispatch-async.md](../docs/archive/pm-dispatch-async.md)
for the full state machine.

---

## 5. The `PmDiffCapture` pattern

> **Key invariant**: every forward `applyDiff` case writes enough
> pre-state onto the diff JSON that the inverse is a **pure function of
> the diff row alone**, with no re-read of (possibly drifted) DB state
> at revert time.

The capture is recorded **before** the mutation in the same
transaction. Examples:

- `set_initiative_status` reads `initiatives.status` then writes
  `prev_status` ([src/lib/db/pm-proposals.ts:1221-1234](../src/lib/db/pm-proposals.ts)).
- `remove_dependency` snapshots the full row before DELETE
  ([:1263-1283](../src/lib/db/pm-proposals.ts)).
- `confirm_task_done` records `prev_task_status` before
  `transitionTaskStatus` ([:1076-1119](../src/lib/db/pm-proposals.ts)).
- `create_child_initiative` returns the new id from
  `applyCreateChildInitiative` and writes it onto the diff at
  [:1010](../src/lib/db/pm-proposals.ts).

After all diffs apply, `acceptProposal` writes the mutated
`proposed_changes` JSON back to the row at
[src/lib/db/pm-proposals.ts:1130-1135](../src/lib/db/pm-proposals.ts):

```ts
run(
  `UPDATE pm_proposals SET proposed_changes = ? WHERE id = ?`,
  [JSON.stringify(existing.proposed_changes), id],
);
```

Without that write-back the capture state would only live in memory
and the revert path could not compute the inverse.

---

## 6. The `invertDiff` contract

`invertProposalDiffs(forward)` ([src/lib/pm/invertDiff.ts:53-69](../src/lib/pm/invertDiff.ts))
takes a post-apply `proposed_changes` array and returns:

```ts
{
  diffs: PmDiff[];          // ready to seed a new draft proposal
  notes: InvertedDiff[];    // 1:1 with forward array, for UI chips
}
```

Two invariants:

1. **Reverse order** ([:60-67](../src/lib/pm/invertDiff.ts)) — later diffs may
   depend on rows created by earlier diffs (a
   `create_task_under_initiative` referencing a
   `create_child_initiative` via `$N`). Reverting in reverse lets the
   task be tombstoned before the initiative it lives under.
2. **Limited fallback** ([:19-25](../src/lib/pm/invertDiff.ts)) — when capture
   is missing (pre-Slice-1 rows, or a kind without capture support),
   `invertOne` returns `{ inverse: null, status: 'limited', reason }`.
   The UI renders a "Revert (limited)" chip per affected diff. Do
   **not** throw — partial reverts are a real product affordance.

**Per-kind inversion** at [src/lib/pm/invertDiff.ts:71-260](../src/lib/pm/invertDiff.ts):

| Forward kind | Inverse kind | Source line |
|---|---|---|
| `shift_initiative_target` | `shift_initiative_target` with prev targets | [:73-91](../src/lib/pm/invertDiff.ts) |
| `set_initiative_status` | `set_initiative_status` with `prev_status` | [:93-106](../src/lib/pm/invertDiff.ts) |
| `update_status_check` | `update_status_check` with prev markdown | [:108-124](../src/lib/pm/invertDiff.ts) |
| `add_dependency` | `remove_dependency` by `created_dependency_id` | [:126-138](../src/lib/pm/invertDiff.ts) |
| `remove_dependency` | `add_dependency` from `removed_dependency_row` | [:140-155](../src/lib/pm/invertDiff.ts) |
| `reorder_initiatives` | `reorder_initiatives` with `prev_child_ids_in_order` | [:157-170](../src/lib/pm/invertDiff.ts) |
| `create_child_initiative` | `set_initiative_status: 'cancelled'` (tombstone) | [:172-188](../src/lib/pm/invertDiff.ts) |
| `create_task_under_initiative` | `set_task_status: 'cancelled'` (tombstone) | [:190-203](../src/lib/pm/invertDiff.ts) |
| `add_availability` | **always `limited`** — no inverse modeled | [:205-215](../src/lib/pm/invertDiff.ts) |
| `set_task_status` | `set_task_status` with `prev_task_status` | [:217-234](../src/lib/pm/invertDiff.ts) |
| `confirm_task_done` | `set_task_status` with `prev_task_status` | [:236-249](../src/lib/pm/invertDiff.ts) |

The `set_task_status` validator at
[src/lib/db/pm-proposals.ts:498-521](../src/lib/db/pm-proposals.ts)
permits arbitrary status only when
`options.trigger_kind === 'revert'`; on forward proposals it locks to
`'cancelled'`. The revert pipeline threads `trigger_kind: 'revert'`
through `createProposal` so the inverse passes validation.

Round-trip tests live at
[src/lib/pm/invertDiff.test.ts](../src/lib/pm/invertDiff.test.ts) —
every kind that supports inversion has a `round-trip:` test (see
inventory at the end of this file).

---

## 7. Adding a new diff kind — the 7-step contract

The load-bearing checklist. Skipping a step produces silent drift:
typically a kind that validates and applies but doesn't revert, or
that survives validation but throws in `applyDiff`'s exhaustive
`default`.

### Step 1 — Add the variant to the `PmDiff` union

[src/lib/db/pm-proposals.ts:92-201](../src/lib/db/pm-proposals.ts).
Intersect with `PmDiffCapture` so capture fields are typable, even if
this kind doesn't need them yet:

```ts
| ({
    kind: 'your_new_kind';
    // …shape…
  } & PmDiffCapture)
```

### Step 2 — Add new capture fields to `PmDiffCapture`

[src/lib/db/pm-proposals.ts:58-90](../src/lib/db/pm-proposals.ts).
Every new `prev_*` / `created_*` field goes here as `optional`. Add a
JSDoc comment naming which kind populates it.

### Step 3 — Add validator case

[src/lib/db/pm-proposals.ts:288-598](../src/lib/db/pm-proposals.ts).
Push error strings into the `errors` array; never throw. Read
`options.trigger_kind` if your kind has a forward-vs-revert policy
difference (model after `set_task_status` at
[:498-521](../src/lib/db/pm-proposals.ts)).

### Step 4 — Add applier case

For simple in-place mutations, add to the `applyDiff` switch at
[src/lib/db/pm-proposals.ts:1182-1353](../src/lib/db/pm-proposals.ts).
For mutations that need cross-diff state (placeholder resolution,
workflow gating, or out-of-order capture), add a case inside the
`acceptProposal` second pass at
[:1021-1122](../src/lib/db/pm-proposals.ts) and throw from `applyDiff`
to mark it as out-of-band (model after `confirm_task_done` at
[:1342-1347](../src/lib/db/pm-proposals.ts)).

### Step 5 — Capture pre-state for revert

In the apply path **before** the mutation, write to the diff in place:

```ts
const prev = queryOne<{…}>(`SELECT … FROM … WHERE id = ?`, [diff.id]);
if (prev) diff.prev_whatever = prev.whatever;
run(`UPDATE … SET … WHERE id = ?`, […]);
```

The JSON write-back at
[src/lib/db/pm-proposals.ts:1130-1135](../src/lib/db/pm-proposals.ts)
persists this automatically.

### Step 6 — Add inverter case

[src/lib/pm/invertDiff.ts:71-260](../src/lib/pm/invertDiff.ts). If
capture is missing return `limited(index, '…reason…')`. If your kind
is a pure annotation with no DB mutation, return `limited` with a
clear reason (model after `add_availability` at
[:205-215](../src/lib/pm/invertDiff.ts)). The exhaustive `never`
branch at [:251-259](../src/lib/pm/invertDiff.ts) ensures TS rejects a
PR that skips this step.

### Step 7 — Tests, prompt, trigger_kind (if applicable)

- Capture + apply test in
  [src/lib/db/pm-proposals.test.ts](../src/lib/db/pm-proposals.test.ts).
- Round-trip test in
  [src/lib/pm/invertDiff.test.ts](../src/lib/pm/invertDiff.test.ts)
  (see existing tests at
  [:60-277](../src/lib/pm/invertDiff.test.ts) for the shape).
- If the PM agent emits this kind, document it in the **Diff kinds**
  section of [src/lib/agents/pm-soul.md:95-108](../src/lib/agents/pm-soul.md).
- If it's only emitted from a new trigger context, extend
  `PmProposalTriggerKind` at
  [src/lib/db/pm-proposals.ts:38-47](../src/lib/db/pm-proposals.ts)
  **and** the DB CHECK via a new migration (model after migration 063
  at [src/lib/db/migrations.ts:3657-3720](../src/lib/db/migrations.ts)).
  Per [CLAUDE.md](../CLAUDE.md) migrations are append-only — never
  edit a shipped migration's `up()`.
- If MCP-facing, mirror the diff shape in `DiffSchema`
  (`src/lib/mcp/shared.ts`).

---

## 8. Worked example: `confirm_task_done`

Shipped in #325. Files touched:

1. **Union variant** —
   [src/lib/db/pm-proposals.ts:189-201](../src/lib/db/pm-proposals.ts):

   ```ts
   | ({
       kind: 'confirm_task_done';
       task_id: string;
       evidence_md: string;
       audit_proposal_id?: string;
       commit_sha?: string;
       pr_url?: string;
     } & PmDiffCapture)
   ```

2. **Capture field** — reused existing `prev_task_status?: string` on
   `PmDiffCapture` at
   [src/lib/db/pm-proposals.ts:86-89](../src/lib/db/pm-proposals.ts).

3. **Validator** —
   [src/lib/db/pm-proposals.ts:522-590](../src/lib/db/pm-proposals.ts):
   late-stage source status, `evidence_md.length >= 20`, at least one
   structured pointer, audit-proposal must be `accepted` and in same
   workspace, commit_sha matches `/^[0-9a-f]{7,40}$/i`, pr_url parses.

4. **Applier (out-of-band)** —
   [src/lib/db/pm-proposals.ts:1076-1119](../src/lib/db/pm-proposals.ts).
   Captures `prev_task_status`, calls `transitionTaskStatus` so
   workflow gates still run, emits a `task_status_attested_done`
   event. `applyDiff` itself throws at
   [:1342-1347](../src/lib/db/pm-proposals.ts) — the kind is
   pass-2-only.

5. **Inverter** —
   [src/lib/pm/invertDiff.ts:236-249](../src/lib/pm/invertDiff.ts):
   returns a `set_task_status` diff with `status = diff.prev_task_status`.
   This forced loosening of the `set_task_status` forward validator to
   permit arbitrary status when `trigger_kind === 'revert'`
   ([src/lib/db/pm-proposals.ts:498-521](../src/lib/db/pm-proposals.ts))
   — a generic side-effect of adding any "non-cancelled" task status
   inversion.

6. **Tests** —
   [src/lib/db/pm-proposals.test.ts:881-1110](../src/lib/db/pm-proposals.test.ts):
   rejects on early-stage status, missing pointer, short evidence,
   draft audit reference. Happy path applies and emits attestation
   event. Revert restores `prev_status`. Forward `set_task_status`
   still rejects status != cancelled.

7. **Prompt** —
   [src/lib/agents/pm-soul.md:108](../src/lib/agents/pm-soul.md): one
   bullet in the diff catalog with the evidence + late-stage
   requirements spelled out.

No new trigger_kind was needed — `confirm_task_done` is invoked from
the same `notes_intake` / `disruption_event` paths the PM already uses.

---

## 9. Revert proposals

### The `reverts_proposal_id` column

Added by migration 062 at
[src/lib/db/migrations.ts:3588-3652](../src/lib/db/migrations.ts).
Nullable FK back to `pm_proposals(id)` with `ON DELETE SET NULL`, plus
a partial index `idx_pm_proposals_reverts` on the non-null subset.

Mapped on the TS row at
[src/lib/db/pm-proposals.ts:222-225](../src/lib/db/pm-proposals.ts) and
threaded through `createProposal` via the
`reverts_proposal_id` option at
[:648-651](../src/lib/db/pm-proposals.ts).

### The `revert` trigger_kind

Added by migration 062 to the DB CHECK
([:3631](../src/lib/db/migrations.ts)) and present in the TS union
([src/lib/db/pm-proposals.ts:47](../src/lib/db/pm-proposals.ts)). A
revert proposal goes through the normal `draft → accepted` review
flow; **no auto-apply**. The user can refine or reject the revert just
like any forward proposal — see
[pm-revertable-proposals.md:63-66](pm-revertable-proposals.md).

### Reverting a revert

There is no special-casing. The original revert is itself accepted →
its diffs ran → its capture state was written. A revert-of-a-revert
runs `invertProposalDiffs` against that captured state and produces a
new draft. Tested at
[src/lib/pm/invertDiff.test.ts:319-378](../src/lib/pm/invertDiff.test.ts)
(`'round-trip-of-revert: …'`).

### Drift handling

If state the original diff touched has been further modified since,
the inverse still applies — but the operator may see unexpected
restoration. Per
[pm-revertable-proposals.md:66](pm-revertable-proposals.md), the UI
surfaces a per-diff warning chip; this doc layer does not gate the
revert.

---

## 10. Async dispatch overlay

### Column

`pm_proposals.dispatch_state TEXT` — added by migration 055 at
[src/lib/db/migrations.ts:3383-3406](../src/lib/db/migrations.ts) with
default `'agent_complete'` so pre-migration rows do not need backfill.

### TypeScript union

[src/lib/db/pm-proposals.ts:37](../src/lib/db/pm-proposals.ts):

```ts
type PmProposalDispatchState = 'pending_agent' | 'agent_complete' | 'synth_only';
```

### State transitions

- **Created `pending_agent`** when the gateway is up and a named PM
  agent is being dispatched:
  [src/lib/agents/pm-dispatch.ts:243](../src/lib/agents/pm-dispatch.ts)
  (Mode B path) and [:898](../src/lib/agents/pm-dispatch.ts).
- **Promoted to `agent_complete`** when the agent's
  `propose_changes` lands and supersedes the placeholder via
  `supersedeWithAgentProposal`
  ([src/lib/db/pm-proposals.ts:777-811](../src/lib/db/pm-proposals.ts) — sets `dispatch_state = 'agent_complete'` at [:799](../src/lib/db/pm-proposals.ts)).
- **Promoted to `synth_only`** when the reconciler times out
  ([src/lib/agents/pm-dispatch.ts:589](../src/lib/agents/pm-dispatch.ts)
  and [:1064-1068](../src/lib/agents/pm-dispatch.ts)).

### SSE events

Two event types, defined in the SSE union at
[src/lib/types.ts:1032-1034](../src/lib/types.ts):

- **`pm_proposal_replaced`** — emitted by
  [src/lib/agents/pm-dispatch.ts:531-540](../src/lib/agents/pm-dispatch.ts)
  and [:1040](../src/lib/agents/pm-dispatch.ts) when the agent row
  supersedes the synth placeholder. Payload: `{ workspace_id, old_id,
  new_id, target_initiative_id, trigger_kind }`. Subscribers:
  `src/app/(app)/pm/page.tsx:397`,
  `src/components/DecomposeWithPmModal.tsx:171`,
  `src/components/PlanWithPmPanel.tsx:229`,
  `src/components/DecomposeStoryToTasksModal.tsx:153`.
- **`pm_proposal_dispatch_state_changed`** — emitted by
  [src/lib/agents/pm-dispatch.ts:630-637](../src/lib/agents/pm-dispatch.ts)
  and [:1064-1068](../src/lib/agents/pm-dispatch.ts) when the
  placeholder flips to `synth_only`. Payload:
  `{ workspace_id, proposal_id, dispatch_state }`.

### When this matters for diff authors

If your new kind is dispatched through the async path (i.e. the PM
agent emits it via `propose_changes`), it inherits the synth /
supersede / SSE flow for free — there is no per-kind wiring. If you
emit it directly from a synth path (like the take_note auto-spawn in
[audit-action-recommended.md](audit-action-recommended.md)), the
proposal row may be created with `dispatch_state: 'synth_only'` or
`'pending_agent'` per the caller's choice
([src/lib/db/pm-proposals.ts:646-648](../src/lib/db/pm-proposals.ts)).

---

## Appendix A: current diff-kind inventory

| kind | trigger contexts | mutates DB | has capture? | has inverter? | introduced in |
|---|---|---|---|---|---|
| `shift_initiative_target` | disruption_event, manual, scheduled_drift_scan | UPDATE initiatives | yes (`prev_target_start/end`) | yes | original Phase 5 |
| `add_availability` | manual, disruption_event | INSERT owner_availability | id capture only (`created_availability_id`) | **no — always `limited`** ([invertDiff.ts:205-215](../src/lib/pm/invertDiff.ts)) | original Phase 5 |
| `set_initiative_status` | disruption_event, status_check_investigation, notes_intake, manual | UPDATE initiatives.status | yes (`prev_status`) | yes | original Phase 5 |
| `add_dependency` | manual, disruption_event | INSERT initiative_dependencies | yes (`created_dependency_id`) | yes (→ remove_dependency) | original Phase 5 |
| `remove_dependency` | manual, disruption_event | DELETE initiative_dependencies | yes (`removed_dependency_row` snapshot) | yes (→ add_dependency) | original Phase 5 |
| `reorder_initiatives` | manual, decompose_initiative | UPDATE initiatives.sort_order | yes (`prev_child_ids_in_order`) | yes | original Phase 5 |
| `update_status_check` | status_check_investigation, notes_intake | UPDATE initiatives.status_check_md | yes (`prev_status_check_md`) | yes | original Phase 5 |
| `create_child_initiative` | decompose_initiative | INSERT initiatives | yes (`created_initiative_id`) | tombstone via set_initiative_status='cancelled' | Polish B (migration 047) |
| `create_task_under_initiative` | notes_intake, manual, audit follow-ups, child-initiative stubs (NOT decompose flows when MC_PM_CONVOY_MANDATE=1) | INSERT tasks | yes (`created_task_id`) | tombstone via set_task_status='cancelled' | migration 054 / 063 |
| `create_convoy_under_initiative` | decompose_story, decompose_initiative, plan_initiative | INSERT tasks (parent) + convoys + convoy_subtasks | yes (`convoy_id`, `parent_task_id`, `subtask_id_map`) | **limited** — full revert deferred (slice 7) | migration 095 / pm-convoy-mandate.md |
| `set_task_status` | revert only on forward path (`'cancelled'` allowed on forward; arbitrary on revert) | UPDATE tasks.status | yes (`prev_task_status`) | yes | revert pipeline (migration 062) |
| `confirm_task_done` | notes_intake, disruption_event | UPDATE tasks.status via `transitionTaskStatus` + emit event | yes (`prev_task_status`) | yes (→ set_task_status with prev) | PR #325 |

### Kinds without a real inverter, and why

- **`add_availability`** ([invertDiff.ts:205-215](../src/lib/pm/invertDiff.ts))
  — there is no `remove_availability` forward kind. `owner_availability`
  is a pure annotation row with no downstream references. A future
  inverter would require either adding `remove_availability` as a new
  diff kind or wiring `created_availability_id` into a DELETE-by-id
  inverter. Either is fine, but neither is shipped. Status:
  intentional gap, surfaced as `limited` per-diff in the revert UI.

### `audit_verdict` is not a diff kind

The [audit-action-recommended.md](audit-action-recommended.md) spec
introduces an `audit_verdict` **note kind**
([src/lib/db/agent-notes.ts](../src/lib/db/agent-notes.ts)), not a
PmDiff. The audit-verdict path auto-spawns a `notes_intake` PM
dispatch which produces ordinary forward diffs (e.g.
`set_initiative_status: 'cancelled'`, `confirm_task_done`, etc.). The
verdict note carries audit context; the resulting proposal carries
the diffs.

---

## Appendix B: file map at a glance

| Role | File | Anchor |
|---|---|---|
| `PmDiff` union, validator, applier, capture | `src/lib/db/pm-proposals.ts` | `:38-1353` |
| `invertDiff` | `src/lib/pm/invertDiff.ts` | full file |
| Round-trip tests | `src/lib/pm/invertDiff.test.ts` | full file |
| Validator + apply tests | `src/lib/db/pm-proposals.test.ts` | `:881-1110` for confirm_task_done |
| Async dispatch overlay | `src/lib/agents/pm-dispatch.ts` | `:243, :531-540, :630-637, :898, :1040, :1064-1068` |
| SSE event types | `src/lib/types.ts` | `:1032-1034` |
| PM agent prompt (operator-facing diff catalog) | `src/lib/agents/pm-soul.md` | `:95-108` |
| Migrations adding columns / trigger_kinds | `src/lib/db/migrations.ts` | `:2458, :2783, :3309, :3383, :3588, :3657` |
