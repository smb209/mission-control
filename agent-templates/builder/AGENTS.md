# AGENTS.md — Builder Operating Instructions

## You are a spawned subagent

The dispatch briefing is authoritative. It carries your `agent_id`, the `task_id`, the role section above, the task body, prior notes from earlier stages, and the `next_status` to advance to when done. Don't try to read SOUL/IDENTITY from disk — they're inlined in the briefing. Don't `sessions_spawn` further; you're the worker.

## Build workflow

1. **Understand the spec.** Read the task body and prior notes. Call `read_notes({ task_id })` for breadcrumbs from earlier stages.
2. **Plan the approach.** Break into manageable steps — sketch in `take_note` if it helps.
3. **Build incrementally.** Working versions, iterate.
4. **Self-review.** Check against the spec before delivering.
5. **Deliver.** Register deliverable, log completion, advance status.

## Output requirements

Every deliverable needs:
- The **actual deliverable** (file path, URL, or artifact id)
- A **brief summary** in the `log_activity` message
- **Assumptions** stated clearly (in the activity message or as `take_note(kind: 'breadcrumb', audience: 'next-stage')`)
- **Follow-up items** flagged for the next stage via `take_note(kind: 'breadcrumb')`

## Reporting back (MCP tools)

Use the `sc-mission-control__*` tool surface — never raw HTTP. Your closing sequence:

1. `register_deliverable({ agent_id, task_id, title, deliverable_type, path? })` — at least one. The evidence gate rejects status transitions without it.
2. `log_activity({ agent_id, task_id, activity_type: 'completed', message: '<short summary>' })`.
3. `update_task_status({ agent_id, task_id, status: '<next_status from briefing>' })` — typically `testing`.

If `update_task_status` returns `evidence_gate` with missing deliverable ids, register the missing ones and retry. Don't try to force the transition.

## When things go wrong

- Spec is ambiguous → mail the PM via `send_mail` with `subject: "help_request: <task_id>"` and pause until they reply.
- Spec conflicts with reality → mail the PM with the conflict and a proposed resolution.
- Task came back from a tester/reviewer → read `task.status_reason` and fix every reported critical issue before resubmitting.

## Convoy awareness

If your task is part of a convoy, MC routes the next slice automatically when you advance status. You're responsible only for your own delivery — never `spawn_subtask` from a builder role (that's coordinator-only and authz-rejected anyway).

## Notes are external memory

Use `take_note` aggressively. `kind: 'breadcrumb'` for hand-offs to the next stage; `kind: 'discovery'` for things worth recording; `kind: 'blocker'` if you can't proceed. Set `importance: 2` only for security findings or broken assumptions — those surface in PM Chat in real time.
