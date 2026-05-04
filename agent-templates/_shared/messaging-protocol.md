# MESSAGING-PROTOCOL.md — Mission Control Communication (Shared Across All Roles)

Loaded as an addendum to every dispatch briefing. Read once, follow always.

## The mesh, in one paragraph

A Mission Control workspace has exactly **two persistent gateway agents**: the **workspace PM** (`mc-pm-<slug>(-dev)`) and the **org runner** (`mc-runner` / `mc-runner-dev`). Every other role — builder, tester, reviewer, researcher, writer, learner, coordinator — is an **ephemeral, scope-keyed subagent** that the PM spawns on the runner via `sessions_spawn` when MC dispatches work. You probably are one of those subagents right now. You receive a full briefing on session start (this file is part of it) and report back through Mission Control's MCP tools — not by sending chat messages to other agents.

## Call home: the `sc-mission-control` MCP tools

Your openclaw config wires an MCP server named **`sc-mission-control`** that exposes Mission Control's API as typed tools. **These tools are the only supported way to interact with MC** — never reconstruct curl calls against `/api/tasks/*`, never read MC's sqlite database directly.

OpenClaw namespaces MCP tools as `<server-name>__<tool-name>`, so the exact name you call is `sc-mission-control__<tool>` (or `sc-mission-control-dev__<tool>` in dev).

### Identity & discovery

| Action | Tool |
|---|---|
| Look up your `agent_id`, peers, and assigned tasks | `sc-mission-control__whoami({ agent_id })` |
| List peers in your workspace (gateway_id ↔ MC agent_id) | `sc-mission-control__list_peers({ agent_id })` |
| Read the workspace's "rules of the road" markdown | `sc-mission-control__get_workspace_context({ agent_id })` |
| Fetch a task by id | `sc-mission-control__get_task({ agent_id, task_id })` |

`agent_id` is your **MC agent UUID**, not your gateway id. Every dispatch briefing's preamble names it literally — copy verbatim into every tool call. Your `MC-CONTEXT.json` (in your workspace dir) carries it durably as `my_agent_id`.

### Reporting work back

| Action | Tool |
|---|---|
| Register a deliverable (file, URL, artifact) | `register_deliverable({ agent_id, task_id, title, deliverable_type, path?, … })` |
| Log progress / completion (required by the evidence gate) | `log_activity({ agent_id, task_id, activity_type, message, metadata? })` |
| Move a task to its next workflow stage | `update_task_status({ agent_id, task_id, status, status_reason? })` |
| Fail a quality gate (tester/reviewer fail path) | `fail_task({ agent_id, task_id, reason })` |
| Save a checkpoint (resume hint) | `save_checkpoint({ agent_id, task_id, state_summary, … })` |
| Submit raw evidence (build/test/lint output) | `submit_evidence({ agent_id, task_id, gate, command, exit_code, stdout, stderr, … })` |
| Take a note (cheap observability) | `take_note({ agent_id, kind, body, scope_key, role, run_group_id, … })` |

### Reading prior context

| Action | Tool |
|---|---|
| Query notes by task / scope / audience | `read_notes({ agent_id, task_id?, audience?, … })` |
| Acknowledge a note from a prior stage | `mark_note_consumed({ agent_id, note_id, stage_slug })` |
| Recall lessons from the workspace knowledge base | `request_knowledge({ agent_id, query, task_id?, workspace_id? })` |
| Save a lesson (Learner role) | `save_knowledge({ agent_id, workspace_id, category, title, content, … })` |

### Peer-to-peer messaging (sparingly)

| Action | Tool |
|---|---|
| Mail another agent's mailbox | `send_mail({ agent_id, to_agent_id, body, subject?, task_id?, push? })` |
| Read your unread mail | `fetch_mail({ agent_id })` |

Mail is for cross-task coordination and questions to the PM. **Never** chat directly to a peer's session — your scope-keyed session has no path to theirs. MC's mailbox is the audit-friendly substrate.

### Coordinator-only delegation

If your *role* is `coordinator` (set in the dispatch briefing — most subagents are NOT coordinators), use:

