# Subtree Audit — Structured Proposals

**Version:** 0.1 (draft)
**Date:** 2026-05-08
**Status:** Proposed
**Builds on:** [`docs/archive/initiative-investigate.md`](./initiative-investigate.md) (subtree-audit orchestration, already shipped as PR 4)
**Related (do not conflate):** [`specs/convoy-mode-spec.md`](./convoy-mode-spec.md), [`specs/coordinator-delegation-via-convoy-spec.md`](./coordinator-delegation-via-convoy-spec.md) — *agent-initiated* fan-out via the convoy/`spawn_subtask` substrate. This spec uses the *MC-orchestrated* `agent_runs` substrate at [`src/lib/agents/subtree-audit.ts`](../src/lib/agents/subtree-audit.ts) and does **not** create `tasks` rows.

---

## 1. Problem

The subtree audit at `runSubtreeAudit` ([`src/lib/agents/subtree-audit.ts:247`](../src/lib/agents/subtree-audit.ts)) already does layered, MC-orchestrated, bottom-up fan-out across an initiative subtree. Per-node researchers emit a single free-form `kind: 'observation'` PM-importance-2 note, and the root researcher synthesizes child findings into a parent note.

The output shape doesn't match what the operator actually needs. Three concrete failure modes:

1. **Free-form prose, not actionable.** A canonical leaf-audit note from 2026-05-08 (mc-runner on initiative `0c9419ff-d511-4511-86c6-57a6387e19f7`, "Refactor native alert() calls to a custom modal") closed with: "*Verdict: Stale (rescope) — Suggest the PM reconcile Mission Control status with repo reality…*". An operator can't act on that without rereading the body and deriving per-story decisions by hand.

2. **3000-char `take_note.body` cap forces the report into one note or none.** Same run hit the cap (~6000-char audit body), got rejected by `take_note`, then was cancelled mid-recovery. Cap is correct; the report shape is wrong.

3. **No structural reframing.** The current root researcher synthesizes child findings into prose. It can't propose "merge stories 2 and 3," "this epic needs a NEW Story 5," or "modify epic dates." Those proposals require a typed schema, not a paragraph.

Operator goal: an audit produces a queue of typed proposals — one per node, plus an epic-level set — that map directly to `update_task_status`, `update_initiative`, and `create_story` mutations behind a review surface. Today's audit produces narrative; we want structured output.

---

## 2. Decision

**Extend `runSubtreeAudit` with three changes**, layered on the existing leaf-first orchestration:

1. **Add an L1 *surveyor* phase** that runs *before* the leaf layer and emits an `audit_manifest` note on the root. The manifest narrows the per-node fan-out: each enumerated descendant gets a hypothesis (`likely-done | likely-drifted | likely-cancelled | no-evidence | needs-deep-dive`) and a scoped investigation prompt. Nodes flagged `likely-done` or `no-evidence` with high confidence may be skipped (cheap "keep" proposals emitted by the orchestrator without dispatching an auditor).

2. **Replace the per-node free-form report with a typed `audit_proposal` note schema.** Each leaf-layer auditor emits exactly one proposal note per node, with `proposed_action`, `current_mc_status`, `repo_evidence` (file:line refs, git SHAs, PR links), `rationale`, and `confidence`. Body stays well under the 3000-char cap by construction (§4.5). Audit artifacts live entirely in `agent_notes` — no file deliverables, no untracked artifacts that pollute future audits.

3. **Promote the root layer to an explicit *synthesizer* (L3) stage** that emits `audit_synthesis` on the root, including: (a) cross-cutting proposals individual leaves couldn't see — `merge_stories`, `split_story`, `new_story`, `modify_epic_scope`, `modify_epic_dates` — and (b) a one-line completion sentinel (`Audit complete: N nodes — Xd / Yc / Zk / …`) suitable for surfacing in the operator's audit feed.

The downstream proposal queue UI (L4) is **captured in §8** for visibility — it is the consumer of the proposal notes — but it is not part of the orchestration milestone.

### 2.1 Why not the convoy substrate?

The 2026-04-22 [`coordinator-delegation-via-convoy-spec.md`](./coordinator-delegation-via-convoy-spec.md) made convoys + `spawn_subtask` the substrate for *agent-initiated* fan-out, with real child `tasks` rows. The audit case is different on three axes:

