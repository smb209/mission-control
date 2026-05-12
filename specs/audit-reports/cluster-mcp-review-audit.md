# Cluster: MCP Surface / Review / Audit

Audited on branch `feat/audit-action-recommended`. Code surfaces verified: `src/lib/mcp/groups/*`, `src/lib/mcp/server.ts`, `src/app/api/mcp/{pm,crud}/route.ts`, `src/lib/agents/audit-*.ts`, `src/lib/agents/audit-proposals/`, `src/lib/db/{agent-notes,workspaces,migrations}.ts`, `src/lib/services/task-status.ts`, `src/lib/task-governance.ts`, `src/lib/stall-detection.ts`, `src/lib/dispatch/roster-gate.ts`.

## Verdict table

| Spec | Class | Rationale | Evidence |
|---|---|---|---|
| specs/mcp-surface-review.md | 4 (mostly) + 2 residual | Refactor PRs 1–5 shipped; PR 3.5 (named-agent sync) and PR 6 (doc principle) still TBD | groups present `src/lib/mcp/groups/{core,read,work,pm,crud}.ts`; routes `src/app/api/mcp/{pm,crud}/route.ts`; `update_subtask`/`update_note`/`escalate_to_parent` in `src/lib/mcp/mcp.test.ts:83-128` |
| docs/archive/mcp-surface-v2-build-plan.md | 4 | Companion build plan for shipped refactor — archive | Same code evidence as above; commit log shows slice PRs landed |
| docs/archive/mcp-surface-v2-validation/ | 4 | Validation artifact for shipped work | Directory pattern matches CLAUDE.md "default class 4" |
| specs/audit-action-recommended.md | 2 (in-progress on this branch) | Spec is implemented but uncommitted; branch name == spec name | `git status` shows M for `audit-prompt.ts`, `audit-proposals/schemas.ts`, `agent-notes.ts`, `migrations.ts`, `workspaces.ts`, `mcp/groups/core.ts`; new `audit-auto-spawn.ts` untracked; migration 093 present `src/lib/db/migrations.ts:4791-4797` |
| specs/audit-actions-and-tracking.md | 1 (shipped) | All 6 PRs (note-lifecycle DAO, runs strip, NoteCard actions, ask-PM, etc.) landed | `restoreNote`/`hardDeleteNote` `src/lib/db/agent-notes.ts:370,402`; `InitiativeRunsStrip` `src/components/initiative/InitiativeRunsStrip.tsx`; ask-PM route `src/app/api/initiatives/[id]/ask-pm-from-notes/`; archive UI `src/components/notes/NotesRail.tsx:228`; `NoteCard.tsx:346` Ask-PM button |
| specs/subtree-audit-proposals-spec.md | 1 (shipped, with one open item) | Phases 1–6 all landed; §9.2 Q4 (synthetic-root cooldown) and Q7 (narrow→audit_proposal) remain truly open | `audit-survey.ts`, `audit-synthesizer.ts`, `audit-proposals/schemas.ts` present; commits #284–#290; resynthesize route `src/app/api/initiatives/[id]/investigate/resynthesize/`; `mode: 'subtree'` removed `investigate/route.ts:197` |
| specs/review-stage-robustness-spec.md | 1 (shipped) | All 6 slices (0–5) landed on the stack | Slice 0 `src/lib/dispatch/roster-gate.ts` (commit `1c249d0`); Slice 1 `task-status.ts:42,72,156,165`; Slice 2 migration 091 `migrations.ts:4676-4685` + `task-governance.ts:114-125`; Slice 3 `escalate_to_parent` in `mcp.test.ts:810+`, `locked_for_completion` column; Slice 4 `stall-detection.ts:20-31,218-279`; Slice 5 `pm-soul.md:168`, `builder-soul.md:95` |
| docs/archive/review-stage-robustness-build-plan.md | 4 | Companion build plan — feature shipped, archive candidate | Same code evidence as parent spec; commits f218129/49d9cfc/818f42f/0d90a47 |
| docs/archive/review-stage-robustness-validation/ | 4 | Validation artifact for shipped feature | Per CLAUDE.md default |

## Per-spec notes