| Action | Tool |
|---|---|
| Delegate a slice to a peer (creates a child task in the convoy) | `spawn_subtask({ agent_id, task_id, peer_gateway_id, slice, message, expected_deliverables, acceptance_criteria, expected_duration_minutes, … })` |
| Accept a delivered child slice | `accept_subtask({ agent_id, subtask_id })` |
| Reject a delivered child slice (loops back to peer) | `reject_subtask({ agent_id, subtask_id, reason, new_acceptance_criteria? })` |
| Cancel a stuck or out-of-scope slice | `cancel_subtask({ agent_id, subtask_id, reason })` |
| List my active subtasks ("who am I waiting on?") | `list_my_subtasks({ agent_id, task_id, states? })` |

Peer sub-delegation is rejected by authz — only the task's coordinator can `spawn_subtask`.

### PM-only roadmap writes

| Action | Tool |
|---|---|
| Propose roadmap changes (PM's primary write path) | `propose_changes({ agent_id, workspace_id, trigger_text, impact_md, changes, plan_suggestions, trigger_kind? })` |
| Refine a prior proposal | `refine_proposal({ agent_id, proposal_id, additional_constraint })` |
| Forward freeform notes to the PM for a proposal | `propose_from_notes({ agent_id, workspace_id, notes_text, scope_hint? })` |

PM proposals stay in `draft` until the operator clicks Accept; PMs never write directly to the roadmap (one exception: `add_owner_availability` for operator-stated facts).

## Core rules

1. **You are a spawned subagent unless your briefing says otherwise.** Don't try to send chat to peers' sessions — they don't have one you can reach.
2. **Don't `sessions_spawn` further.** Specialists that recurse into more subagents lose context and produce worse work. The PM is the only role that spawns; coordinator subagents delegate via `spawn_subtask` (which goes through MC, not openclaw native spawn).
3. **`agent_id` is per-call.** Every state-changing MCP tool takes `agent_id` first. Use the UUID from your dispatch briefing preamble — never your `gateway_agent_id`.
4. **Reply to whoever asked via MCP, not chat.** A delivered task transitions via `update_task_status`; a failed gate calls `fail_task`; a question to the PM goes through `send_mail`. The "reply" to your dispatcher is a state change MC observes.
5. **Never read MC's database.** `~/docker/mission-control/data/*.db`, `/app/data/*.db` — off-limits. Every value is reachable via the MCP tools above; if you can't find one, call `whoami` or `get_task`, never `sqlite3`.
6. **Notes are external memory.** See `notetaker.md` (also in your briefing). Use `take_note` aggressively — they're cheap.

## Receiving work

You'll arrive in one of two contexts:

**(a) Task dispatch.** Your briefing carries an identity preamble (`agent_id`, `gateway_agent_id`), a role section, the task body, prior notes, and a "what you should do" block. Treat it as authoritative: do the work in character as that role, then report back via the completion flow below.

**(b) PM coord (META envelope).** If you're the workspace PM, you may receive a `**MC subagent dispatch (workspace=… task=…)**` block telling you to call openclaw's native `sessions_spawn` with a verbatim worker briefing, then `register_subagent_dispatch` to correlate the runId. Follow the META block exactly — don't paraphrase.

## Task completion flow

Every MC-dispatched task ends with three tool calls, in this order:

1. `register_deliverable` — at least one (evidence gate enforced).
2. `log_activity` with `activity_type: "completed"` — at least one (evidence gate enforced).
3. `update_task_status` with the `status` value the dispatch briefing named in `next_status` — don't guess.

If `update_task_status` returns `evidence_gate` with `missing_deliverable_ids`, you didn't register enough — produce the missing ones and retry. Don't try to force the transition.

### On gate failure (tester / reviewer)

Skip step 3. Call `fail_task({ agent_id, task_id, reason })` with a specific, actionable reason. MC routes the task back to the previous stage with your reason attached.

## Help requests

If blocked, mail the workspace PM (`sc-mission-control__list_peers` to resolve their `agent_id`):

```js
sc-mission-control__send_mail({
  agent_id: "<your agent_id>",
  to_agent_id: "<PM's agent_id>",
  subject: "help_request: <task_id>",
  task_id: "<task_id>",
  body: "Blocked on <specifics>. Need: <what would unblock>.",
  push: true
})
```

The PM sees the mail on their next coord-session turn (or immediately with `push: true`).

## Discovering peers

Don't memorise gateway ids — peers are workspace-specific and the gateway id of a workspace's PM is `mc-pm-<slug>(-dev)`. Always:

```js
sc-mission-control__list_peers({ agent_id: "<your agent_id>" })
```

Returns the workspace's roster: `{ gateway_id, mc_agent_id, name, role }`. Cache for the duration of your session, not across sessions — the roster changes as operators add/remove agents.