- **MC-orchestrated, not agent-orchestrated.** The L1 surveyor doesn't decide who to dispatch — it emits a manifest the orchestrator reads. MC owns the fan-out.
- **Outputs are notes / proposals, not tasks.** An audit produces a review queue, not work items.
- **`runSubtreeAudit` already exists** on the `agent_runs.parent_run_id` substrate with layer barriers, per-node failure isolation, and synthetic-parent rollup. Reusing it is materially smaller than rebuilding on convoy/tasks.

We **do** steal the *Delegation Contract* shape from §3.2 of the coordinator-delegation spec — `slice` / `expected_deliverables` / `acceptance_criteria` — for the L2 briefing format (§5.2), so each auditor knows the proposal note schema is contractual, not prose-with-vibes.

---

## 3. Stages

### 3.1 L1 — Surveyor (one dispatch, root-scoped)

**Role:** `auditor` (new generic role — see §9.1). Same role is used for L2 and L3, parameterized by briefing.
**Scope:** `initiative-${rootId}:audit-survey:${attempt}`.
**Inputs in briefing:**
- Root initiative + immediate descendant tree (titles, descriptions, statuses, recent updated_at).
- Linked PRs / commits in the relevant area (cheap git-log skim, not full grep).
- The most recent `audit_synthesis` note on the same root, if any (for delta runs — see §7).

**Output:** exactly one note,

```
take_note({
  kind: 'audit_manifest',
  audience: 'pm',
  importance: 1,                  // visible to PM, not boosted to PM Chat
  initiative_id: rootId,
  scope_key: 'initiative-${rootId}:audit-survey:${attempt}',
  body: <JSON manifest, see §4.2>
})
```

**Costs:** bounded — surveyor reads but does not deeply grep. Target wall-clock < 60s. The manifest is a *plan*, not the audit itself.

**Behavior on failure:** if the surveyor errors or emits no manifest, the orchestrator falls back to the current behavior — fan out to every non-terminal descendant with no narrowing. This keeps the change non-breaking.

### 3.2 L2 — Per-node auditors (parallel, leaf-first)

Same fan-out shape as today: leaf layer first, then parents, with the existing `boundedAll(tasks, concurrency)` per-layer barrier ([`src/lib/agents/subtree-audit.ts:294-431`](../src/lib/agents/subtree-audit.ts)). Two differences:

1. **The set of dispatched nodes comes from the manifest**, not from `planSubtreeAudit`'s raw enumeration. Manifest-skipped nodes get a synthetic `audit_proposal` note from the orchestrator (`proposed_action: 'keep'`, `confidence: 'inherited-from-manifest'`) so the proposal queue still has full coverage.
2. **Briefing carries the manifest's per-node *contract*** — slice, deliverables (one `audit_proposal` note + optional deliverable file), acceptance criteria — using the schema from §5.2.

**Output per auditor:** exactly one `audit_proposal` note, scoped to that node's `initiative_id`. Body is the JSON schema in §4.3, capped well under 3000 chars by construction.

### 3.3 L3 — Synthesizer (one dispatch, root-scoped)

Replaces today's "root layer is just another per-node audit" pass.

**Inputs in briefing:**
- The L1 manifest (verbatim).
- All L2 `audit_proposal` notes (read via `listNotes({ kinds: ['audit_proposal'], …subtree filter})` — orchestrator passes the bodies in directly to avoid the auditor needing tree-walk tools).
- The root initiative's own state (description, dates, status_check_md).

**Output:** exactly one note,

```
take_note({
  kind: 'audit_synthesis',
  audience: 'pm',
  importance: 2,                  // boosted into PM Chat
  initiative_id: rootId,
  scope_key: 'initiative-${rootId}:audit-synthesis:${attempt}',
  body: <JSON synthesis, see §4.4>
})
```

The synthesis body includes the **completion sentinel** as its first line (e.g., `Audit complete: 7 nodes — 1 done, 2 cancel, 1 keep, 2 modify_scope, 1 new_story; epic dates +14d`) so it's the line the operator sees in any feed/list view that shows the head of the body.

**Power L3 has that L2 doesn't:** propose `new_story` (no node exists yet to be scoped to), `merge_stories`, `split_story`, `modify_epic_scope`, `modify_epic_dates`. L2 is constrained to per-node verdicts on existing nodes.

