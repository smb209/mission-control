# MESSAGING-PROTOCOL.md — Inter-Agent Communication (Shared Across All Mission Control Agents)

Applies equally to the **Coordinator** and to every **specialist**. Load it on session start alongside `SOUL.md` / `AGENTS.md` / `SHARED-RULES.md`.

## The mesh, in one paragraph

Every Mission Control agent is a **persistent, named gateway agent** with its own pinned `SOUL.md`, `AGENTS.md`, `USER.md`, and memory. Agents talk to each other by sending messages to each other's long-lived sessions — not by spawning ephemeral sub-agents. The Coordinator delegates; specialists do the work in character; everyone replies to whoever asked them. Mission Control is the source of truth for task state and a backup delivery channel (mail).

## Call-home: use the `sc-mission-control` MCP tools

Your openclaw config wires an MCP server named **`sc-mission-control`** that exposes the full Mission Control surface as typed tools. **These tools are the only supported way to interact with Mission Control** — never reconstruct curl calls against `/api/tasks/*`, and never read the MC sqlite database.

**Tool names have a prefix.** OpenClaw namespaces MCP tools as `<server-name>__<tool-name>`, so the actual tool name you invoke is always `sc-mission-control__<tool>`. The table below shows the real names exactly as they appear in your tool list:

| Action | Tool name to call |
|---|---|
| Learn your own `agent_id` + peers + assigned tasks | `sc-mission-control__whoami({ agent_id })` |
| List peers in your workspace | `sc-mission-control__list_peers({ agent_id })` |
| Fetch a task by id | `sc-mission-control__get_task({ agent_id, task_id })` |
| Fetch your unread mail | `sc-mission-control__fetch_mail({ agent_id })` |
| Register a deliverable | `sc-mission-control__register_deliverable({ agent_id, task_id, title, deliverable_type, path?, description?, spec_deliverable_id? })` |
| Log progress or completion | `sc-mission-control__log_activity({ agent_id, task_id, activity_type, message, metadata? })` |
| Move a task to the next stage | `sc-mission-control__update_task_status({ agent_id, task_id, status, status_reason? })` |
| Fail a stage (tester / reviewer) | `sc-mission-control__fail_task({ agent_id, task_id, reason })` |
| Save a work-state checkpoint | `sc-mission-control__save_checkpoint({ agent_id, task_id, state_summary, … })` |
| Send mail to a peer | `sc-mission-control__send_mail({ agent_id, to_agent_id, body, subject?, task_id?, push? })` |
| Delegate a slice (coordinator only) | `sc-mission-control__delegate({ agent_id, task_id, peer_gateway_id, slice, message, timeout_seconds? })` |

**Every state-changing tool takes `agent_id` as its first argument.** `agent_id` is your **MC agent id** — a UUID or 32-char hex, not your gateway id (e.g. `mc-writer`). Each dispatch message embeds your `agent_id` and the task's `task_id` literally; copy them from there.

As a fallback, read your own workspace's context file:

```
~/.openclaw/workspaces/<your-gateway-id>/MC-CONTEXT.json
```

The file carries exactly two durable fields — `my_agent_id` and `my_gateway_id`. URL and authentication are handled by the MCP transport; you don't need them in the tool call.

### ⛔ Never read Mission Control's database

Mission Control's state lives in `~/docker/mission-control/data/mission-control.db` (host) and `/app/data/mission-control.db` (inside the MC container). **Do not `sqlite3`, `cat`, grep, or otherwise inspect that file.** Queries bypass every evidence gate, the schema changes frequently, and values drift immediately. Every piece of MC state you need is reachable via the `sc-mission-control__*` tools above — if you can't find a value, call `sc-mission-control__whoami` (for identity + peers + assigned tasks) or `sc-mission-control__get_task` (for task state), never the DB.

### When MCP is unavailable

If a tool call returns an authorization error, a 503 ("MCP endpoint is disabled"), or a connection error, Mission Control's kill switch is on or the launcher is down. Surface the failure and pause — do NOT fall back to curl. The HTTP routes enforce per-agent authorization you cannot satisfy from an agent shell, and the operator will need to unblock the transport before you can proceed.

## Core rules

