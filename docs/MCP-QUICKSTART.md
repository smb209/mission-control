# sc-mission-control MCP — Quickstart

End-to-end guide to getting the Mission Control MCP adapter wired into your openclaw install, from zero to agents calling tools.

**Target audience**: you're the operator who runs both openclaw and Mission Control on the same host (or MC in Docker, openclaw on the host). You have `MC_API_TOKEN` configured and the standard docker-compose stack working.

Stack layout:
```
 ┌───────────── host ─────────────┐    ┌───── Docker ─────┐
 │                                │    │                  │
 │  openclaw gateway              │    │  mission-control │
 │     │                          │    │     :4001        │
 │     ├─ spawns mc-writer, etc.  │    │                  │
 │     │                          │    │  /api/mcp ◄──────┼─ HTTP+bearer
 │     └─ spawns one shared       │    │                  │
 │        stdio subprocess:       │    └──────────────────┘
 │         mcp-launcher/          │
 │         launcher.mjs   ────────┼── HTTP (localhost:4001/mcp)
 │                                │
 └────────────────────────────────┘
```

One launcher subprocess proxies every agent's stdio JSON-RPC to MC's HTTP endpoint.

---

## 0. Pre-flight — before touching anything live

Run both test harnesses locally. No openclaw, no Docker. Both should pass in under 15 seconds:

```bash
# From the mission-control repo root:
yarn install
cd mcp-launcher && npm install && cd ..

yarn mcp:smoke         # launcher ⇄ mock MC (validates stdio↔HTTP proxy)
yarn mcp:integration   # real launcher ⇄ real MCP server ⇄ real sqlite
```

Expected output of `mcp:integration`:

```
[e2e] MCP server on http://127.0.0.1:XXXXX/mcp, sqlite at /tmp/mcp-e2e-NNNN.db
[launcher] sc-mission-control launcher starting, proxying to http://...
[launcher] ready; awaiting stdio requests
[e2e] OK — full flow validated (handshake → tools/list → whoami → evidence gate → register → log → transition → authz → send_mail → list_peers)
```

If either fails, **stop** — don't proceed to the wiring section until both are green. The rest of this guide assumes the transport and tool stack work.

---

## 1. Turn on MC's `/mcp` endpoint

The endpoint is gated by `MC_MCP_ENABLED`. In your `/Users/snappytwo/docker/docker-compose.yml` mission-control service, add to `environment:`:

```yaml
MC_MCP_ENABLED: "1"
```

Restart:

```bash
cd /Users/snappytwo/docker && docker compose up -d mission-control
```

Verify:

```bash
curl -sS -H "Authorization: Bearer $MC_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  http://localhost:4001/mcp | jq '.result.tools | length'
# → 11
```

If it returns `{"error": "MCP endpoint is disabled", ...}` the env var didn't take — check `docker inspect mission-control | grep MC_MCP_ENABLED`.

---

## 2. Register the launcher with openclaw

On the host (not in the container):

```bash
cd /Users/snappytwo/snappytwo-sandbox/mission-control/mcp-launcher
npm install    # one-time

openclaw mcp set sc-mission-control "$(cat <<EOF
{
  "command": "node",
  "args": ["$(pwd)/launcher.mjs"],
  "env": {
    "MC_URL": "http://localhost:4001/mcp",
    "MC_API_TOKEN": "$MC_API_TOKEN"
  }
}
EOF
)"
```

Confirm:

```bash
openclaw mcp list
openclaw mcp show sc-mission-control
```

---

## 3. Scope to one agent (mc-writer)

Edit `~/.openclaw/openclaw.json`. Find `mc-writer` in `agents.list` and add `sc-mission-control` to its `tools.alsoAllow`:

```jsonc
{
  "id": "mc-writer",
  "name": "Writer",
  // ... existing fields ...
  "tools": {
    "profile": "coding",
    "alsoAllow": ["sc-mission-control"]
  }
}
```

