# PM `confirm_task_done` diff kind

## Motivation

Today the PM agent cannot advance a task to `done`. The `set_task_status` diff
exists at the DB layer but the validator hard-rejects every status except
`cancelled` (revert path only), and the MCP `DiffSchema` doesn't even surface
`set_task_status`. So when PM observes evidence that a task is shipped — e.g.
an audit proposal that confirms a commit lands — its only recourse is to
file a `create_task_under_initiative` reminder asking a human to flip the
status. That reminder has no link back to the evidence and no enforcement
that the source task is actually in a finishable state.

The pm-soul guidance for initiatives ("`done`/`cancelled` are operator
territory") is correct: closing an initiative cascades into rollups,
roadmap commitments, and stakeholder reporting. Tasks are different —
they're the unit of work, the workflow already gates the approach to
`done` (review, verification), and the evidence that a task is finished
is usually concrete (PR merged, audit accepted).

This spec carves a narrow exception for tasks: PM may propose
`confirm_task_done` for a task already in a late workflow state, with
mandatory evidence, and the apply pass routes through the existing
`transitionTaskStatus` so workflow gates still run.

## Scope

In:
- New diff kind `confirm_task_done` on `PmDiff` and zod `DiffSchema`.
- Validation gate (current task status, evidence presence, audit-proposal
  existence).
- Apply pass that calls `transitionTaskStatus` with `newStatus='done'`
  and a structured `statusReason`.
- `invertDiff` support so the diff is revertable to the captured
  `prev_status`.
- pm-soul prompt updates: when to use this diff vs. `create_task_under_initiative`.
- Bundled cleanup: tighten `assigned_agent_id: z.string().nullish()` to
  `z.string().min(1).nullish()` so the empty-string class of bug fixed
  in #325 is rejected at the schema boundary.

Out:
- `confirm_initiative_done`. Initiative closure stays operator-only.
- Allowing PM to advance tasks to non-terminal statuses (still
  state-machine territory).
- Allowing PM to confirm-done a task currently in `inbox`/`assigned`/
  `in_progress` — those skip work; PM must file a reminder instead.

## Schema

`PmDiff` union (`src/lib/db/pm-proposals.ts`):

```ts
{
  kind: 'confirm_task_done';
  task_id: string;
  evidence_md: string;            // human-readable "why this is done"
  audit_proposal_id?: string;     // pointer to a previously-accepted PM audit
  commit_sha?: string;
  pr_url?: string;
  // Captured at apply time for revert:
  prev_status?: TaskStatus;
}
```

zod `DiffSchema` (`src/lib/mcp/shared.ts`) mirrors it. `evidence_md`
is `z.string().min(20)` so PM cannot ship a one-word attestation.

## Validation rules

In `validateProposedChanges` (case `confirm_task_done`):

1. `task_id` required and must exist in the workspace.
2. Current task status must be one of `convoy_active`, `testing`,
   `review`, `verification`. Any other state is rejected with a hint
   that PM should file a reminder via `create_task_under_initiative`.
3. `evidence_md` is required and `>= 20` chars.
4. At least one of `audit_proposal_id | commit_sha | pr_url` is
   present.
5. If `audit_proposal_id` is set, the row must exist in `pm_proposals`
   AND be in the same workspace AND have `status='accepted'`. A
   pending/rejected/draft audit is not evidence.
6. `commit_sha` (if present) must match `^[0-9a-f]{7,40}$`.
7. `pr_url` (if present) must be a valid URL.

## Apply

In `acceptProposal` second pass (`pm-proposals.ts`):

```ts
case 'confirm_task_done': {
  const before = queryOne<{ status: TaskStatus }>(
    'SELECT status FROM tasks WHERE id = ?',
    [change.task_id],
  );
  change.prev_status = before?.status; // captured for revert
  const reasonExcerpt = change.evidence_md.slice(0, 200);
  const result = transitionTaskStatus({
    taskId: change.task_id,
    actingAgentId: applied_by_agent_id,
    newStatus: 'done',
    statusReason: `PM confirm_task_done — ${reasonExcerpt}`,
  });
  if (!result.ok) {
    throw new PmProposalValidationError(
      `confirm_task_done(${change.task_id}): ${result.error}`,
    );
  }
  changesApplied++;
  // Audit-trail event (richer than the default status-change event):
  run(
    `INSERT INTO events (id, type, agent_id, task_id, message, metadata, created_at)
     VALUES (?, 'task_status_attested_done', ?, ?, ?, ?, ?)`,
    [
      uuidv4(),
      applied_by_agent_id ?? null,
      change.task_id,
      `Task confirmed done via PM proposal ${id}`,
      JSON.stringify({
        proposal_id: id,
        audit_proposal_id: change.audit_proposal_id ?? null,
        commit_sha: change.commit_sha ?? null,
        pr_url: change.pr_url ?? null,
      }),
      now,
    ],
  );
  continue;
}
```

The diff goes through `transitionTaskStatus`, so all existing gates
(self-review interlock, strict review gating, terminal-blocked
checks) still run. If a gate refuses, the whole transaction rolls
back and the operator sees a precise error, not a silent "applied —
0 changes."

## Revert

`invertDiff` adds:

```ts
case 'confirm_task_done': {
  if (!diff.prev_status) {
    throw new Error('confirm_task_done: missing prev_status capture');
  }
  return {
    kind: 'set_task_status',
    task_id: diff.task_id,
    status: diff.prev_status,
  };
}
```

This requires loosening the `set_task_status` validator to permit
revert-driven status restoration (it already permits `cancelled` for
the same reason). We extend it to "any value, but only when proposal
`trigger_kind === 'revert'`," matching how revert proposals already
flow.

## PM prompt updates

`src/lib/agents/pm-soul.md` — add to the "Diff catalog" / "What you do"
section:

> **`confirm_task_done`** — when an audit proposal, merged PR, or
> verifiable commit confirms a task in `convoy_active`/`testing`/
> `review`/`verification` is shipped. Always include `evidence_md` and
> at least one structured pointer (`audit_proposal_id`, `commit_sha`,
> or `pr_url`). Never use this for tasks earlier in the workflow —
> file a `create_task_under_initiative` reminder so an operator can
> drive the proper transitions.

## Tests

`src/lib/db/pm-proposals.test.ts`:
- ✅ Happy path: task in `review`, audit accepted → applies, status=done.
- ❌ Reject when source status is `inbox`/`assigned`/`in_progress`.
- ❌ Reject empty `evidence_md` and `< 20` char evidence.
- ❌ Reject when no structured pointer is provided.
- ❌ Reject when `audit_proposal_id` references a `draft` proposal.
- ✅ Round-trip: confirm → revert restores `prev_status`.

`src/lib/mcp/groups/pm.schema.test.ts`:
- ✅ `confirm_task_done` accepted by zod with valid payload.
- ❌ Empty `assigned_agent_id` rejected on `create_task_under_initiative`
  (regression for the bug fixed in #325).

## Files touched

- `src/lib/db/pm-proposals.ts` — type, validation, apply, invertDiff.
- `src/lib/mcp/shared.ts` — DiffSchema entry + assigned_agent_id tightening.
- `src/lib/services/task-status.ts` — no change needed; existing entry
  point handles the transition.
- `src/lib/agents/pm-soul.md` — diff-catalog entry.
- Tests as above.
