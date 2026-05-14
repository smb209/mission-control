---
status: current
last-verified: 2026-05-14
audience: ai-subagents-primary, operator-secondary
code-anchors:
  - src/lib/agents/audit-prompt.ts
  - src/lib/agents/audit-survey.ts
  - src/lib/agents/audit-synthesizer.ts
  - src/lib/agents/audit-auto-spawn.ts
  - src/lib/agents/audit-proposals/schemas.ts
  - src/lib/agents/subtree-audit.ts
  - src/lib/mcp/groups/core.ts
  - src/lib/db/agent-notes.ts
  - src/lib/db/workspaces.ts
  - src/app/api/initiatives/[id]/investigate/route.ts
  - src/app/api/initiatives/[id]/investigate/resynthesize/route.ts
  - src/app/api/initiatives/[id]/ask-pm-from-notes/route.ts
  - src/app/api/agent-notes/[id]/route.ts
  - src/app/api/agent-notes/[id]/archive/route.ts
  - src/app/api/agent-notes/[id]/restore/route.ts
  - src/components/initiative/InitiativeRunsStrip.tsx
  - src/components/notes/NoteCard.tsx
  - src/components/notes/NotesRail.tsx
  - src/components/InitiativeDetailView.tsx
  - src/components/audit-proposals/AuditProposalCard.tsx
mcp-tools: [take_note, propose_from_notes]
db-tables:
  - agent_notes (kinds: audit_manifest, audit_proposal, audit_synthesis, audit_verdict)
  - workspaces (audit_per_node_timeout_ms, audit_subtree_concurrency, audit_auto_spawn_pm)
  - agent_runs (kind='initiative_audit', run_group_id, parent_run_id)
  - mc_sessions (scope_type='initiative_audit')
migrations:
  - "078 mc_sessions.scope_type += 'initiative_audit' — src/lib/db/migrations.ts:4233-4292"
  - "079 workspaces.audit_per_node_timeout_ms + audit_subtree_concurrency — src/lib/db/migrations.ts:4293-4314"
  - "085 agent_runs.run_group_id (+ index) — src/lib/db/migrations.ts:4497-4516"
  - "087 agent_notes.kind += audit_manifest/audit_proposal/audit_synthesis — src/lib/db/migrations.ts:4536-4594"
  - "093 agent_notes.kind += audit_verdict; workspaces.audit_auto_spawn_pm — src/lib/db/migrations.ts:4704-4799"
related-specs:
  - audit-dedupe-followups.md — open dedupe items deliberately out of scope here
  - pm-diff-conventions.md — PM proposal contract that the verdict-bridge dispatches into
  - pm-revertable-proposals.md — downstream PM proposal flow
  - research-area.md — research notes also flow through agent_notes and feed audit briefings
  - jobs-in-progress.md — agent_runs spine the InitiativeRunsStrip filters
  - subagent-orchestration.md — convoy substrate explicitly NOT used by this pipeline
  - pm-convoy-mandate.md — audit follow-ups bypass the convoy mandate (carve-out)
---

# Audit Pipeline

> **PM convoy mandate carve-out.** Audit follow-ups bypass the
> decompose-flow convoy mandate documented in
> [pm-convoy-mandate.md](pm-convoy-mandate.md). Audit-spawned proposals
> use `trigger_kind = 'notes_intake'` (via `propose_from_notes`) and
> emit `create_task_under_initiative` diffs for tactical follow-ups —
> the mandate's required convoy shape only applies to strategic
> decomposition (`decompose_story` / `decompose_initiative` /
> `plan_initiative`). Future readers should not infer the mandate
> applies universally.


Canonical reference for the **initiative-audit** capability in Mission
Control. Supersedes `subtree-audit-proposals-spec.md`,
`audit-actions-and-tracking.md`, and `audit-action-recommended.md` (all
now under `docs/archive/`).

## 1. Overview & vocabulary

An **audit** in MC verifies an initiative's recorded state (status,
target window, decomposed scope, description) against repo reality
(commits, PRs, file contents) and emits structured findings that the PM
can act on. Two flavors share the same code path:

- **Narrow audit** — one researcher dispatch against one initiative.
  Output: a free-form `observation` note + a structured `audit_verdict`
  row. Entry: `POST /api/initiatives/:id/investigate` with `mode:
  'narrow'` (default).
- **Subtree audit** — MC-orchestrated layered fan-out across an
  initiative and its non-terminal descendants. Output: an
  `audit_manifest` (L1 surveyor), one `audit_proposal` per descendant
  (L2), and one `audit_synthesis` (L3) on the root. Entry: same route
  with `mode: 'subtree-proposal'`.

The two flavors share a single generic `auditor` role
(`agent-templates/auditor/`). The *contract* (what to investigate, what
schema to emit) is supplied per-dispatch via the briefing built by
`buildAuditPrompt` (`src/lib/agents/audit-prompt.ts`).

Three vocab terms recur throughout:

- **Surveyor (L1).** One dispatch on the subtree root. Emits an
  `audit_manifest` that lists every non-terminal descendant with a
  per-node hypothesis + scoped investigation prompt. Drives the L2
  fan-out. Code: `src/lib/agents/audit-survey.ts`.
- **Synthesizer (L3).** One dispatch on the root after L2 settles.
  Reads the manifest + every L2 proposal, emits an `audit_synthesis`
  with cross-cutting + epic-level proposals. Code:
  `src/lib/agents/audit-synthesizer.ts`.
- **Verdict.** The structured row paired with a narrow audit's
  observation. `audit_verdict` body declares `verdict`,
  `action_recommended`, optional `recommended_action_hint`, and a
  rationale. When the workspace toggle is on, the `take_note` MCP
  handler auto-dispatches a `notes_intake` PM session off this row.
  Code: `src/lib/agents/audit-auto-spawn.ts`.