> Phase 0 note: OpenClaw's per-agent allowlist is informational — the spike showed a non-allow-listed agent could still call the tool. **Authorization is enforced on MC's side** (every state-changing tool calls `assertAgentCanActOnTask`). The `alsoAllow` entry still matters for documentation and for future openclaw releases that may start honoring it.

Restart the gateway:

```bash
openclaw gateway restart
```

---

## 4. Smoke-test with a live agent

Open a chat with **mc-writer** and try these prompts in order:

### 4.1 — Is the server visible?

> list your available tools

Expect to see `whoami`, `list_peers`, `get_task`, `register_deliverable`, `log_activity`, `update_task_status`, `fail_task`, `save_checkpoint`, `fetch_mail`, `send_mail`, `delegate` in the response.

If the tools are missing:
- `openclaw gateway logs` → check for plugin-load errors mentioning `sc-mission-control`
- `tail -f mcp-launcher/*.log` doesn't exist — the launcher writes to stderr which openclaw captures; check the gateway logs.

### 4.2 — Can the agent self-identify?

> call whoami with your agent_id

If the agent doesn't know its own ID yet, prompt it to read `~/.openclaw/workspaces/mc-writer/MC-CONTEXT.json` — the `my_agent_id` field is the only thing that file carries post-PR 6.

Expected response shape:
```json
{
  "id": "<agent uuid>",
  "name": "Writer",
  "role": "writer",
  "gateway_agent_id": "mc-writer",
  "workspace_id": "default",
  "assigned_task_ids": [],
  "peers": { "mc-coordinator": {...}, "mc-builder": {...}, ... }
}
```

### 4.3 — Full completion flow (dispatch a real task)

From the Mission Control UI or CLI, dispatch a small task to `mc-writer`. Expected sequence in the debug-events export:

1. `chat.send` (MC → gateway, with MCP-oriented completion instructions embedded)
2. `mcp.tool_call name=register_deliverable` (agent → MC)
3. `mcp.tool_call name=log_activity`
4. `mcp.tool_call name=update_task_status` with `status=review`
5. Task visible in the **review** column on the board

The debug export also shows the `ok=true` / `duration_ms=N` on each tool-call row. Zero HTTP calls to `/api/tasks/*` from this agent is the success signal.

---

## 5. Expand to all agents

Once mc-writer has completed two back-to-back tasks cleanly:

Add `sc-mission-control` to `alsoAllow` for each of the other `mc-*` agents in `openclaw.json`, OR merge **PR 5** which flips `MC_MCP_PILOT_AGENTS` default from "explicit allowlist" to "all gateway agents". After PR 5, no agent-list maintenance is needed — every dispatch to a gateway agent uses the MCP path.

Restart openclaw after each config change:
```bash
openclaw gateway restart
```

---

## 6. Troubleshooting

### Tool calls fail with `MCP endpoint is disabled` (HTTP 503)

`MC_MCP_ENABLED` is not `1` on the MC container. Set it and restart. This is the kill switch — leave it off if you need to disable MCP in a hurry.

### Tool calls fail with `Unauthorized`

The launcher's `MC_API_TOKEN` env is wrong. Check `openclaw mcp show sc-mission-control` vs the one in docker-compose. The bearer has to match exactly.

### Tool call succeeds but the task doesn't transition

Look at the response's `structuredContent`:
- `"error": "evidence_gate"` → no deliverable or no activity logged yet. The agent should call `register_deliverable` + `log_activity` before `update_task_status`.
- `"error": "authz_denied"` → the calling agent isn't on the task. Check `task_roles` and `tasks.assigned_agent_id` in sqlite, or have the agent call `whoami` to see its `assigned_task_ids`.
- `"error": "terminal_blocked"` → task is cancelled. Use admin release-stall.
- `"error": "cannot_mark_done"` → `status_reason` indicates a prior failure that needs clearing first.

### Agents are reading the DB directly