### specs/mcp-surface-review.md
- Classification: **4 (with 2 residual items)**.
- Spec claims: 6-PR queue (refactor → routes → openclaw sync → named-agent sync → `update_subtask` → `update_note` → doc principle).
- Code reality: PR 1 (groups split) shipped — `src/lib/mcp/server.ts:14-26` imports five groups. PR 2 (pm/crud routes) shipped — `src/app/api/mcp/pm/route.ts`, `src/app/api/mcp/crud/route.ts`. PR 4 (`update_subtask`) and PR 5 (`update_note`) shipped — `src/lib/mcp/mcp.test.ts:83,128` asserts new names, lines 91-94/131-134 assert old names removed. Tool count comment at `mcp.test.ts:163` says "46 tools after Slice 3 of review-stage-robustness adds escalate_to_parent" — matches 9+6+5+10+16 from grep. PR 3 (`yarn openclaw:apply-mc-servers`) and PR 3.5 (`yarn openclaw:sync-named-agents`) — no scripts of those names appear; status uncertain. PR 6 (PM SOUL discriminated-union principle codification) — `pm-soul.md` does not reference the principle by name.
- Recommendation: archive primary refactor narrative; spin a small follow-up tracking PR 3 / 3.5 / 6 if those operator-facing scripts haven't actually landed under different names.
- Cross-cluster overlap: subtree-audit-proposals validates `take_note` body in `mcp/groups/core.ts` (a surface this spec partitioned).

### docs/archive/mcp-surface-v2-build-plan.md
- Classification: **4** — companion build plan; feature shipped.
- Recommendation: archive alongside parent.

### docs/archive/mcp-surface-v2-validation/
- Classification: **4** — validation artifact.
- Recommendation: archive.

### specs/audit-action-recommended.md
- Classification: **2 (in-progress / aspirational on disk, but fully implemented on this branch — pre-commit)**.
- Spec claims: new `audit_verdict` note kind + workspace `audit_auto_spawn_pm` toggle + `maybeAutoSpawnPmFromVerdict` auto-spawn hook in `take_note`.
- Code reality: Schema work present — `NoteKind` includes `'audit_verdict'` `src/lib/db/agent-notes.ts:30`; `auditVerdictBodySchema` in `src/lib/agents/audit-proposals/schemas.ts` (modified). Migration 093 adds the kind + `workspaces.audit_auto_spawn_pm` column `src/lib/db/migrations.ts:4711-4797`. `getAuditAutoSpawn`/`setAuditAutoSpawn` at `src/lib/db/workspaces.ts:90,114`. Hook wired at `src/lib/mcp/groups/core.ts:533` calling `maybeAutoSpawnPmFromVerdict` from new untracked file `src/lib/agents/audit-auto-spawn.ts`. UI surface: workspace settings page modified (`src/app/(app)/workspace/[slug]/settings/page.tsx`).
- Recommendation: this spec moves to (1) once the branch lands. As of audit time, treat as the live spec for the in-flight PR.
- Cross-cluster overlap: ties into PM cluster (consumes `dispatchPm` for `notes_intake`) and to subtree-audit-proposals (verdict is a 4th audit-kind sibling).

### specs/audit-actions-and-tracking.md
- Classification: **1 — current & accurate**.
- Code reality: All six PRs landed. `restoreNote`/`hardDeleteNote` in `agent-notes.ts:370,402`. `InitiativeRunsStrip` mounted at `InitiativeDetailView.tsx:1110`. Ask-PM-from-notes route + button present. Archived-notes toggle in `NotesRail.tsx:228`.
- Recommendation: keep as documentation of the shipped surface; no spec drift detected.

### specs/subtree-audit-proposals-spec.md
- Classification: **1 — current & accurate** (with the noted §9.2 items still open as designed).
- Code reality: `audit_manifest`/`audit_proposal`/`audit_synthesis` note kinds present `agent-notes.ts:27-29`. `runSurveyor`/synthesizer imported in `subtree-audit.ts:42,57`. Phase 4 hard cutover live at `investigate/route.ts:197` ("mode subtree was removed; use subtree-proposal"). Resynthesize endpoint exists. Commits #284–#290 land phases 1–6.
- Recommendation: keep as canonical reference; spec is large but matches code; minor §9.2 open questions are honestly-flagged.
- Cross-cluster overlap: foundation for `audit-action-recommended.md` (verdict-kind is a 4th sibling); shares `take_note` validation surface with MCP-surface refactor.

