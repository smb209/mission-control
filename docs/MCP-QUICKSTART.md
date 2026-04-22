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

Three harnesses, cheapest first:

```bash
# From the mission-control repo root:
yarn install
cd mcp-launcher && npm install && cd ..

yarn mcp:smoke         # ~5s — launcher ⇄ mock MC  (stdio↔HTTP proxy only)
yarn mcp:integration   # ~10s — real MCP server mounted on node:http ⇄ real launcher ⇄ sqlite
yarn mcp:e2e:next      # ~10s — real Next.js dev server ⇄ real /api/mcp route ⇄ sqlite
```

The three layers catch disjoint bug classes — `mcp:e2e:next` is the one that would have caught the `WebStandardStreamableHTTPServerTransport` regression and the `Accept: application/json, text/event-stream` requirement before hitting production. Run all three before any rollout.

> `mcp:e2e:next` spawns `next dev` and writes to `.next/`. Don't run it while `yarn dev` is running on the default port — they'll clobber each other's compilation cache.

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
# Use YOUR MC_API_TOKEN — never the example below.
MC_API_TOKEN="<paste your token>"

# The MCP Streamable-HTTP spec requires Accept: application/json + text/event-stream
# on every POST, even though our server runs with enableJsonResponse=true
# (returns plain JSON, not SSE frames). Omitting text/event-stream gets 406.
curl -sS \
  -H "Authorization: Bearer $MC_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  http://localhost:4001/api/mcp | jq '.result.tools | map(.name)'
# [
#   "whoami", "list_peers", "get_task", "fetch_mail",
#   "register_deliverable", "log_activity", "update_task_status",
#   "fail_task", "save_checkpoint", "send_mail", "delegate",
#   "save_knowledge"
# ]
```

Common error responses:

| Response | Cause | Fix |
|---|---|---|
| `{"error":"MCP endpoint is disabled"}` status 503 | `MC_MCP_ENABLED` isn't `1` | Check `docker inspect mission-control \| grep MC_MCP_ENABLED`; restart after setting |
| `Not Acceptable: Client must accept both application/json and text/event-stream` status 406 | Missing `Accept` header | Add `-H "Accept: application/json, text/event-stream"` |
| 404 HTML page | Hit `/mcp` instead of `/api/mcp` | Use the full path |
| `{"error":"Unauthorized"}` status 401 | Wrong `MC_API_TOKEN` | Match the value from `docker-compose.yml` |

### One-shot whoami for a gateway agent

Once the endpoint responds, confirm authz + the DB layer are reachable:

```bash
MC_API_TOKEN="<paste your token>"
WRITER_ID=$(sqlite3 ~/docker/mission-control/data/mission-control.db \
  "SELECT id FROM agents WHERE gateway_agent_id='mc-writer' LIMIT 1")

curl -sS \
  -H "Authorization: Bearer $MC_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"whoami\",\"arguments\":{\"agent_id\":\"$WRITER_ID\"}}}" \
  http://localhost:4001/api/mcp | jq '.result.structuredContent | {id, name, gateway_agent_id, peer_count: (.peers | length)}'
# {
#   "id": "…",
#   "name": "Writer",
#   "gateway_agent_id": "mc-writer",
#   "peer_count": 7
# }
```

> This is the ONLY place this guide tells you to read the database directly — for a one-time setup sanity check. After this step, agents use `whoami` itself to discover their id. Agents must not read the DB; see `MESSAGING-PROTOCOL.md`.

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

Edit `~/.openclaw/openclaw.json`. Find `mc-writer` in `agents.list` and add the MCP tool names to its `tools.alsoAllow`:

```jsonc
{
  "id": "mc-writer",
  "name": "Writer",
  // ... existing fields ...
  "tools": {
    "profile": "coding",
    "alsoAllow": [
      "sc-mission-control__whoami",
      "sc-mission-control__list_peers",
      "sc-mission-control__get_task",
      "sc-mission-control__fetch_mail",
      "sc-mission-control__register_deliverable",
      "sc-mission-control__log_activity",
      "sc-mission-control__update_task_status",
      "sc-mission-control__fail_task",
      "sc-mission-control__save_checkpoint",
      "sc-mission-control__send_mail",
      "sc-mission-control__delegate",
      "sc-mission-control__save_knowledge"
    ]
  }
}
```

> **Use the full tool names, not the bare server name.** OpenClaw exposes MCP tools as `<server-name>__<tool-name>` and matches `alsoAllow` entries against those full names. The bare string `"sc-mission-control"` produces a startup warning and doesn't match any tool. If you want fewer tools per agent, list the specific ones (e.g. a read-only agent might only get `__whoami`, `__list_peers`, `__get_task`, `__fetch_mail`).
>
> **Phase 0 note**: this allowlist is informational — the Phase 0 spike showed a non-allow-listed agent can still call the tool, and MC enforces authz server-side (`assertAgentCanActOnTask` inside every state-changing tool). The list still matters for documentation and for future openclaw releases that may start honoring it as a gate.

Restart the gateway:

```bash
openclaw gateway restart
```

---

## 4. Smoke-test with a live agent

Open a chat with **mc-writer** and try these prompts in order:

### 4.1 — Is the server visible?

From a terminal:

```bash
openclaw agent --agent mc-writer \
  --message "List the sc-mission-control tool names you have access to, one per line." \
  --timeout 45
