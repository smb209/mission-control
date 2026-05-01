# PM action audit log + revertable proposals

## Why

The PM agent mutates initiative/story state via accepted proposals. Today there is no end-user-visible audit timeline and no one-click revert. Product decision: the PM should never hard-delete — `set_initiative_status: 'cancelled'` is the strongest destructive action it can take — but cancelled rows currently still render inline in the tree. We need:

1. Reversibility on every accepted proposal.
2. A UI affordance that keeps cancelled tombstones from cluttering normal browsing.

## Existing infrastructure (do NOT re-invent)

- **`pm_proposals` table** — schema in [src/lib/db/migrations.ts](../src/lib/db/migrations.ts) around line 2468. Already persists each proposal with its full diff list, `applied_at`, `applied_by_agent_id`, `status` (`draft|accepted|rejected|superseded`). This **is** the audit log; we just don't surface it.
- **`initiative_parent_history`** ([migrations.ts:2423](../src/lib/db/migrations.ts)) and **`task_initiative_history`** ([migrations.ts:2435](../src/lib/db/migrations.ts)) — parent/task move audit, already written by the proposal accept path.
- **`rollback_history`** table (migration 026, [migrations.ts:1482](../src/lib/db/migrations.ts)) — currently scoped to product rollbacks. Do **not** repurpose; add a separate concept.
- **Diff vocabulary** lives in [src/lib/db/pm-proposals.ts:46–105](../src/lib/db/pm-proposals.ts). Supported kinds:
  - `shift_initiative_target`
  - `set_initiative_status`
  - `add_dependency`
  - `remove_dependency`
  - `reorder_initiatives`
  - `update_status_check`
  - `create_child_initiative`
  - `create_task_under_initiative`
  - `add_availability`

  No delete kind exists, by design.
- **`applyDiff` switch** at [pm-proposals.ts:752](../src/lib/db/pm-proposals.ts) — that's where each kind's forward apply lives, and where you'll discover the per-kind state needed to compute an inverse.
- **PM page**: [src/app/(app)/pm/page.tsx](../src/app/(app)/pm/page.tsx).
- **Proposal diffs UI**: [src/components/pm/ProposalDiffsList.tsx](../src/components/pm/ProposalDiffsList.tsx).
- **Initiatives tree**: [src/app/(app)/initiatives/page.tsx](../src/app/(app)/initiatives/page.tsx).

## Scope — three deliverables

### 1. Hide cancelled initiatives by default with a filter toggle