---

## 4. Note `kind`s and schemas

### 4.1 New `NoteKind` enum values

Extend [`src/lib/db/agent-notes.ts:19-36`](../src/lib/db/agent-notes.ts):

```ts
export type NoteKind =
  | 'discovery'
  | 'blocker'
  | 'uncertainty'
  | 'decision'
  | 'observation'
  | 'question'
  | 'breadcrumb'
  | 'audit_manifest'      // NEW — L1 output
  | 'audit_proposal'      // NEW — L2 output
  | 'audit_synthesis';    // NEW — L3 output
```

Update `NOTE_KINDS` in lock-step. The Zod arg at [`src/lib/mcp/shared.ts:170`](../src/lib/mcp/shared.ts) (`noteKindArg`) is generated from this — single source of truth.

**Read-path filtering.** Cross-audit reads (other initiatives querying notes; the briefing builder; the Notes Rail) must exclude these three new kinds by default to avoid bleed. Do this in the `listNotes` callers, not at the DB layer — the proposal queue UI (§8) needs to read them. Concrete change: the briefing builder's note-pull for `dispatchScope` excludes audit kinds unless the caller is itself an audit stage.

### 4.2 `audit_manifest` body schema (L1)

JSON in the note body. Keep it small — this is a plan, not an analysis.

```jsonc
{
  "version": 1,
  "root_initiative_id": "0c9419ff-…",
  "attempt": 11,
  "previous_synthesis_run_group_id": "…",  // null on first run; set for delta runs (§7)
  "summary": "1-paragraph framing of the epic's intent and current state",
  "nodes": [
    {
      "initiative_id": "6379b104-…",
      "title": "Build AlertDialog component mirroring ConfirmDialog",
      "current_status": "done",
      "hypothesis": "likely-drifted",          // see enum below
      "confidence": "medium",                   // low | medium | high
      "investigation_prompt": "Verify that an AlertDialog component or alert-shim exists somewhere in ui/src or extensions/. Story marked done but no obvious symbol — check whether the work landed under a different name or branch.",
      "scoped_evidence_hints": [
        "git log --oneline -- ui/src/ui/components",
        "rg 'AlertDialog|alert-shim|showAlertDialog' ui/src extensions"
      ],
      "skip": false                             // if true: orchestrator emits synthetic 'keep' proposal, no dispatch
    }
    // … one entry per non-terminal descendant
  ],
  "cross_cutting_questions": [
    "Stories 6379b104 and 9ab40f1f both reference an alert-shim — same file or two?"
  ]
}
```

**`hypothesis` enum:** `likely-done | likely-drifted | likely-cancelled | no-evidence | needs-deep-dive`.

**Skip rule:** orchestrator skips a node iff `skip === true` AND `confidence === 'high'`. Anything else dispatches.

### 4.3 `audit_proposal` body schema (L2 + synthetic skip-keeps)

```jsonc
{
  "version": 1,
  "node_initiative_id": "6379b104-…",
  "current_mc_status": "done",
  "current_mc_target_end": "2026-05-13",
  "proposed_action": "modify_scope",
  // enum: keep | mark_done | cancel | modify_scope | modify_dates
  // (note: new_story / merge_stories / split_story / modify_epic_* are L3-only; see §4.4)
  "proposed_changes": {
    // shape depends on action; see §4.3.1 below
  },
  "repo_evidence": [
    { "kind": "file", "ref": "ui/src/ui/components/modal-dialog.ts:100" },
    { "kind": "git", "ref": "0cc50ce" },
    { "kind": "pr",  "ref": "https://github.com/smb209/mission-control/pull/123" },
    { "kind": "note", "ref": "<note_id>" }
  ],
  "rationale": "1-paragraph narrative — why this action, what changes since the last audit if any.",
  "confidence": "medium",                      // low | medium | high
  "would_confirm_by": "Reading ui/src/ui/components/alert-dialog.ts if it exists.",  // required when confidence < high
  "continuation_note_id": null                  // populated only when overflow is required (§4.5)
}
```

#### 4.3.1 `proposed_changes` shape per action