1. **Always route to named peers.** The peer you want is almost certainly one of: `mc-coordinator`, `mc-researcher`, `mc-builder`, `mc-writer`, `mc-reviewer`, `mc-tester`, `mc-learner`. Send to that peer's existing **main** session.
2. **Never `sessions_spawn` a sub-agent for a role that already has a persistent peer.** Spawned sub-agents get a stripped context (no `SOUL.md`, no `IDENTITY.md`, no memory) — they don't know who they are, so they do worse work than the real specialist would.
3. **You may `sessions_spawn` only as a last resort**, when no persistent peer matches the work and it's a one-shot task you won't need identity or memory for.
4. **Do the work in character.** When you receive a message, you are the specialist. Don't recurse into sub-agents to "really do" the work.
5. **Reply to whoever asked.** Simple replies go back over chat; structured replies go through `sc-mission-control__send_mail` or the appropriate state-changing tool.
6. **Never inspect MC's database directly.** See the rule above.

## Delegating work (Coordinator → specialist)

Two ways, depending on whether the receiver needs to close a Mission Control task or is a peer-to-peer request:

### MC task delegation — use `sc-mission-control__delegate`

```
sc-mission-control__delegate({
  agent_id: "<coordinator's agent_id>",
  task_id: "<task_id>",
  peer_gateway_id: "mc-researcher",
  slice: "<one-line summary of what this peer owns>",
  message: "You are the Researcher for this task. <goal, context, success criteria>",
  timeout_seconds: 0   // fire-and-forget for parallel fan-out
})
```

`delegate` atomically invokes openclaw's `sessions.send` AND logs the audit activity. One tool call per peer; no separate `log_activity` call is needed. The tool enforces that the calling agent is the task's coordinator.

### Peer-to-peer — use openclaw's `sessions_send` directly

For work that isn't tied to a Mission Control task (ad-hoc coordination, off-task questions), use openclaw's `sessions_send` to `agent:<peer-gateway-id>:main`. This bypasses Mission Control entirely and leaves no audit trail — only use it for ephemeral discussion.

## Receiving work (specialist)

You receive a message in your main session when a peer sends to `agent:<you>:main`, usually as a chat-style message with a role-framing preamble ("You are the Writer for this task…") or as a `📬 MAIL from <sender>` banner.

When you receive such a message:

1. **Accept the role framing.** You are the Writer / Builder / Tester / etc. Behave accordingly.
2. **Do the work yourself.** Do not `sessions_spawn` a child to handle it. If you genuinely need another specialist, loop back to the Coordinator and ask.
3. **Reply.** Simple back-and-forth goes in chat. Structured replies go via `sc-mission-control__send_mail`.

## Task completion flow (Mission Control)

Every MC-dispatched task ends with three tool calls, in order:

1. **`sc-mission-control__register_deliverable`** — one call per deliverable (the evidence gate requires at least one).
2. **`sc-mission-control__log_activity`** with `activity_type: "completed"` — the evidence gate requires at least one activity.
3. **`sc-mission-control__update_task_status`** with the `status` value Mission Control gave you as `next_status` in the dispatch message.

If `update_task_status` returns `evidence_gate` with `missing_deliverable_ids`, you didn't register enough deliverables. Produce the missing ones and retry — do NOT try to force the transition.

### On task failure (Tester / Reviewer gate-fail path)

Instead of step 3, call `sc-mission-control__fail_task({ agent_id, task_id, reason })`. Mission Control routes the task back to the previous stage automatically.

## Help requests

If you're stuck and need clarification, mail the Coordinator rather than spinning:

```
sc-mission-control__send_mail({
  agent_id: "<your agent_id>",
  to_agent_id: "<coordinator's agent_id — resolve via sc-mission-control__list_peers>",
  subject: "help_request: <task_id>",
  task_id: "<task_id>",
  body: "Blocked on <specifics>. Need: <what would unblock>.",
  push: true
})
```

Coordinator sees the mail on their next dispatch context (or immediately with `push: true`).

## Peer roster

| Peer | Gateway id | Primary sessionKey |
|---|---|---|
| Coordinator | `mc-coordinator` | `agent:mc-coordinator:main` |
| Researcher | `mc-researcher` | `agent:mc-researcher:main` |
| Writer | `mc-writer` | `agent:mc-writer:main` |
| Builder | `mc-builder` | `agent:mc-builder:main` |
| Reviewer | `mc-reviewer` | `agent:mc-reviewer:main` |
| Tester | `mc-tester` | `agent:mc-tester:main` |
| Learner | `mc-learner` | `agent:mc-learner:main` |

Peer MC `agent_id`s are discoverable via `sc-mission-control__list_peers({ agent_id })` — use that instead of caching them.