### specs/review-stage-robustness-spec.md
- Classification: **1 — current & accurate**.
- Code reality: Slice 0 `roster-gate.ts` (commit `1c249d0`). Slice 1 `MC_REVIEW_STRICT_GATING` + `self_review_blocked`/`reviewer_required` codes at `task-status.ts:42,72,156,165`. Slice 2 migration 091 + `task-governance.ts:114-125` honoring `required_evidence_gates`. Slice 3 `escalate_to_parent` tool + soft-lock — `mcp.test.ts:810-845`. Slice 4 `STALL_DETECTION_MINUTES_REVIEW` + `MC_REVIEW_AUTOBOUNCE` at `stall-detection.ts:20-31`. Slice 5 soul-doc updates at `pm-soul.md:168`, `builder-soul.md:95`.
- Recommendation: keep as canonical reference; the build plan + validation dir are now archive candidates.

### docs/archive/review-stage-robustness-build-plan.md
- Classification: **4** — companion build plan, feature shipped.
- Recommendation: archive.

### docs/archive/review-stage-robustness-validation/
- Classification: **4** — validation artifact.
- Recommendation: archive.

## Cross-cluster overlap flags

1. **`audit-action-recommended.md` is a tight extension of `subtree-audit-proposals-spec.md`** (adds a 4th `audit_verdict` note kind alongside the three established kinds). Both specs touch the same files: `agent-notes.ts`, `audit-proposals/schemas.ts`, `mcp/groups/core.ts`. Once the branch merges, consider consolidating both into a single "Audit Pipeline" reference doc.
2. **`audit-actions-and-tracking.md` overlaps with the L4 proposal-queue UI sketched in §8 of `subtree-audit-proposals-spec.md`** — the NoteCard "Ask PM" button and InitiativeRunsStrip are the operator-facing review surface that §8 sketched. Worth a cross-reference but not a merge.
3. **MCP-surface review's "messaging-protocol.md doc sync" gap** is independent of review-stage-robustness but both edit `_shared/messaging-protocol.md`; check sequencing if PR 3.5 still needs to land.
4. **Review-stage-robustness Slice 3's `escalate_to_parent` tool is registered in `groups/work.ts`** — counted in the MCP-surface review's 46-tool budget.

## Consolidation suggestions

- **Archive** `mcp-surface-v2-build-plan.md`, `mcp-surface-v2-validation/`, `review-stage-robustness-build-plan.md`, `review-stage-robustness-validation/` (move to `specs/archive/` or add a `Status: Shipped` banner). All four describe features that have fully landed; the parent spec(s) keep the design rationale.
- **Spin a small follow-up issue** for `mcp-surface-review.md` PRs 3 / 3.5 / 6 if those operator scripts (`openclaw:apply-mc-servers`, `openclaw:sync-named-agents`) haven't shipped under different names; otherwise update the spec's "Recommended action queue" to mark them done.
- **After `feat/audit-action-recommended` merges**, fold `audit-action-recommended.md` into `subtree-audit-proposals-spec.md` as a "§4.6 audit_verdict (narrow-mode bridge)" subsection — the verdict kind is structurally the narrow-mode answer to §9.2 Q7.
- `audit-actions-and-tracking.md` can stay standalone; it describes UI surfaces (NoteCard, NotesRail, InitiativeRunsStrip) cleanly orthogonal to the audit pipeline itself.

---

## Five-line summary

1. MCP-surface review + build-plan + validation: feature shipped (groups, pm/crud routes, `update_subtask`/`update_note`, `escalate_to_parent`); PRs 3/3.5/6 status uncertain — archive plan, follow up on scripts.
2. Audit-action-recommended: implemented on this branch but uncommitted; class (2) until the branch lands then (1).
3. Audit-actions-and-tracking: all six PRs shipped; spec is current and accurate, class (1).
4. Subtree-audit-proposals: phases 1–6 all landed; class (1) with two genuinely open §9.2 items.
5. Review-stage-robustness: all six slices (0–5) shipped on this branch's stack; spec stays (1), build plan + validation are archive candidates.

## Top 3 drift items

1. **`mcp-surface-review.md` PR 3 / 3.5 / 6 unconfirmed** — no `openclaw:apply-mc-servers` or `openclaw:sync-named-agents` scripts found; PM SOUL doesn't codify the "extend `propose_changes`, don't add new tools" principle by name. Either land them or strike them from the queue.
2. **`audit-action-recommended.md` is on disk but uncommitted** — schema + migration + auto-spawn hook are all wired in working-tree edits, but `audit-auto-spawn.ts` is untracked. Land the commit before merging the branch or the spec/code split widens.
3. **`subtree-audit-proposals-spec.md` §9.2 Q4 (synthetic-root cooldown)** — the spec flagged this as needing a regression test; quick verification of `findInFlightAudits` filtering on `source_kind = 'fanout'` would close the loop. Not visibly addressed in the shipping commits.