- In the initiatives tree (`/initiatives`) and any picker/select that lists initiatives (PM proposal target picker, dependency picker), filter out rows where `status='cancelled'` by default.
- Add a "Show cancelled" toggle in the tree header. Persist preference in URL query param (`?show_cancelled=1`) so links are shareable; mirror to localStorage as a fallback default.
- Cancelled rows, when shown, should render with reduced opacity + a "cancelled" pill so they're visually distinct.
- Decide and document whether `done` deserves the same hidden-by-default treatment. **Recommendation:** leave `done` visible (it's positive completion signal); only hide `cancelled`. If you disagree after auditing, propose the alternative in the PR description.
- Children of a cancelled parent should **not** be auto-hidden — only direct `status='cancelled'` rows. (User may want to see what was scoped under a cancelled epic.)
- **Do not** touch the API filter — keep backend returning everything; this is purely a client-side filter so the audit/revert paths can still see cancelled rows.

### 2. Revertable proposals

Add a `revert_proposal` action: given an accepted proposal, synthesize the inverse diff list and create a **new draft proposal** with `trigger_kind='revert'` and a `reverts_proposal_id` foreign key column on `pm_proposals` (new migration).

**Inverse mappings** — implement in a new helper, e.g. `src/lib/pm/invertDiff.ts`:

| Forward kind | Inverse strategy |
|---|---|
| `set_initiative_status: { from: A, to: B }` | `set_initiative_status: { from: B, to: A }`. Forward apply must capture `from` if it doesn't already; check current schema. |
| `shift_initiative_target` | Swap before/after dates (already symmetric). |
| `update_status_check` | Restore previous markdown. Forward apply must persist the previous value into the diff record at apply time. |
| `add_dependency` | `remove_dependency` (need the created dependency_id, captured at apply). |
| `remove_dependency` | `add_dependency` (need the full dependency row snapshot, captured at apply). |
| `reorder_initiatives` | Reorder back to the previous sort_order list. |
| `create_child_initiative` | `set_initiative_status: 'cancelled'` on the created row (we don't delete). The created child's id must be captured back into the diff record at apply time so revert can target it. |
| `create_task_under_initiative` | `set_task_status: 'cancelled'` (if that diff kind exists; if not, add it). Same id-capture pattern. |
| `add_availability` | Mark the row inactive or mirror with a removal diff. Audit current `add_availability` apply path; choose the cleanest inverse. |

**The "captured at apply time" pattern is critical:** each forward apply should persist enough state into the diff record (or a sibling table) that the inverse is a pure function of the diff row alone. Don't recompute from current DB state at revert time — it'll have drifted.

**Review flow:**
- Reverts produce a new proposal that goes through the normal review→accept flow. Do **not** auto-apply. The user must approve the revert just like any other proposal, so they can see and edit it first.
- If the proposal being reverted is itself a revert, that's fine — it just produces another inverse. No special-casing.
- If any state the original diff touched has been further modified since (e.g. someone manually changed status after the PM set it), surface that in the revert preview as a **warning chip per affected diff**. Do **not** block — let the user decide.

### 3. PM activity timeline UI

- New tab or section on `/pm` (or a new route `/pm/activity`) showing a chronological feed of accepted proposals: `trigger_kind`, target initiative title, summary of diffs, `applied_at`, `applied_by_agent_id`, and a "Revert" button per row.
- Filter chips: `trigger_kind` (decompose, status, dependency, etc.), agent, date range.
- Clicking a row expands the full diff list (reuse `ProposalDiffsList` in a read-only mode if reasonable).
- "Revert" button calls the new revert endpoint and routes the user to the resulting draft proposal.

## Non-goals

- Hard delete of initiatives/stories. Stays disabled in the PM. Operator-only via existing `DELETE /api/initiatives/[id]`.
- Reverting non-PM mutations (direct API edits, UI edits made outside the proposal flow). Only proposals get the revert button.
- Auto-revert / scheduled revert / TTL on proposals. Manual only.

## Migration & backfill

- New migration: add `reverts_proposal_id` column on `pm_proposals` (nullable). Add `'revert'` to the `trigger_kind` enum (check current CHECK constraint in `migrations.ts`).
- Add capture columns on the diff JSON shape — the diff is stored as JSON so this is a code-level change, not a schema one, but the TypeScript types in [pm-proposals.ts:46–105](../src/lib/db/pm-proposals.ts) need updating.
- **Existing accepted proposals** predate the capture pattern — they'll show "Revert (limited)" with a tooltip explaining the inverse can't be computed for diffs that didn't capture before-state. Do not block; just disable the button per-diff with a hover explanation.

## Tests

- Unit tests for `invertDiff.ts` covering each kind round-trip: `apply(forward) → apply(invert(forward))` returns DB state to baseline. Use the in-memory test DB pattern already in [pm-proposals.test.ts](../src/lib/db/pm-proposals.test.ts).
- Integration test: full proposal accept → revert → accept-revert flow, verify final state matches initial.
- UI smoke: `/pm/activity` renders, revert button creates a draft, draft renders correctly in the proposal review UI.

## Verification

Use `preview_*` tools after implementation:

1. Start dev server.
2. Click through `/initiatives` — toggle works, cancelled hidden by default.
3. Visit `/pm/activity` — timeline renders, revert creates a draft.
4. Accept a revert proposal and confirm state restoration end-to-end.

## Project conventions (from CLAUDE.md)

- **Yarn**, not npm.
- PRs target `smb209/mission-control` with `--repo smb209/mission-control --base main`.
- Run the full test suite before declaring green; surface any pre-existing failures explicitly.
- Spec-first for multi-layer changes — this doc fulfills that requirement; revise it as scope shifts during implementation.

## Suggested PR breakdown

1. **Foundation** — migration + diff capture columns + types. No UI.
2. **Logic** — `invertDiff.ts` + revert endpoint + tests. No UI.
3. **Timeline UI** — `/pm/activity` + revert button. UI on top of the working backend.
4. **Cancelled-filter toggle** on `/initiatives`. Independent slice, can ship parallel to 1–3.

Each as its own PR stacked on the previous. **Retarget child PR bases to `main` before merging the parent with `--delete-branch`** (per CLAUDE.md stacked-PR note) — otherwise GitHub auto-closes the children.