```jsonc
"keep":          {}
"mark_done":     { "note": "string — what evidence supports completion" }
"cancel":        { "reason": "string" }
"modify_scope":  { "title"?: "string", "description"?: "string" }
"modify_dates":  { "target_start"?: "YYYY-MM-DD", "target_end"?: "YYYY-MM-DD" }
```

### 4.4 `audit_synthesis` body schema (L3)

```jsonc
{
  "version": 1,
  "root_initiative_id": "0c9419ff-…",
  "attempt": 11,
  "completion_sentinel": "Audit complete: 7 nodes — 1 done, 2 cancel, 1 keep, 2 modify_scope, 1 new_story; epic dates +14d",
  "epic_proposals": [
    {
      "proposed_action": "modify_epic_dates",
      "proposed_changes": { "target_end": "2026-05-27" },
      "rationale": "string",
      "confidence": "medium"
    },
    {
      "proposed_action": "modify_epic_scope",
      "proposed_changes": { "description": "…revised body…" },
      "rationale": "string",
      "confidence": "high"
    }
  ],
  "cross_node_proposals": [
    {
      "proposed_action": "merge_stories",
      "subject_initiative_ids": ["6379b104-…", "9ab40f1f-…"],
      "rationale": "Both reference the same alert-shim; closer reading shows one PR closes both.",
      "confidence": "medium"
    },
    {
      "proposed_action": "new_story",
      "proposed_new_node": {
        "kind": "story",
        "title": "Audit + remove dead alert hook in extensions/browser",
        "description": "string",
        "estimated_effort_hours": 2
      },
      "rationale": "Found in repo grep but absent from epic.",
      "confidence": "medium"
    }
  ]
}
```

**Note:** the synthesis intentionally does *not* duplicate the per-node verdicts — the proposal queue UI (§8) computes the per-node summary by querying `audit_proposal` notes scoped to descendants of the root. This keeps the synthesis body small and avoids two sources of truth for the same data.
```

### 4.5 Body size and overflow

All three schemas fit in the 3000-char `take_note.body` cap by construction:
- `audit_manifest`: ~150 chars per node × ≤15 nodes + summary ≈ 2.3KB worst case for normal epics.
- `audit_proposal`: enum + ≤4 evidence refs (≈80 chars each) + 1-paragraph rationale ≈ 1–1.5KB.
- `audit_synthesis`: sentinel + ≤5 epic proposals + ≤5 cross-node proposals ≈ 2–2.5KB. Per-node verdicts are *not* duplicated here (§4.4) — that's what keeps it small.

**No file deliverables.** `task_deliverables` is task-scoped (FK to `tasks`, [`src/lib/db/schema.ts:295`](../src/lib/db/schema.ts)) and file-path-backed — wrong shape on both axes for our case (no initiative-scoped analog; we don't want orphan files polluting future audits). All audit artifacts live as agent_notes rows.

**Overflow handling (rare path):** if an auditor's body would exceed 2900 chars (the orchestrator's pre-cap budget), it splits into a *continuation chain*:

1. The primary note holds the structural payload (action, evidence refs, schema-required fields) and a truncated rationale ending in `… (continued in note <id>)`.
2. A continuation note with `kind: 'audit_proposal'` (or whichever original kind), `body: { continuation_of: '<primary_note_id>', body: '<rest>' }`, scoped to the same `initiative_id`.
3. The primary note's `continuation_note_id` field points at the continuation row.

This is a fallback. The L2/L3 briefings instruct auditors to **tighten the rationale first** — overflow is a smell, not a feature. Continuation should be exceptional (large evidence dumps, multi-paragraph cross-cutting reasoning).

The orchestrator validates body ≤ 2900 chars on `take_note`; auditors handle the rejection by tightening or, as a last resort, splitting. Validation lives in the MCP handler so feedback is immediate (§5.2).

The proposal queue UI (§8) follows continuation pointers transparently when rendering. Continuation notes are stored as agent_notes rows like everything else — same scope_key, same cancel-cascade, same query surface — so they don't fall on the floor or accumulate untracked.

---

## 5. Orchestration changes to `runSubtreeAudit`

### 5.1 New stages around the existing layer loop

Today (`src/lib/agents/subtree-audit.ts:247-460`):

```
plan → synthetic root agent_run → for each layer (leaf → root): boundedAll(dispatch, concurrency)
```

Proposed:

```
plan
  ↓
