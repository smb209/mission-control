# 00 — Baseline observations

Snapshot taken before PR 1 lands. Re-snapshot after the stack lands and diff for unexpected drift.

## MCP surface (current)

- **Total tools:** 47
- **Endpoints:** one — `/api/mcp` (`src/app/api/mcp/route.ts`). Both PM and runner-host mount it.
- **`tools.ts` count:** 24 — `whoami`, `get_workspace_context`, `list_peers`, `get_task`, `fetch_mail`, `register_deliverable`, `submit_evidence`, `log_activity`, `take_note`, `read_notes`, `mark_note_consumed`, `archive_note`, `update_task_status`, `fail_task`, `save_checkpoint`, `send_mail`, `save_knowledge`, `request_knowledge`, `spawn_subtask`, `list_my_subtasks`, `accept_subtask`, `reject_subtask`, `cancel_subtask`, `register_subagent_dispatch`.
- **`roadmap-tools.ts` count:** 23 — `list_initiatives`, `get_initiative`, `get_initiative_tree`, `get_roadmap_snapshot`, `get_initiative_history`, `get_task_initiative_history`, `list_owner_availability`, `get_velocity_data`, `list_proposals`, `create_initiative`, `update_initiative`, `move_initiative`, `convert_initiative`, `add_initiative_dependency`, `remove_initiative_dependency`, `move_task_to_initiative`, `promote_initiative_to_task`, `promote_task_to_inbox`, `add_owner_availability`, `propose_changes`, `propose_from_notes`, `refine_proposal`, `preview_derivation`.

## Agent template state

- `agent-templates/_shared/messaging-protocol.md` — canonical tool table, references all 47 by name including: `accept_subtask`, `reject_subtask`, `cancel_subtask` (PR 4 targets), `archive_note` (PR 5 target). `mark_note_consumed` is **not** referenced.
- `agent-templates/_shared/notetaker.md` — references `archive_note` (line ~34) only.
- `agent-templates/coordinator/{SOUL,AGENTS}.md` — densest subtask-tool decision table.
- `agent-templates/pm/SOUL.md` — line ~32 explicitly forbids `create_initiative`/`update_initiative` (becomes redundant after PR 2).

## Named gateway agents

Two physical workspace dirs each per environment:
- Dev: `~/.openclaw/workspaces/mc-pm-default-dev/`, `~/.openclaw/workspaces/mc-runner-dev/`
- Stable: `~/.openclaw/workspaces/mc-pm-default-stable/`, `~/.openclaw/workspaces/mc-runner-stable/`

Each contains `AGENTS.md` / `SOUL.md` / `IDENTITY.md` read at gateway session start. Currently hand-synced.

## openclaw.json relevant sections

- `mcp.servers.<name>` — per-MC-route MCP server registration.
- `agents[].tools.alsoAllow` / `deny` — per-named-agent allowlist patterns. Today: typically `"sc-mission-control-dev__*"` for dev runner.

## Test suite state

- `yarn test` — full Node/TS suite. Run before branch-cut to record any pre-existing failures.
- `yarn mcp:smoke` — MCP smoke against the launcher.
- `yarn mcp:integration` — MCP integration script.

Pre-existing failures (to fill at branch-cut):
- _TBD — capture during pre-check on each milestone run._

## Capture location

`/tmp/mc-validation/mcp-surface-v2/baseline/` — for the `tools/list` snapshot taken at pre-check time.