Cancellation propagates through the standard `agent_runs.parent_run_id`
substrate. The pipeline does **not** create `tasks` rows and does **not**
ride the convoy / `spawn_subtask` agent-initiated fan-out substrate —
auditors are MC-orchestrated and read-only.

---

## 2. Data model

### 2.1 `agent_notes` body kinds

`NoteKind` is the canonical enum
(`src/lib/db/agent-notes.ts:19-30`). Audit-related kinds:

| Kind              | Emitter             | Body shape          | Stage |
| ----------------- | ------------------- | ------------------- | ----- |
| `audit_manifest`  | Surveyor (L1)       | JSON, §3.1          | survey |
| `audit_proposal`  | Per-node auditor (L2) or orchestrator (synthetic keep) | JSON, §3.2 | per-node |
| `audit_synthesis` | Synthesizer (L3)    | JSON, §3.3          | synthesis |
| `audit_verdict`   | Narrow auditor      | JSON, §3.4          | narrow |
| `observation`     | Narrow auditor      | free-form markdown  | narrow (paired with `audit_verdict`) |

All four JSON kinds are validated server-side by
`validateAuditNoteBody` in the `take_note` MCP handler
(`src/lib/mcp/groups/core.ts:440-469`); off-schema bodies are rejected
with `structuredContent: { error: 'audit_body_invalid' }` so the auditor
can retry within the same dispatch.

The `AUDIT_NOTE_KINDS` constant (`src/lib/db/agent-notes.ts:55-60`)
groups all four together so cross-audit readers (briefing builder,
NotesRail, default `listNotes` callers) can exclude them by default and
avoid bleed.

### 2.2 `workspaces` columns

- `audit_per_node_timeout_ms` (INTEGER, default 900_000 = 15 min) — per
  L2 dispatch ceiling. Mig 079.
- `audit_subtree_concurrency` (INTEGER, default 4) — concurrency cap
  enforced by `boundedAll` inside `runSubtreeAudit`. Mig 079.
- `audit_auto_spawn_pm` (INTEGER 0/1, default 0) — opt-in toggle for
  the verdict-bridge. Mig 093. Read via `getAuditAutoSpawn`
  (`src/lib/db/workspaces.ts:90-101`), written via `setAuditAutoSpawn`
  (`src/lib/db/workspaces.ts:110-117`).

`getAuditSettings(workspace_id)` reads the first two with spec defaults
(`src/lib/db/workspaces.ts:57-78`).

### 2.3 `agent_runs` columns

- `kind = 'initiative_audit'` — set on every audit dispatch row
  (surveyor, per-node, synthesizer, and the synthetic "subtree root"
  rollup row).
- `parent_run_id` — links L1/L2/L3 dispatches to the synthetic parent
  row that `runSubtreeAudit` creates first
  (`src/lib/agents/subtree-audit.ts:324-349`). Cancelling the parent
  cascades to children.
- `run_group_id` — added by mig 085
  (`src/lib/db/migrations.ts:4497-4516`). Consumed by the `take_note`
  cancelled-run guard (`src/lib/mcp/groups/core.ts:420-430`) — a
  worker whose run was cancelled cannot land notes.
- `source_kind = 'fanout'` — set on every audit-stage dispatch so the
  /jobs UI groups L1/L2/L3 under the root parent.

### 2.4 `mc_sessions` columns

`scope_type = 'initiative_audit'` was added by mig 078
(`src/lib/db/migrations.ts:4233-4292`). Used by:

- `findInFlightAudits` (dispatch-time 409 guard,
  `src/app/api/initiatives/[id]/investigate/route.ts:74-83`).
- `nextAuditAttempt` (computes the `:audit:N` suffix per initiative,
  route.ts:117-127 and resynthesize/route.ts:51-60).

---

## 3. Note-body schemas

All schemas live at
`src/lib/agents/audit-proposals/schemas.ts`. Bodies are
`JSON.stringify`d into `agent_notes.body` (TEXT, 3000-char DB cap).
Auditors are instructed to stay under
`MAX_AUDIT_NOTE_BODY_CHARS = 2900` (schemas.ts:29) so a tightening
retry has headroom.

### 3.1 `audit_manifest` — `auditManifestBodySchema` (schemas.ts:77-85)

```jsonc
{
  "version": 1,
  "root_initiative_id": "<uuid>",
  "attempt": <int>,
  "previous_synthesis_run_group_id": "<uuid>" | null,  // delta-link to prior audit
  "summary": "<1-paragraph framing>",
  "nodes": [
    {
      "initiative_id": "<uuid>",
      "title": "<string>",
      "current_status": "<MC status>",
      "hypothesis": "likely-done | likely-drifted | likely-cancelled | no-evidence | needs-deep-dive",
      "confidence": "low | medium | high",
      "investigation_prompt": "<scoped per-node ask for L2>",
      "scoped_evidence_hints": ["git log --oneline -- <path>", "rg <symbol>"],
      "skip": <bool>
    }
  ],
  "cross_cutting_questions": ["<string>"]
}
```

Field notes:

- `hypothesis` and `confidence` enums are shared at schemas.ts:33-41.
- `skip: true` is honored by the orchestrator **only** when paired with
  `confidence: 'high'`
  (`src/lib/agents/subtree-audit.ts:407-411`). Anything else
  dispatches.
- `previous_synthesis_run_group_id` is **defensively overwritten**
  server-side from the DB row, not trusted from the agent
  (`src/lib/agents/audit-survey.ts:294-300`). A hallucinated null still
  resolves to the real prior id when one exists.

### 3.2 `audit_proposal` — `auditProposalBodySchema` (schemas.ts:152-179)

