# 02 — Test plan

Six scenarios. Each ~5 min real-agent time. Capture per-scenario at `/tmp/mc-validation/mcp-surface-v2/<id>/`.

All real-agent dispatches use `spark-lb/agent` per `project_openclaw_model.md`.

## V1 — PM endpoint surfaces only PM-relevant tools

**Tests:** PR 1 (refactor), PR 2 (route).

**Setup:** Dev server up. PM gateway points at `/api/mcp/pm` (PR 3 applied).

**Action:**
```sh
curl ... -X POST http://localhost:4010/api/mcp/pm \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  > /tmp/mc-validation/mcp-surface-v2/V1/tools-list.json
```

**Observation:**
- Tool count ~16 (core 5 + read 9 + pm 4 = 18, ±1 depending on final group split).
- `register_deliverable`, `submit_evidence`, `update_task_status`, `fail_task`, `spawn_subtask`, `update_subtask`, `register_subagent_dispatch` **absent**.
- `propose_changes`, `propose_from_notes`, `refine_proposal`, `preview_derivation`, `add_owner_availability` **present**.
- `whoami`, `list_peers`, `get_workspace_context`, `list_initiatives`, `get_initiative_tree`, `get_roadmap_snapshot` **present**.

## V2 — Default endpoint preserves runner surface

**Tests:** PR 1 (refactor) regression check.

**Setup:** Same.

**Action:**
```sh
curl ... -X POST http://localhost:4010/api/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  > /tmp/mc-validation/mcp-surface-v2/V2/tools-list.json
```

**Observation:**
- Tool count = 44 post-PR5 (47 baseline − 3 subtask ± 1 update_subtask − 2 note ± 1 update_note = 47 − 3 + 1 − 2 + 1 = 44).
- `update_subtask`, `update_note` present.
- `accept_subtask`, `reject_subtask`, `cancel_subtask`, `mark_note_consumed`, `archive_note` absent.

## V3 — `_shared` edit propagates to named agents via sync script

**Tests:** PR 3.5.

**Setup:** Stack landed through PR 3.5. Dev workspace dirs at `~/.openclaw/workspaces/mc-{pm-default,runner}-dev/` exist.

**Action:**
1. Snapshot `~/.openclaw/workspaces/mc-pm-default-dev/AGENTS.md` → `before.md`.
2. Append a one-line marker to `agent-templates/_shared/messaging-protocol.md`: `<!-- v3-validation-marker -->`.
3. `yarn openclaw:sync-named-agents --dry-run` → expect a non-empty diff for both `mc-pm-default-dev` and `mc-runner-dev`.
4. `yarn openclaw:sync-named-agents` → file rewritten.
5. Snapshot `AGENTS.md` again → `after.md`. Diff must include the marker.
6. `yarn openclaw:sync-named-agents --dry-run` again → empty diff (idempotent).
7. Revert the `_shared` edit; re-run sync; verify roundtrip.

**Observation:** capture all four files (`before.md`, `after.md`, two dry-run logs, post-revert) under `V3/`.

## V4 — Coordinator dispatch uses `update_subtask`

**Tests:** PR 4.

**Setup:** Seed a parent task with a coordinator role + at least one spawned subtask. Use existing seed flow or `yarn db:seed` plus a hand-issued `spawn_subtask` via curl.

**Action:** Dispatch the coordinator against the parent task. Capture transcript.

**Observation:**
- Coordinator briefing references `update_subtask`, not the old verbs.
- At least one tool call to `update_subtask({action: "accept" | "reject" | "cancel"})` lands.
- Subtask status transitions correctly in `tasks` table.

**Capture:** transcript (`transcript.txt`), SSE events (`sse.log`), final DB row state (`subtask-row.json`).

## V5 — Worker dispatch consumes/archives a note

**Tests:** PR 5.

**Setup:** Seed a worker task with at least one inbound note (`audience='builder'` or similar). PM-style note recipient flow.

**Action:** Dispatch the worker. Capture transcript.

**Observation:**
- Worker briefing references `update_note` for both consume and archive paths.
- At least one tool call to `update_note({action: "consume", stage_slug: ...})` lands.
- Note `consumed_at` (or equivalent) is set in DB.

**Capture:** as V4.

## V6 — PM `propose_changes` flow unaffected by route split

**Tests:** PR 2 regression check.

**Setup:** PM points at `/api/mcp/pm`. Operator dispatches a small prompt that should produce a proposal (e.g. "Set initiative X to in_progress").

**Action:** Send PM chat via UI. Capture chat events.

**Observation:**
- `propose_changes` tool call lands successfully.
- Proposal card appears in PM chat.
- `proposals` table has a new row.
- No 404 / 500 from `/api/mcp/pm`.

**Capture:** chat-events log (`chat-events.log`), proposal row (`proposal.json`), screenshot.

## Time budget

| Scenario | Expected real-agent minutes | Retries permitted |
|---|---|---|
| V1 | 0 (curl only) | n/a |
| V2 | 0 (curl only) | n/a |
| V3 | 0 (script only) | n/a |
| V4 | ~5 | 2 (FLAKE policy: pass if 2/3) |
| V5 | ~5 | 2 |
| V6 | ~5 | 2 |

Total worst-case real-agent dispatches: 9.