```

Expect 12 names, all prefixed with `sc-mission-control__`:

```
sc-mission-control__whoami
sc-mission-control__list_peers
sc-mission-control__get_task
sc-mission-control__fetch_mail
sc-mission-control__register_deliverable
sc-mission-control__log_activity
sc-mission-control__update_task_status
sc-mission-control__fail_task
sc-mission-control__save_checkpoint
sc-mission-control__send_mail
sc-mission-control__delegate
sc-mission-control__save_knowledge
```

If the tools are missing, the launcher almost certainly failed to connect upstream. The launcher's own `diagnose()` helper (see `mcp-launcher/launcher.mjs`) emits a targeted hint to stderr that openclaw captures in the gateway log. Tail it and look for `[launcher]` lines:

```bash
tail -f /tmp/openclaw/openclaw-$(date -u +%Y-%m-%d).log | grep launcher
```

Common messages and their fixes:

| Launcher hint | Cause | Fix |
|---|---|---|
| "Response was HTML (likely a Next.js 404). Your MC_URL path is X but sc-mission-control mounts at /api/mcp" | Stale `openclaw mcp set` pointing at the pre-PR-7 path | Re-run step 2 above with `MC_URL=.../api/mcp` |
| "MC returned 503 — MC_MCP_ENABLED isn't set" | Step 1 didn't take | Re-check `docker inspect mission-control \| grep MC_MCP_ENABLED` |
| "MC returned 401 — MC_API_TOKEN mismatch" | Wrong bearer in the openclaw config | Copy token from `docker inspect`, re-run step 2 |
| "Connection refused to http://localhost:4001" | MC isn't running | `docker compose up -d mission-control` |

### 4.2 — Can the agent self-identify?

```bash
MC_API_TOKEN="<paste your token>"
WRITER_ID=$(sqlite3 ~/docker/mission-control/data/mission-control.db \
  "SELECT id FROM agents WHERE gateway_agent_id='mc-writer' LIMIT 1")

openclaw agent --agent mc-writer \
  --message "Call sc-mission-control__whoami with agent_id=\"$WRITER_ID\". Report name, gateway_id, and peer_count." \
  --timeout 60
```

If the agent doesn't know its own ID in its own prompt flow, it can read `~/.openclaw/workspaces/mc-writer/MC-CONTEXT.json` — the `my_agent_id` field is the only thing that file carries post-PR 6.

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

### 4.4 — Check the dashboard

Open **[http://localhost:4001/debug/mcp](http://localhost:4001/debug/mcp)** — the purpose-built MCP dashboard added in PR 9. You'll see:

- Endpoint status + tool count (should be 12)
- Calls last hour / last day / lifetime + error counts (tone-coded: red when there are errors)
- Per-tool table with call volumes, average / max latency, last-called
- Per-agent breakdown
- Live feed of every `mcp.tool_call` event as it happens

If **Endpoint = Disabled**, step 1 didn't stick. If **Tools = 0**, the MC build is stale (rebuild the container). If **per-tool table is empty but you've run tool calls**, debug collection is off — click through to `/debug` and toggle it on.

---

## 5. Expand to all agents

Once mc-writer has completed two back-to-back tasks cleanly:

Copy the same 12-entry `alsoAllow` block (from step 3) into each of the other `mc-*` agents in `openclaw.json`, OR merge **PR 5** which flips `MC_MCP_PILOT_AGENTS` default from "explicit allowlist" to "all gateway agents". After PR 5, no agent-list maintenance is needed — every dispatch to a gateway agent uses the MCP path.

A one-liner to fan out the same allowlist to every `mc-*` agent (after editing one agent by hand):

```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home() / '.openclaw' / 'openclaw.json'
TOOLS = [f'sc-mission-control__{t}' for t in
    ['whoami','list_peers','get_task','fetch_mail',
     'register_deliverable','log_activity','update_task_status',
     'fail_task','save_checkpoint','send_mail','delegate',
     'save_knowledge']]
c = json.loads(p.read_text())
for a in c.get('agents', {}).get('list', []):
    if not a.get('id','').startswith('mc-'): continue
    tools = a.setdefault('tools', {}).setdefault('alsoAllow', [])
    for t in TOOLS:
        if t not in tools: tools.append(t)
p.write_text(json.dumps(c, indent=2) + '\n')
print('done')
PY
openclaw gateway restart
```

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
| `src/lib/mcp/tools.ts` | All 12 tool definitions + handlers |
| `src/lib/mcp/errors.ts` | Maps `AuthzError` → tool-error result |
| `src/lib/mcp/debug.ts` | `mcp.tool_call` debug-log rows |
| `src/lib/authz/agent-task.ts` | `assertAgentCanActOnTask` — every state change passes through |
| `src/lib/services/*.ts` | Business logic shared by HTTP routes and MCP tools |
| `mcp-launcher/launcher.mjs` | stdio↔HTTP proxy spawned by openclaw |
| `mcp-launcher/smoke.mjs` | Proxy-only smoke (no MC, no DB) |
| `scripts/mcp-integration-test.mjs` | Service-layer E2E (node:http + real launcher + real sqlite) |
| `scripts/mcp-next-e2e.mjs` | Next.js E2E (real `next dev` + real `/api/mcp` + real sqlite) |
| `scripts/mcp-next-e2e.seed.ts` | Sibling seeder for the Next.js E2E |
| `src/lib/openclaw/worker-context.ts` | Writes MC-CONTEXT.json (just `my_agent_id` now) |

## 9. Reference: all 12 tools

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
| `save_knowledge` | `agent_id, workspace_id, category, title, content[, task_id, tags, confidence]` | Learner writes a lesson to the workspace knowledge base |