```jsonc
{
  "version": 1,
  "node_initiative_id": "<uuid>",
  "current_mc_status": "<MC status>",
  "current_mc_target_end": "YYYY-MM-DD" | null,
  "proposed_action": "keep | mark_done | cancel | modify_scope | modify_dates",
  "proposed_changes": <shape depends on action; see §3.2.1>,
  "repo_evidence": [
    { "kind": "file | git | pr | note", "ref": "<string>" }
  ],
  "rationale": "<1-paragraph>",
  "confidence": "low | medium | high",
  "would_confirm_by": "<string>" | null,    // REQUIRED iff confidence != 'high'
  "continuation_note_id": null              // overflow chain pointer (rare path)
}
```

Field notes:

- `proposed_action` is a Zod **discriminated union**
  (schemas.ts:93-136) — `proposed_changes` shape is action-specific:
  - `keep` → `{}` (empty object enforced via superRefine, schemas.ts:167-177).
  - `mark_done` → `{ note: string }`.
  - `cancel` → `{ reason: string }`.
  - `modify_scope` → `{ title?, description? }` (≥1 required).
  - `modify_dates` → `{ target_start?, target_end? }` (YYYY-MM-DD; ≥1 required).
- `repo_evidence` requires `>= 1` entry (schemas.ts:144). Per-kind ref
  shape is **not** regex-enforced at write time — see the long
  rationale comment at schemas.ts:45-54. Defense-in-depth lives in the
  L2 prompt and the renderer.
- `would_confirm_by` is required when `confidence` is low or medium
  (superRefine at schemas.ts:155-166). Auditors get a structured field
  path back on rejection.

### 3.3 `audit_synthesis` — `auditSynthesisBodySchema` (schemas.ts:244-251)

```jsonc
{
  "version": 1,
  "root_initiative_id": "<uuid>",
  "attempt": <int>,
  "completion_sentinel": "Audit complete: N nodes — Xd / Yc / Zk / …",
  "epic_proposals": [
    { "proposed_action": "modify_epic_dates", "proposed_changes": { "target_end": "YYYY-MM-DD" }, "rationale": "…", "confidence": "…" },
    { "proposed_action": "modify_epic_scope", "proposed_changes": { "title?": "…", "description?": "…" }, ... }
  ],
  "cross_node_proposals": [
    { "proposed_action": "merge_stories", "subject_initiative_ids": ["uuid1","uuid2"], "rationale": "…", "confidence": "…" },
    { "proposed_action": "split_story", "subject_initiative_ids": ["uuid1"], ... },
    { "proposed_action": "new_story", "proposed_new_node": { "kind": "epic|story", "title": "…", "description": "…", "estimated_effort_hours?": 2 }, ... }
  ]
}
```

Field notes:

- `epic_proposals` (schemas.ts:185-216) is a discriminated union with
  exactly two members. **Per-node verdicts are NOT duplicated here** —
  the proposal-queue UI derives them from the L2 `audit_proposal`
  rows.
- `cross_node_proposals` (schemas.ts:218-242) is a discriminated union
  of three: `merge_stories` requires ≥2 subjects;
  `split_story` requires exactly 1; `new_story` carries a
  `proposed_new_node` block.
- `completion_sentinel` is intentionally first because feed/list views
  surface the head of the body.

### 3.4 `audit_verdict` — `auditVerdictBodySchema` (schemas.ts:282-299)

```jsonc
{
  "version": 1,
  "observation_note_id": "<id of the paired observation note>",
  "verdict": "on_track | partially_done | stale_rescope | never_built | done_in_entirety | cancelled_in_effect | audit_failed",
  "action_recommended": <bool>,
  "recommended_action_hint": "cancel | mark_done | decompose | modify_scope | modify_dates | investigate_further" | null,
  "short_rationale": "<20–800 chars>"
}
```

Field notes:

- `observation_note_id` lets the auto-spawn hook bundle the prose
  observation + structured verdict into a single PM trigger_text.
- `verdict` values (schemas.ts:262-270) and `recommended_action_hint`
  values (schemas.ts:273-280) are exported as readonly arrays.
- `verdictWarrantsAutoSpawn` (`audit-auto-spawn.ts:37-44`) fires on
  `action_recommended === true` OR `verdict === 'audit_failed'` (the
  latter even if `action_recommended === false`, defensively).

### 3.5 Validation surface

`validateAuditNoteBody(kind, bodyJson)`
(schemas.ts:334-382) is called from the `take_note` MCP handler
(`src/lib/mcp/groups/core.ts:440-469`) whenever `isAuditNoteKind(kind)`
returns true. Errors are compacted to `field.path: message` strings
(max 5 issues + " (+N more)") so auditor agents get an actionable retry
hint rather than a full ZodError dump.

---

## 4. Dispatch flow

### 4.1 Entry — `POST /api/initiatives/:id/investigate`

`src/app/api/initiatives/[id]/investigate/route.ts:180-400`.

Request shape (Zod schema at route.ts:54-67):

```jsonc
{
  "mode": "narrow" | "subtree-proposal",   // default "narrow"
  "guidance": "<string ≤ 2000 chars>" | null,
  "reaudit": "fresh" | "build_on",         // narrow only; subtree always fresh
  "supersede": <bool>                       // when true, cancel in-flight audits first
}
```

Two pre-dispatch guards:

1. **Hard-cutover 400** for `mode: 'subtree'`
   (route.ts:189-201). Phase 4 removed that mode in PR #290; old
   callers get a clear error pointing them at `subtree-proposal`.
2. **Dispatch-time 409** when `findInFlightAudits(id)` returns rows
   (route.ts:216-251). `supersede: true` cancels each via
   `cancelAgentRun(r.id)` and proceeds.

After guards, the route branches on `mode`:

- **Narrow** (route.ts:325-392): computes `nextAuditAttempt(id)`,
  pulls `priorFindings` if `reaudit === 'build_on'`, lists direct child
  initiatives (so parent-kind audits see their decomposition), calls
  `buildAuditPrompt({mode: 'narrow', ...})`, fires
  `dispatchScope({scope_type: 'initiative_audit', role: 'researcher',
  ...})` with 15-min timeout. Fire-and-forget. Response carries
  `scope_key`, `attempt`, `dispatched_at`.