synthetic root agent_run
  ↓
[L1] surveyor dispatch → read manifest from agent_notes
  ↓                                       (fallback: derive a synthetic full-fanout manifest)
filter / annotate plan from manifest
  ↓
for each LEAF + INTERMEDIATE layer:
   boundedAll(L2 dispatch | synthetic-keep emit, concurrency)
  ↓
[L3] synthesizer dispatch → emits audit_synthesis on root
  ↓
markRunRollup on synthetic parent
```

`planSubtreeAudit` keeps its current shape; the new manifest filter is applied as a *post-step* on the planned layers. No change to `enumerateLayersBottomUp`.

### 5.2 L2 briefing — Delegation-Contract-style

`buildAuditPrompt` ([`src/lib/agents/audit-prompt.ts`](../src/lib/agents/audit-prompt.ts)) gains a `mode: 'subtree-proposal'` branch (alongside today's `mode: 'subtree'`). It produces a briefing that includes a contract block, modeled on `spawn_subtask`'s schema (§3.2 of `coordinator-delegation-via-convoy-spec.md`):

```
## Contract
- Slice: {manifest.investigation_prompt}
- Expected deliverables: 1 take_note(kind='audit_proposal', initiative_id='${node.id}'), body matches schema in §4.3
- Acceptance criteria:
  * Body parses as the audit_proposal v1 schema
  * `repo_evidence` has ≥1 entry of kind ∈ {file, git, pr, note}
  * If `confidence` is low, `would_confirm_by` is non-empty
- Expected duration: ≤ 5 minutes
- Hypothesis from manifest: {manifest.hypothesis} (confidence: {manifest.confidence})
```

The MCP `take_note` handler validates the body shape when `kind ∈ {audit_manifest, audit_proposal, audit_synthesis}`. Validation failure returns a structured error the auditor can recover from (same retry pattern auditors already handle for the 3000-char cap).

### 5.3 Cancellation cascade

Already works — `cancelAgentRun(parentRunId)` cascades to children via `agent_runs.parent_run_id`. The L1 / L2 / L3 dispatches all set `parent_run_id: parentRunId`. Operator cancel of the root run tears down all in-flight stages without further code.

### 5.4 Cooldown reframe

The existing concurrent-dispatch refusal at [`src/app/api/initiatives/[id]/investigate`](../src/app/api/initiatives/[id]/investigate) is `initiative_id`-scoped and looks for `kind = 'initiative_audit'` rows in non-terminal states. Two interactions to verify in implementation:

- **Synthetic root vs L3 dispatch overlap.** Synthetic root has `kind='initiative_audit'`, `initiative_id=rootId`. The L3 dispatch is also on the rootId. Today (`mode: 'subtree'` root layer) this works because the synthetic root is created first and the layer dispatches use it as `parent_run_id`; the refusal scanner needs to either filter by `source_kind = 'fanout'` parents or by terminal status of the synthetic row. **Action:** confirm in PR by reading the existing `findInFlightAudits` query and adding a regression test.

- **Manifest-driven fan-out children.** Already independent — each child dispatch is scoped to its own `initiative_id`. No new collision risk introduced.

### 5.5 Per-node failure handling

Unchanged from today (placeholder finding, run continues). Extended:

- **L1 failure:** orchestrator logs, falls back to no-narrowing manifest, proceeds. The synthetic manifest has all nodes with `hypothesis: 'needs-deep-dive'`, `skip: false`.
- **L2 invalid proposal body:** auditor gets a structured retry (validation error returned from the `take_note` MCP handler). After N=2 retries, orchestrator emits a synthetic `audit_proposal` with `proposed_action: 'keep'`, `confidence: 'low'`, `rationale: '(audit failed: invalid proposal body after retries)'`.
- **L2 oversize body:** same retry pattern — auditor gets a "body exceeds 2900 chars; tighten rationale or use continuation" error and re-emits. Continuation chain (§4.5) is the fallback after the second tighten attempt.
- **L3 failure:** synthesis note absent. Operator still has the L2 per-node proposal queue; UI shows "synthesis missing — re-run synth only" affordance. The synthetic parent's rollup (`markRunRollup`) reflects the failure.

---

## 6. API surface

### 6.1 New: re-run synthesis only

```
POST /api/initiatives/{id}/investigate/resynthesize
```

Reuses the most recent `audit_manifest` + the most recent `audit_proposal` notes per node and dispatches only L3. Cheap; useful when L3 fails or the operator wants to re-roll the cross-cutting reasoning without re-grepping the repo.

### 6.2 Existing endpoint behavior

`POST /api/initiatives/{id}/investigate` keeps working. The `mode: 'subtree'` value is replaced by `mode: 'subtree-proposal'` in a hard cutover (§6.3) — no dual-mode coexistence.

### 6.3 Hard cutover (no dual modes)

This is dev-only deployment with no production traffic to preserve. `mode: 'subtree'` is **removed** in the same PR that ships Phase 4 (L3 synthesizer). Rationale:

- Dual-mode adds an axis of test surface (two output shapes per audit).
- The capability `subtree` provides — multi-node audit across a subtree — is preserved by `subtree-proposal`. Output shape changes; coverage doesn't.
- A single-node audit is `mode: 'narrow'` already and is unaffected. Operator wanting "just this story, not its children" runs narrow mode at that node.

`mode: 'narrow'` stays as-is in v1 of this spec. Whether to extend the proposal schema to narrow-mode outputs is §9.7.

---

## 7. Idempotency / delta runs

L1 reads the most recent `audit_synthesis` note on the same root via `listNotes({ initiative_id: rootId, kinds: ['audit_synthesis'], limit: 1, order: 'desc' })`. If present, the surveyor briefing includes:

```
## Prior audit
Last synthesis ran {prior.created_at}. Sentinel: "{prior.completion_sentinel}".

