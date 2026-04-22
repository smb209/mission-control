# sc-mission-control MCP launcher

Stdio ↔ HTTP proxy. OpenClaw spawns this process; it forwards every JSON-RPC message to Mission Control's `/mcp` endpoint over HTTP, carrying the MC bearer token.

## Setup

```bash
cd mcp-launcher && npm install
```

## Register with openclaw

One-time, via the openclaw CLI:

```bash
openclaw mcp set sc-mission-control "$(cat <<'EOF'
{
  "command": "node",
  "args": ["/Users/you/snappytwo-sandbox/mission-control/mcp-launcher/launcher.mjs"],
  "env": {
    "MC_URL": "http://localhost:4001/mcp",
    "MC_API_TOKEN": "<paste your MC_API_TOKEN here>"
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

Then scope the server to one or more agents via their `tools.alsoAllow` in `~/.openclaw/openclaw.json` (the Phase 0 spike showed openclaw's allowlist is informational but we still configure it).

## Environment

| Var | Required | Default | Notes |
|---|---|---|---|
| `MC_URL` | yes | — | MC's `/mcp` endpoint. e.g. `http://localhost:4001/mcp`. |
| `MC_API_TOKEN` | yes | — | Same bearer as the HTTP API. |

Missing either → the launcher exits non-zero at startup and openclaw logs the error.

## Feature flag

Mission Control's `/mcp` endpoint returns **503** when `MC_MCP_ENABLED` isn't `1`. Set that in MC's environment (docker-compose.yml → `environment:`) to turn the endpoint on. The launcher will surface the 503 as a tool-call failure.

## Rollout sequence

1. Flip `MC_MCP_ENABLED=1` in MC, restart the container.
2. Run the `openclaw mcp set` above on the host. Restart openclaw gateway.
3. Add `sc-mission-control` to **one** agent's allowlist (e.g. mc-writer). Restart openclaw.
4. Start a chat with that agent; prompt "list your available tools" — expect `whoami`, `list_peers`, `register_deliverable`, etc.
5. Dispatch a real task. Watch MC's debug-events export for `mcp.tool_call` rows.
6. Expand to other agents.

## Smoke test (no openclaw needed)

```bash
npm run smoke
```

Runs a hand-crafted `initialize` + `tools/list` against the launcher's stdio transport, mocking MC with a local HTTP listener. Exits non-zero on any handshake error.