- **Subtree-proposal** (route.ts:272-322): rejects terminal-status
  roots (no descendants left to audit), reads `getAuditSettings`,
  computes the plan via `planSubtreeAudit`, kicks off
  `runSubtreeAudit({...})` as a background promise. Response carries
  `root_scope_key`, `planned_nodes`, `planned_layers`, `concurrency`,
  `per_node_timeout_ms`, `dispatched_at`.

`GET /api/initiatives/:id/investigate?dryrun=1&mode=<m>`
(route.ts:129-178) is the read-only plan endpoint the
`InvestigateModal` calls to render the "X nodes, ETA Y" banner +
"audited N min ago" cooldown hint.

### 4.2 Subtree orchestration — `runSubtreeAudit`

`src/lib/agents/subtree-audit.ts:299-818`.

```
planSubtreeAudit                                            (subtree-audit.ts:216)
  ↓
synthetic root agent_runs row (parentRunId)                  (subtree-audit.ts:324-349)
  ↓
[L1] runSurveyor → audit_manifest note OR buildFallbackManifest
                                                             (subtree-audit.ts:355-399)
  ↓
filter / annotate plan from manifest                          (manifestNodeFor, isManifestSkip)
  ↓
for each LEAF + INTERMEDIATE layer:
   boundedAll(L2 dispatch | emitSyntheticKeepProposal, concurrency)
                                                             (subtree-audit.ts:419-731)
  ↓
[L3] runSynthesizer → audit_synthesis note                   (subtree-audit.ts:733-790)
  ↓
markRunRollup on synthetic parent                            (subtree-audit.ts:798-…)
```

Important behaviors:

- **L1 fallback.** When the surveyor dispatch fails or returns no
  manifest, `buildFallbackManifest` (audit-survey.ts:78-111) marks
  every non-terminal descendant `hypothesis: 'needs-deep-dive'`,
  `skip: false` — coverage equals the pre-Phase-2 full fan-out.
- **L2 synthetic-keep.** Manifest-skipped nodes get a server-side
  `audit_proposal` note (`emitSyntheticKeepProposal`,
  subtree-audit.ts:419-469) so the proposal queue retains full
  coverage without dispatching an auditor.
- **L2 invalid-proposal fallback.** If an auditor returns but no valid
  proposal body lands, `emitFallbackKeepProposal`
  (subtree-audit.ts:476-…) emits a synthetic
  `keep / confidence: 'low'` note with rationale `(audit failed: …)`.
- **L3 failure → no synthetic.** Per spec §5.5, the orchestrator does
  not invent a synthesis. The L2 proposal queue is the operator's
  safety net; the UI surfaces a "synthesis missing — re-run" affordance
  that hits `/resynthesize`.

### 4.3 Resynthesize — `POST /api/initiatives/:id/investigate/resynthesize`

`src/app/api/initiatives/[id]/investigate/resynthesize/route.ts`.

Re-runs only the L3 synthesizer against the existing manifest + the
most-recent `audit_proposal` per descendant. Cheap (no L1/L2 grep
storm). Used when the synthesizer failed mid-run or the operator wants
to re-roll the cross-cutting reasoning.

Flow:

1. Load latest `audit_manifest` note (resynthesize/route.ts:116-122) —
   400 if absent (no full audit has run yet).
2. Validate via `validateAuditNoteBody('audit_manifest', ...)`;
   tolerate validation failure by passing `manifest: null` to
   `runSynthesizer` (which will still emit, with an `(manifest
   unavailable)` banner in the briefing).
3. `loadProposalsForSubtree(rootId, workspace_id)` walks descendants
   and pulls one `audit_proposal` per node
   (`audit-synthesizer.ts:132-165`).
4. `nextAuditAttempt` computes the synthesis attempt number.
5. `runSynthesizer` dispatches; result carries `synthesis_note_id +
   dispatch_outcome ∈ 'ok' | 'no-synthesis' | 'failed'`.

A `_synthesizerOverride` test seam
(resynthesize/route.ts:67-77) parallels the `surveyorOverride` /
`synthesizerOverride` seams in `subtree-audit.ts:243-258`.

### 4.4 Briefing construction — `buildAuditPrompt`

`src/lib/agents/audit-prompt.ts`. Pure function. Four modes:

- `'narrow'` (audit-prompt.ts:201-346): renders description, status
  check, target window, child initiatives, direct tasks, prior
  findings (build-on mode), then the dual `take_note` call — first an
  `observation` (free-form prose), then an `audit_verdict` (structured
  row). Verdict guidance is spelled out inline (audit-prompt.ts:330-336).
- `'survey'` (audit-prompt.ts:356-486): L1 surveyor briefing. Includes
  the descendant list, optional git activity excerpt, optional
  prior-synthesis ref for delta mode, manifest JSON schema with worked
  example.
- `'subtree-proposal'` (audit-prompt.ts:496-710): L2 per-node briefing.
  Delegation-Contract block (`slice / deliverables / acceptance
  criteria`) sourced from the manifest entry, schema reminder with
  per-action `proposed_changes` shapes, retry guidance pointing at the
  `audit_body_invalid` channel.
- `'synthesis'` (audit-prompt.ts:720-900): L3 briefing. Inlines the
  manifest verbatim + per-proposal summaries (via
  `summarizeProposalForBriefing` from `subtree-audit-summarize.ts`) so
  the synthesizer doesn't need tree-walk tools.

All four modes share an end-of-turn discipline: emit ONE short
assistant message after the `take_note` call lands and STOP.
Without that terminal text the gateway burns the full timeout waiting
for `state: 'final'`.

### 4.5 take_note callback chain

`src/lib/mcp/groups/core.ts:367-540`. Order matters:

1. **Cancelled-run guard** (core.ts:420-430): `getRunByGroupId` lookup;
   refuses with `structuredContent: { error: 'run_cancelled', ... }`
   if the owning run is terminal. PR #1 of
   `audit-dedupe-followups.md`'s parent spec.