Children with new git activity since then: {git log --since=prior.created_at}.
Children with no MC status changes and no git activity: {list}.
```

Surveyor is instructed to emit a *delta* manifest: `skip: true` for nodes with no signal change, `hypothesis: 'needs-deep-dive'` for nodes with new activity. Reduces L2 fan-out cost dramatically on healthy epics audited frequently.

---

## 8. Operator proposal queue (L4) — captured for visibility

This is the consumer of `audit_proposal` and `audit_synthesis` notes. **Not in the orchestration milestone** — included here so the data model in §4 has a known consumer and isn't designed in a vacuum.

Sketch:

- **Surface:** new tab on the initiative detail view ("Audit Proposals"), gated on the presence of any `audit_proposal` or `audit_synthesis` note scoped to the initiative or its descendants.
- **Per-proposal row:** action, target node (link), proposed changes diff, evidence list (rendered as clickable `file:line` / commit / PR links), rationale, confidence badge. Accept / Reject / Edit-then-Accept buttons.
- **Accept handler** routes to the existing mutation surface — `update_initiative` for `mark_done | cancel | modify_scope | modify_dates`, `update_initiative` for `modify_epic_*`, `create_initiative` for `new_story`. All accepts are recorded as `kind: 'decision'` notes on the affected node, citing the originating `audit_proposal.id`.
- **Reject handler** records a `kind: 'decision'` note with `proposed_action: 'reject'` and a one-line reason. Future audit runs read these via §7's delta mechanism so the surveyor can downweight repeat-rejected proposals.
- **Bulk accept** for proposals at `confidence: high` and `proposed_action ∈ {keep, mark_done}` — the cheap, low-risk class.

Out-of-scope for this spec:
- Auto-accept rules / policy.
- Multi-operator approval workflows.
- Proposal expiry / staleness.

---

## 9. Open questions

### 9.1 Resolved during drafting (recorded for the implementation PR)

- **Auditor role.** Use a generic `auditor` role (new), not `researcher`-with-narrower-briefing and not `story_auditor`. The auditor's *disposition* is constant across audit subjects — investigates claims, cites evidence, proposes structured changes, never mutates state. The *contract* (what to investigate, what schema to emit) is supplied per-dispatch via the briefing. This means the same role can be applied to other audit targets in the future (task subtree audits, agent-config audits, knowledge-graph audits) without proliferating roles. SOUL/IDENTITY at `agents/auditor/`.

- **`subtree` mode is removed**, hard cutover with Phase 4 (§6.3). Single-node audits stay on `mode: 'narrow'`.

- **Validation lives in the MCP `take_note` handler.** Per-kind Zod schemas at `src/lib/agents/audit-proposals/schemas.ts`, applied iff `kind ∈ {audit_manifest, audit_proposal, audit_synthesis}`. Researchers get immediate structured feedback and retry within the same dispatch — mirrors today's cancelled-run guard pattern at [`src/lib/mcp/groups/core.ts:417-419`](../src/lib/mcp/groups/core.ts).

- **No file deliverables for audit artifacts.** All output lives in `agent_notes`. Overflow uses continuation notes (§4.5), not `register_deliverable`. `task_deliverables` is task-scoped + path-backed and is the wrong shape twice over.

### 9.2 Open

1. **Max L2 concurrency.** Today's `subtreeConcurrency` cap is the right knob; we don't add a new one. Default stays the same; operators can raise it for big epics.

2. **Delta-run signal threshold.** L1 decides a node is "no signal change" based on what — `initiatives.updated_at` + `git log --since=prior_synthesis.created_at -- <path-glob>`? The spec is silent because the heuristic should be developed empirically against real audit runs. v1 fallback: never skip; surveyor *can* set `skip: true` but the orchestrator dispatches anyway until we have data.

3. **Continuation chain depth.** Should we cap continuation length (e.g., max 2 continuation notes per primary)? Probably yes — beyond that, the proposal is structurally too big and the L3 should re-roll the cross-cutting reasoning instead. Defer until we see real overflow patterns.

4. **Audit fanout vs cooldown semantics on the synthetic root.** Verify in the Phase 1/2 PR whether `findInFlightAudits(rootId)` ([`src/app/api/initiatives/[id]/investigate`](../src/app/api/initiatives/[id]/investigate)) treats the synthetic-root row as in-flight. If it does, the L3 dispatch on that same root will be refused. Likely fix: filter out rows with `source_kind = 'fanout'` from the in-flight scan, or terminate the synthetic root before L3 dispatches. Add a regression test either way (§5.4).

5. **Generalizing to other audit targets.** Once `auditor` is a real role, the same pipeline could audit task subtrees, agent rosters, or workflow templates. Out of scope for this spec — but the design choices above (role-not-tied-to-subject, briefing-carries-contract, schemas-in-notes-not-files) are deliberately compatible.

6. **`audit_synthesis` re-roll without re-running L1/L2.** §6.1 spec'd `POST /resynthesize`. Open: should the operator be able to *edit* the manifest before re-synthesizing (e.g., manually mark a node `skip: true` based on review)? Defer; the API surface for that lives in §8 (proposal queue UI), not orchestration.

7. **Should narrow-mode audits also emit `audit_proposal`?** Today's narrow-mode audit emits a single `kind: 'observation'` note. Consistency argues for narrow → `audit_proposal` too (one-node case of the same shape), but the operator's intent differs ("look at this one thing carefully" vs "scan the subtree"). Decide after Phase 4 ships and we have run experience with both.

---

## 10. Migration / rollout

Phased to keep each PR small and the validation surface clear.

### Phase 1 — Schema + plumbing (no behavior change)

1. Add the three new `NoteKind` values + `NOTE_KINDS` entries.
2. Add per-kind body validators (Zod schemas matching §4.2 / 4.3 / 4.4) under `src/lib/agents/audit-proposals/schemas.ts`.
3. Wire validators into the `take_note` MCP handler — applied iff `kind ∈ {audit_manifest, audit_proposal, audit_synthesis}`. No-op for other kinds.
4. Update the briefing builder's note-pull to exclude the new kinds by default.
5. Tests: round-trip parse, validator rejection, briefing exclusion.

### Phase 2 — L1 surveyor + manifest filter

1. New file `src/lib/agents/audit-survey.ts` — `runSurveyor(rootId, ...)`.
2. New `mode: 'survey'` branch in `buildAuditPrompt`.
3. Add `mode: 'subtree-proposal'` to the investigate API route; in this mode, `runSubtreeAudit` calls the surveyor first and applies the manifest filter to the planned layers.
4. Tests: surveyor success path, surveyor failure → fallback to full fan-out, manifest skip → synthetic keep proposal.

### Phase 3 — L2 proposal contract + schema

1. Extend `buildAuditPrompt` with `mode: 'subtree-proposal'` per-node briefing including the Contract block (§5.2).
2. Update L2 dispatch in `runSubtreeAudit` to use the new mode and validate proposal bodies on return.
3. Tests: schema-conformant proposal accepted, malformed proposal triggers retry, repeated failures emit synthetic keep with low confidence.

### Phase 4 — L3 synthesizer + `subtree` mode removal

1. Replace the root layer's per-node audit with an explicit synthesizer dispatch.
2. Synthesizer briefing reads all L2 proposal note bodies + L1 manifest.
3. Add `POST /api/initiatives/{id}/investigate/resynthesize`.
4. **Remove `mode: 'subtree'`** from the investigate route, the API types, the UI button, and the audit-prompt `mode: 'subtree'` branch. `subtree-proposal` becomes the only subtree audit shape (§6.3).
5. Tests: synthesis emits sentinel + epic + cross-node proposals; resynth path skips L1/L2; old `mode: 'subtree'` requests return a 400 with a clear "removed; use subtree-proposal" error.

### Phase 5 — Delta runs

1. L1 surveyor reads prior `audit_synthesis` and emits delta manifest.
2. Tests: second run on unchanged subtree skips most nodes.

### Phase 6 — Proposal queue UI (§8)

Tracked separately. Not gated on phase 5.

### Per-phase verification

Per CLAUDE.md, each phase runs `yarn test` for the affected slices and a preview-verify pass for the API + UI changes. Phase 4 onward exercises the full pipeline against the dev DB on `:4010`; the alert-dialog epic (`0c9419ff-…`) is the canonical fixture.

---

## 11. Files (expected)

### New
```
agents/auditor/SOUL.md                         — auditor role disposition (generic)
agents/auditor/AGENTS.md                       — auditor operating instructions (generic; contract via briefing)
src/lib/agents/audit-survey.ts                 — L1 surveyor orchestration
src/lib/agents/audit-proposals/schemas.ts      — Zod schemas for §4.2 / 4.3 / 4.4
src/lib/agents/audit-synthesizer.ts            — L3 synthesizer orchestration
src/lib/agents/audit-survey.test.ts
src/lib/agents/audit-synthesizer.test.ts
src/lib/agents/audit-proposals/schemas.test.ts
src/app/api/initiatives/[id]/investigate/resynthesize/route.ts
```

### Modified
```
src/lib/db/agent-notes.ts                      — NoteKind + NOTE_KINDS extended
src/lib/agents/subtree-audit.ts                — L1 hook before layer loop, L3 hook after
src/lib/agents/audit-prompt.ts                 — new modes: 'survey', 'subtree-proposal', 'synthesis'
src/lib/mcp/groups/core.ts                     — take_note kind-specific body validation
src/lib/mcp/shared.ts                          — noteKindArg picks up new kinds automatically
src/app/api/initiatives/[id]/investigate/route.ts — mode: 'subtree-proposal' branch
```

### Out of scope (Phase 6 / separate spec)

```
src/components/AuditProposalsTab.tsx           — operator review surface
src/app/api/initiatives/[id]/proposals/route.ts — accept/reject endpoints
```

---

## Summary

Three additive changes to a working orchestrator, plus the removal of one stale mode:

1. **L1 surveyor** narrows the fan-out via an `audit_manifest` note.
2. **L2 auditors** emit typed `audit_proposal` notes against a Delegation-Contract-style briefing — replacing free-form prose.
3. **L3 synthesizer** emits a single `audit_synthesis` with cross-cutting + epic-level proposals and a one-line completion sentinel.
4. **`mode: 'subtree'` is removed** in the same PR as Phase 4. `subtree-proposal` is the only subtree audit shape; `narrow` is unchanged.

All on the existing `runSubtreeAudit` substrate. No new tables, no convoy entanglement, no file deliverables — every artifact is an `agent_notes` row. Cancellation cascade and per-node failure isolation reused as-is. The 3000-char `take_note` cap stays — schemas fit it by construction; rare overflow uses a continuation-note chain rather than spilling to the filesystem.

A single new generic `auditor` role replaces the per-subject role idea — contract is supplied via briefing, so the same role generalizes to future audit targets without new role definitions.

The proposal queue UI (L4) is captured in §8 as the known consumer of these notes so the schemas have a downstream gravity, but is built separately after the orchestration phases are stable.