Check `agent.event` rows in the debug export for `sqlite3` or `cat ~/docker/...` commands. If present:
1. The agent's `SHARED-RULES.md` / `MESSAGING-PROTOCOL.md` may not have been reloaded — verify the shared files in `~/.openclaw/workspaces/` have the MCP-only content (no curl sections).
2. The agent's session may be using a stale context from before the rollout — start a fresh chat.

### The launcher won't start

Check openclaw gateway logs. Common causes:
- `MC_URL env var is required` — the env block in `openclaw mcp set` wasn't saved properly. Re-run step 2.
- `Failed to connect to MC at ...` — MC isn't reachable from the host. Test `curl http://localhost:4001/api/health` from a host terminal.
- `Cannot find module '@modelcontextprotocol/sdk'` — you didn't run `npm install` in `mcp-launcher/`.

### Stall detector flags a task as "idle with no deliverables"

After PR 6 the stall detector no longer has a "unverified delegation" branch — it just flags idle tasks with no deliverables. If a delegation never produced peer activity, the coordinator will see a bare idle flag. That's correct: MCP makes the `delegate` tool server-authoritative (no hallucinated calls possible), so the only remaining cause of a silent stall is a dead peer session, which the operator inspects on the gateway side.

---

## 7. Rollback

If something breaks in production:

```bash
# Instant kill switch — no openclaw restart needed
docker exec mission-control /bin/sh -c 'unset MC_MCP_ENABLED'  # (or set to 0)
docker compose restart mission-control
```

`/api/mcp` immediately starts returning 503 and every tool call fails cleanly. Agents surface the failure.

To remove entirely:

```bash
openclaw mcp unset sc-mission-control
openclaw gateway restart
# edit openclaw.json to remove the alsoAllow entries
```

---

## 8. What lives where (quick reference)

| File | Purpose |
|---|---|
| `src/app/api/mcp/route.ts` | HTTP entry for `/mcp` (stateless per-request `McpServer`) |
| `src/lib/mcp/server.ts` | Builds the server, registers tools |
| `src/lib/mcp/tools.ts` | All 11 tool definitions + handlers |
| `src/lib/mcp/errors.ts` | Maps `AuthzError` → tool-error result |
| `src/lib/mcp/debug.ts` | `mcp.tool_call` debug-log rows |
| `src/lib/authz/agent-task.ts` | `assertAgentCanActOnTask` — every state change passes through |
| `src/lib/services/*.ts` | Business logic shared by HTTP routes and MCP tools |
| `mcp-launcher/launcher.mjs` | stdio↔HTTP proxy spawned by openclaw |
| `mcp-launcher/smoke.mjs` | Proxy smoke (no MC) |
| `scripts/mcp-integration-test.mjs` | End-to-end (real server + real launcher + real sqlite) |
| `src/lib/openclaw/worker-context.ts` | Writes MC-CONTEXT.json (just `my_agent_id` now) |

## 9. Reference: all 11 tools

| Tool | Args | Use |
|---|---|---|
| `whoami` | `agent_id` | Start-of-session identity + peers |
| `list_peers` | `agent_id` | Peer roster in this workspace |
| `get_task` | `agent_id, task_id` | Read a task row |
| `fetch_mail` | `agent_id` | Unread mail |
| `register_deliverable` | `agent_id, task_id, title, deliverable_type[, path, description, spec_deliverable_id]` | Record output |
| `log_activity` | `agent_id, task_id, activity_type, message[, metadata]` | Progress note |
| `update_task_status` | `agent_id, task_id, status[, status_reason]` | Stage transition |
| `fail_task` | `agent_id, task_id, reason` | Fail-loopback (tester/reviewer) |
| `save_checkpoint` | `agent_id, task_id, state_summary[, …]` | Checkpoint snapshot |
| `send_mail` | `agent_id, to_agent_id, body[, subject, task_id, …]` | Inter-agent mail |
| `delegate` | `coordinator_agent_id, task_id, peer_gateway_id, slice, message[, timeout_seconds]` | Coordinator-only; atomic send+audit |