2. **Audit-kind body validation** (core.ts:440-469): triggered iff
   `isAuditNoteKind(kind)`. Two error channels: `audit_body_too_large`
   (>2900 chars) and `audit_body_invalid` (schema fail).
3. **createNote** (core.ts:~480-500) — persists the row with all
   required scope/role/group columns.
4. **importance=2 PM Chat ping** (core.ts:506-524): best-effort
   `postPmChatMessage` for importance-2 notes.
5. **audit_verdict auto-spawn hook** (core.ts:531-540): fires
   `maybeAutoSpawnPmFromVerdict(note)` for any `audit_verdict` row.
   Best-effort; failures are logged, never thrown.

---

## 5. Narrow vs subtree mode

Current state (post mig-093 + PR #326):

| Aspect           | Narrow                         | Subtree-proposal               |
| ---------------- | ------------------------------ | ------------------------------ |
| Mode param       | `'narrow'` (default)           | `'subtree-proposal'`           |
| Role             | `researcher`                   | `auditor` (L1/L2/L3)           |
| Dispatch count   | 1                              | 1 + N + 1 (surveyor + per-node + synthesizer) |
| Output           | observation + audit_verdict    | audit_manifest + N audit_proposal + audit_synthesis |
| PM hand-off      | verdict-bridge (auto) OR Ask-PM (manual) | Audit Proposals UI (accept/reject per row) |
| Cancellation     | per-run                        | cascades from synthetic parent |
| Re-run shortcut  | n/a                            | `POST .../resynthesize` (L3 only) |

The legacy `mode: 'subtree'` (free-form rolled-up prose) was removed in
Phase 4 (PR #290) as a hard cutover; the POST route 400s with a
`subtree-proposal` pointer (route.ts:189-201). Q7 from the original
`subtree-audit-proposals-spec.md` §9.2 ("should narrow also emit
audit_proposal?") was answered by `audit-action-recommended.md` /
PR #326 with a different shape: narrow emits an `audit_verdict` row
that bridges to PM via the auto-spawn hook. Same goal (downstream
gravity for narrow output), simpler shape (one row, no per-node
discriminated union).

---

## 6. Audit verdict + auto-spawn bridge

The verdict bridge is the **opt-in** path from narrow audit findings to
PM proposals. Without it, a narrow audit lands two notes and waits for
the operator to click Ask-PM. With it on, an `action_recommended ===
true` verdict (or any `audit_failed`) immediately dispatches a
`notes_intake` PM session.

### 6.1 Wiring

1. Narrow prompt instructs the auditor to call `take_note` twice — once
   for `observation`, once for `audit_verdict` referencing the
   observation's id (audit-prompt.ts:271-336).
2. `take_note` MCP handler validates the verdict body via
   `validateAuditNoteBody` (core.ts:440-469) and persists the row.
3. The post-create hook (core.ts:531-540) fires
   `maybeAutoSpawnPmFromVerdict(note)` for any row whose
   `kind === 'audit_verdict'`.
4. `maybeAutoSpawnPmFromVerdict` (`audit-auto-spawn.ts:50-152`):
   - Re-parses the body defensively (auto-spawn.ts:62-80) — the
     validator already ran, but a malformed body short-circuits here.
   - Checks `verdictWarrantsAutoSpawn(body)` (auto-spawn.ts:37-44) —
     `action_recommended === true` OR `verdict === 'audit_failed'`.
   - Gates on `getAuditAutoSpawn(workspace_id)` (auto-spawn.ts:85).
   - Resolves the paired observation by id; tolerates a missing
     pointer (verdict-only payload still suffices).
   - Builds `triggerText` via `formatTriggerText` (auto-spawn.ts:162-184)
     — verdict header + rationale + bundled observation body.
   - Calls `dispatchPm({ trigger_kind: 'notes_intake', allowFallback:
     true })`. `allowFallback: true` matches the disruption path: when
     the gateway is offline the synth row gives the operator something
     to react to and is superseded by the real PM reply later. This
     differs from the manual Ask-PM route, which uses `allowFallback:
     false` (`ask-pm-from-notes/route.ts:126`).
   - Bookkeeping: `markNoteConsumed(id, 'pm_proposal')` and
     `appendNoteProposalId(id, result.proposal.id)` on both notes
     (auto-spawn.ts:134-145). Idempotent.

### 6.2 Workspace toggle

- Column: `workspaces.audit_auto_spawn_pm INTEGER NOT NULL DEFAULT 0`
  (mig 093, migrations.ts:4791-4798).
- Read: `getAuditAutoSpawn(workspace_id)` (workspaces.ts:90-101).
- Write: `setAuditAutoSpawn(workspace_id, on)` (workspaces.ts:110-117).
- UI: workspace settings page checkbox
  (`src/app/(app)/workspace/[slug]/settings/page.tsx`).

Defaults to **off**. The dogfood split (dev `:4010` on, prod `:4001`
off) is the recommended pattern.

### 6.3 Failure modes

All best-effort, surfaced only as `console.warn`:

- Body re-parse fails → no dispatch (auto-spawn.ts:65-80).
- Verdict doesn't warrant auto-spawn → silent return.
- Workspace toggle off → silent return.
- Observation id resolves to a different initiative → warn + dispatch
  without observation block (auto-spawn.ts:96-101).
- `dispatchPm` throws → warn, leave notes intact. Operator's manual
  Ask-PM button still works.

---

## 7. Resynthesize endpoint

Covered in §4.3. Summary: `POST .../investigate/resynthesize` re-runs
L3 only against the existing manifest + L2 proposals. Used when:

- The original L3 dispatch failed and the operator wants the
  cross-cutting reasoning without paying for a second full audit.
- New per-node proposals were accepted/rejected and the operator wants
  the synthesis to re-roll against the surviving set.

Returns `400` if no manifest exists (no full audit has ever run for
the root).

---

## 8. Operator-facing UI

### 8.1 `InitiativeRunsStrip`

`src/components/initiative/InitiativeRunsStrip.tsx`. Mounted on
`InitiativeDetailView` between the header and the proposal section
(`InitiativeDetailView.tsx:1108-1116`).

- Polls `/api/jobs?workspace_id=…&initiative_id=…` every 2s
  (InitiativeRunsStrip.tsx:31, 117-148).
- Renders **live** runs (queued/running) as colored chips with elapsed
  time (amber after 5 min) and **recent terminal** runs (last 24h,
  capped at 3, InitiativeRunsStrip.tsx:33).
- Each chip links to `/jobs?run=<id>` for the drill-down panel.
- `kindBadge` maps `initiative_audit → 'audit'`, `pm_chat → 'PM'`, etc.
  (InitiativeRunsStrip.tsx:96-110).

Closes the "where did my dispatch go?" gap after a page refresh —
the 8s toast that used to be the only confirmation now has a
durable companion.

### 8.2 `NoteCard` actions

`src/components/notes/NoteCard.tsx`. Audit-actions PR 4 added an
action row (NoteCard.tsx:337-391):

- **Ask PM** (NoteCard.tsx:339-356): only when `kind === 'observation'`
  AND `onAskPm` is provided AND the note is not archived. Renders
  faded when `consumed_by_stages` contains `pm_proposal` — the
  operator can still re-ask. Routes to
  `POST /api/initiatives/:id/ask-pm-from-notes`.
- **Archive** (NoteCard.tsx:357-366): `POST /api/agent-notes/:id/archive`.
- **Restore** (NoteCard.tsx:368-377): only when archived.
  `POST /api/agent-notes/:id/restore`.
- **Delete** (NoteCard.tsx:379-389): only when archived. Caller wires
  through `ConfirmDialog` (no native `window.confirm` per project
  rule). `DELETE /api/agent-notes/:id`.

Collapse-aware: while collapsed the card renders icon-only shortcuts
in the header (NoteCard.tsx:236-285) so operators can sweep-archive
without expanding every card.

### 8.3 `NotesRail` archive toggle

`src/components/notes/NotesRail.tsx`. PR 4 adds:

- "Show archived" / "Trash" toggle button
  (NotesRail.tsx:228-235) — fetches with `include_archived=true`,
  splits the list into active + archived groups.
- Archived count badge when `showArchived` is off (NotesRail.tsx:233-234).
- Archived group is rendered grouped by `run_group_id`
  (NotesRail.tsx:181, 287) so a multi-note audit run trashes
  together.
- Two-step intent (NotesRail.tsx:74): archive first, then `ConfirmDialog`
  before hard delete (NotesRail.tsx:323-326).

### 8.4 `InvestigateModal`

`src/components/InvestigateModal.tsx`. Drives the entry-point UX
sketched in §4.1:

- "Audited N min ago" cooldown hint (NotesRail-adjacent excerpt at
  InvestigateModal.tsx:277-302).
- Persistent in-modal result card (PR 3 of `audit-actions-and-tracking`)
  replaces the disappearing toast.

### 8.5 `AuditProposalsSection`

`src/components/audit-proposals/AuditProposalsSection.tsx` (mounted in
`InitiativeDetailView.tsx:1098-1102`). Consumer of `audit_proposal` +
`audit_synthesis` notes. Per-row accept/reject/edit affordances route
through the same mutation surface as PM proposals
(see `src/app/api/initiatives/[id]/proposals/route.ts`).

### 8.6 Note action HTTP surface

Files (audit-actions PR 1):

- `src/app/api/agent-notes/[id]/route.ts` — `DELETE` (hard delete,
  requires archived state first).
- `src/app/api/agent-notes/[id]/archive/route.ts` — `POST { reason? }`.
- `src/app/api/agent-notes/[id]/restore/route.ts` — `POST`.

Two-step intent (archive → delete) prevents accidental loss when an
audit is mid-review and is enforced by the DAO
(`agent-notes.ts:387-410`, `AgentNoteNotArchivedError`).

---

## 9. PM hand-off

Three paths from audit output to PM proposal, sharing the same
`dispatchPm({ trigger_kind: 'notes_intake', ... })` substrate:

1. **Auto (verdict bridge).** Narrow audit emits `audit_verdict` with
   `action_recommended: true` + workspace toggle is on →
   `maybeAutoSpawnPmFromVerdict` fires immediately
   (`audit-auto-spawn.ts`). Uses `allowFallback: true`.
2. **Manual (Ask-PM from notes).** Operator clicks "Ask PM" on an
   `observation` card → `POST /api/initiatives/:id/ask-pm-from-notes`
   with `note_ids: [<note.id>]`
   (`ask-pm-from-notes/route.ts`). Uses `allowFallback: false`.
3. **Subtree proposals.** `audit_proposal` and `audit_synthesis` rows
   feed `AuditProposalsSection`; the operator accepts/rejects each.
   Accepts route to the mutation surface; rejects record a
   `decision`-kind note for future delta-run downweighting.

All three paths converge on `pm_proposals` rows, which carry the
`pm_diff_conventions` contract — see `docs/reference/pm-diff-conventions.md` for
the canonical diff shape PM is expected to emit.

The notes the audit produced track which proposal they spawned via
`pm_proposal_ids` (JSON array, `agent-notes.ts:443-475`,
`appendNoteProposalId`). NoteCard surfaces a "View proposal in PM chat"
link when present (NoteCard.tsx:304-321).

---

## 10. Dedupe & cancellation

Three guards stack:

1. **`run_cancelled` write guard on `take_note`** (PR #1 of
   `docs/archive/dedupe-investigations.md`). Mig 085 added
   `agent_runs.run_group_id`; the take_note handler refuses writes
   whose owning run is terminal
   (`src/lib/mcp/groups/core.ts:420-430`).
2. **Dispatch-time 409 guard.** `findInFlightAudits` blocks a second
   click; `supersede: true` cancels and proceeds
   (`investigate/route.ts:74-83, 216-251`).
3. **UI cooldown.** `InvestigateModal` shows "audited N min ago" via
   `lastCompleteAudit` (route.ts:91-103, modal:277-302).

**Cascade.** Cancelling the synthetic parent run created by
`runSubtreeAudit` cascades to L1/L2/L3 children via
`agent_runs.parent_run_id` (subtree-audit.ts:324-349). No additional
code required.

**Still open** (tracked in `audit-dedupe-followups.md`):

- The `run_cancelled` guard lives on `take_note` only. Generalizing to
  `register_deliverable`, `log_activity`, and `propose_changes` is
  Follow-up #1.
- Brief-dispatch path uses `skip_run_row: true`
  (`dispatch-scope.ts:230`); back-to-back brief dispatches on the same
  scope key both run. Follow-up #2.

---

## 11. MCP tool surface

| Tool                 | Location                                | Used by audit pipeline as |
| -------------------- | --------------------------------------- | ------------------------- |
| `take_note`          | `src/lib/mcp/groups/core.ts:367-540`    | The single intake for every audit-stage emission (manifest, proposal, synthesis, verdict, observation). |
| `propose_from_notes` | (PM persona, schema accepts `note_ids`) | Underlying contract the manual Ask-PM route reuses. |
| `read_brief`         | research-area surface                   | Research-output bridge: research notes (research-area kinds) feed audit context via `listNotes` even though they're not audit-kinds themselves. |

Auditors are read-only: they do **not** have `propose_changes`,
`update_task_status`, `update_initiative`, or `register_deliverable` on
their mount. Every audit prompt repeats that constraint
(audit-prompt.ts:336, 472-475, 696-700, 882-887).

---

## 12. Configuration

### 12.1 Workspace settings

| Column                       | Type / default | Purpose                                           |
| ---------------------------- | -------------- | ------------------------------------------------- |
| `audit_per_node_timeout_ms`  | INT / 900_000  | L2 per-node dispatch ceiling (15 min)             |
| `audit_subtree_concurrency`  | INT / 4        | L2 layer fan-out concurrency cap                  |
| `audit_auto_spawn_pm`        | INT 0/1 / 0    | Verdict-bridge opt-in                             |

### 12.2 Code constants

- `MAX_AUDIT_NOTE_BODY_CHARS = 2900` (schemas.ts:29) — pre-cap budget
  under the 3000-char `take_note.body` DB cap.
- `AUDIT_IDLE_TIMEOUT_MS = 5 * 60_000` (audit-survey.ts:32) — soft
  idle timeout for L1/L3 dispatches when the gateway misses
  `state: 'final'`.
- `POLL_MS = 2000`, `AMBER_ELAPSED_MS = 5 * 60 * 1000`,
  `RECENT_LIMIT = 3` (InitiativeRunsStrip.tsx:31-33) — UI polling
  knobs.

### 12.3 No env vars specific to audit

The pipeline rides standard MC env (`OPENCLAW_*`, `DATABASE_PATH`).
No audit-specific knobs at the env layer today.

---

## 13. Known limitations / open questions

1. **Synthetic-root cooldown regression test (originally §9.2 Q4 of
   subtree-audit-proposals-spec).** `findInFlightAudits(rootId)`
   queries `agent_runs.kind = 'initiative_audit' AND status IN
   ('queued','running')` (investigate/route.ts:74-83). The synthetic
   parent row created by `runSubtreeAudit` is `kind='initiative_audit'`
   too (subtree-audit.ts:326-340). In practice the synthetic row is
   started before L3 dispatches and remains `running` for the duration
   of the run, so the L3 dispatch could in principle hit the guard. No
   regression test exists today verifying that the L3 dispatch doesn't
   trip the 409 path against its own synthetic parent. Open question:
   filter `source_kind = 'fanout'` parents out of the in-flight scan,
   or rely on the timing to never collide.

2. **Per-kind `repo_evidence.ref` shape is not enforced server-side.**
   Schemas.ts:45-54 explicitly opts out of regex validation to avoid
   retroactively invalidating stored rows on read. Defense-in-depth
   lives in the L2 prompt
   (audit-prompt.ts:652-657) and the proposal-card renderer
   (`src/components/audit-proposals/AuditProposalCard.tsx`).
   Drift risk if either side relaxes.

3. **No cap on `continuation_note_id` chain depth.** Spec §4.5
   anticipated a possible cap (e.g. max 2 continuation notes per
   primary). Schemas don't enforce one. Deferred until real overflow
   patterns show up.

4. **Brief-dispatch dedupe hole** — see `audit-dedupe-followups.md`
   Follow-up #2. Briefs that feed audit context via `skip_run_row:
   true` are uncancellable and undeduped at the run-row layer.

5. **Generalization of the `run_cancelled` guard** — see
   `audit-dedupe-followups.md` Follow-up #1. Currently only `take_note`
   refuses writes for cancelled runs; `register_deliverable`,
   `log_activity`, and PM-persona `propose_changes` would still
   accept them.

6. **PM Chat note rendering parity.** PM chat surfaces note text inline
   in the transcript, not as discrete cards, so the NoteCard
   archive/Ask-PM affordances don't reach PM-rendered audit findings.
   Audit-actions §"Out of scope" flagged this; still unresolved.

---

## Appendix A: deltas from earlier specs

Useful when reading old chat transcripts or PR descriptions that
referenced the predecessor specs.

### A.1 From `subtree-audit-proposals-spec.md`

- Phases 1–6 all shipped (PRs #284–#290 + #307). The five-phase
  rollout in §10 is historical context, not a future plan.
- Phase 4 hard-cutover removed `mode: 'subtree'`. The investigate
  route 400s on it (route.ts:189-201) with a `subtree-proposal`
  pointer. The free-form rolled-up-prose flavor no longer exists.
- §9.2 Q7 ("should narrow audits emit `audit_proposal` too?") was
  answered with a different shape — narrow emits `audit_verdict`
  (see `audit-action-recommended.md` / PR #326), not
  `audit_proposal`. Same goal (downstream gravity for narrow output),
  simpler shape (one row vs the full per-node discriminated union).
- §9.2 Q4 (synthetic-root cooldown collision) — still open. See §13.1.
- `summarizeProposalForBriefing` was extracted into
  `src/lib/agents/subtree-audit-summarize.ts` so the synthesizer
  briefing builder doesn't need to import from subtree-audit.ts (avoids
  a cycle between audit-prompt.ts and subtree-audit.ts).

### A.2 From `audit-actions-and-tracking.md`

- All six PRs shipped. The PR 1–6 staging in the spec is historical.
- PR 6's "note ↔ run linkage chip" landed as the `originating_run`
  field on the note hook payload, surfaced via NoteCard.tsx:291-303.
- Out-of-scope items the spec named (inline edit; PM-chat note action
  parity; SSE-upgrade for the strip) are still out of scope.

### A.3 From `audit-action-recommended.md`

- Shipped as PR #326. Mig 093 added the column + extended
  `agent_notes.kind` (migrations.ts:4704-4799).
- `recommended_action_hint` enum landed verbatim per the spec
  (schemas.ts:273-280).
- Dispatch path uses `allowFallback: true` (auto-spawn.ts:129),
  intentionally different from the manual Ask-PM route's
  `allowFallback: false`. The spec called this out (§"Auto-spawn hook"
  step 5); recording here so future readers see why the two paths
  diverge.
- A dedicated "audit_verdict" NoteCard chip is still out of scope —
  observation notes carry the Ask-PM button, verdict rows are
  structural signal not operator-facing.

---

## Appendix B: file index

### DB / schema
- `src/lib/db/migrations.ts` — mig 078 (line 4233), 079 (4293), 085
  (4497), 087 (4536), 093 (4704).
- `src/lib/db/agent-notes.ts` — `NoteKind` (line 19), `NOTE_KINDS`
  (32), `AUDIT_NOTE_KINDS` (55), `createNote` (~155),
  `listNotes` (~245), archive/restore/hard-delete DAOs (347-410),
  `appendNoteProposalId` (454-475).
- `src/lib/db/workspaces.ts` — `getAuditSettings` (57-78),
  `getAuditAutoSpawn` (90-101), `setAuditAutoSpawn` (110-117).
- `src/lib/db/agent-runs.ts` — `run_group_id`, `parent_run_id`,
  cancellation cascade primitives.

### Service / orchestration
- `src/lib/agents/audit-prompt.ts` — `buildAuditPrompt`. Four modes.
- `src/lib/agents/audit-survey.ts` — L1 surveyor + fallback manifest.
- `src/lib/agents/audit-synthesizer.ts` — L3 synthesizer + proposal
  loaders.
- `src/lib/agents/audit-auto-spawn.ts` — verdict-bridge hook.
- `src/lib/agents/audit-proposals/schemas.ts` — all four Zod schemas +
  `validateAuditNoteBody`.
- `src/lib/agents/subtree-audit.ts` — `planSubtreeAudit` (216),
  `runSubtreeAudit` (299), synthetic-keep + fallback-keep emitters.
- `src/lib/agents/subtree-audit-summarize.ts` —
  `summarizeProposalForBriefing` (referenced by synthesis prompt).
- `src/lib/agents/audit-proposals/operator-actions.ts` /
  `operator-review.ts` — accept/reject helpers for the proposal queue.

### MCP
- `src/lib/mcp/groups/core.ts` — `take_note` handler (367-540) with
  cancelled-run guard, audit-body validation, verdict auto-spawn hook.
- `src/lib/mcp/shared.ts` — `noteKindArg` shared Zod arg (auto-tracks
  `NOTE_KINDS`).

### API
- `src/app/api/initiatives/[id]/investigate/route.ts` — entry point.
- `src/app/api/initiatives/[id]/investigate/resynthesize/route.ts` —
  L3 re-roll.
- `src/app/api/initiatives/[id]/ask-pm-from-notes/route.ts` — manual
  Ask-PM path.
- `src/app/api/initiatives/[id]/proposals/route.ts` — operator
  accept/reject endpoints for subtree audit proposals.
- `src/app/api/agent-notes/[id]/route.ts` — DELETE (hard-delete).
- `src/app/api/agent-notes/[id]/archive/route.ts` — POST (soft archive).
- `src/app/api/agent-notes/[id]/restore/route.ts` — POST (unarchive).
- `src/app/api/workspaces/[id]/route.ts` — workspace settings PATCH
  (carries `audit_auto_spawn_pm` toggle write).

### UI
- `src/components/InitiativeDetailView.tsx` — mounts strip + proposals
  section (lines 1098-1116).
- `src/components/initiative/InitiativeRunsStrip.tsx` — per-initiative
  in-flight surface.
- `src/components/InvestigateModal.tsx` — entry modal w/ cooldown +
  persistent result card.
- `src/components/notes/NotesRail.tsx` — archive toggle + grouped
  trash view.
- `src/components/notes/NoteCard.tsx` — per-note action row.
- `src/components/audit-proposals/AuditProposalsSection.tsx`,
  `AuditProposalCard.tsx` — proposal-queue surfaces.
- `src/app/(app)/workspace/[slug]/settings/page.tsx` — workspace
  audit-defaults checkboxes.
- `src/app/(app)/agents/[id]/page.tsx` — agent detail view (auditor
  role rendering).

### Agent templates
- `agent-templates/auditor/SOUL.md` — auditor role disposition.
- `agent-templates/auditor/AGENTS.md` — generic auditor operating
  instructions.
