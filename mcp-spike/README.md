# mcp-spike — Phase 0 de-risking for the sc-mission-control MCP adapter

Throwaway. Delete the whole folder once Phase 0 is done and the decisions are made.

## What we already learned (from CLI + schema, before running the spike)

1. **MCP in openclaw 2026.4.10 lives under top-level `mcp.servers.<name>`** — not in a `plugins.entries.mcp-adapter` block. That earlier lead was from a personal fork. The CLI is `openclaw mcp set|show|list|unset`.
2. **`${OPENCLAW_AGENT_ID}` in config is shell-env interpolation at load time**, not a per-agent runtime placeholder. The HTTP + interpolated-header design is dead. Any single MCP config is shared across all agents at config time.
3. **Per-agent MCP scoping does exist** — each `agents.list[<i>].tools` has the same `allow`/`alsoAllow`/`deny`/`byProvider` shape as the global `tools` block. So you can scope an MCP server to one agent via that agent's `tools.alsoAllow`. But the schema does not prescribe the **string format** for MCP tool entries — that's one of the things we need to discover.
4. **There are two MCP config surfaces in this build:**
   - `$.mcp.servers` (top-level, a catalog)
   - `$.plugins.entries.acpx.config.mcpServers` plus `pluginToolsMcpBridge: boolean` — the ACPX runtime plugin, which is loaded by default. That bridge flag is almost certainly how top-level servers get surfaced to agent sessions.

## What this spike answers (three probes, one run)

| # | Question | How we observe |
|---|---|---|
| 1 | **Identity passing** — how (if at all) does openclaw tell the MCP server which agent is calling? | Server logs `process.env`, `argv`, `cwd`, the `initialize.clientInfo`, and every tool-call's `extra` — everything that crosses the stdio boundary. |
| 2 | **Subprocess model** — one stdio subprocess per agent, or one shared? | Allow-list two agents; invoke `whoami` from each; compare `pid` in the responses. Same pid → shared; different pids → per-agent. |
| 3 | **Allowlist string format** — what string in `agents.list[<i>].tools.alsoAllow` makes the MCP tool visible to that agent (and no others)? | Try candidate strings, restart, check whether `whoami` appears in the tool list. |

Secondary question we can answer along the way: does registering via top-level `mcp.servers` suffice, or do we also need `plugins.entries.acpx.config.pluginToolsMcpBridge: true`?

## Setup

### 1. Install

```bash
cd mcp-spike && npm install
```

### 2. Clean up the stale config block

Your openclaw is still warning about `plugins.entries.mcp-adapter`. Remove it:

```bash
# Hand-edit ~/.openclaw/openclaw.json and delete the entire
# plugins.entries.mcp-adapter block. Then:
openclaw config validate
```

### 3. Register the spike via the top-level `mcp.servers` path

```bash
openclaw mcp set spike-echo '{
  "command": "node",
  "args": ["/Users/snappytwo/snappytwo-sandbox/mission-control/mcp-spike/server.mjs"],
  "env": { "SPIKE_MARKER": "from-static-config" }
}'
openclaw mcp list          # confirm it's there
```

### 4. Scope it to mc-writer first (Probe 3 starts here)

We don't know the correct allowlist string. Start with the simplest guess, then iterate. Edit `~/.openclaw/openclaw.json`, find mc-writer's entry in `agents.list`, and add an `alsoAllow`:

```jsonc
// candidate A — bare server name
{ "id": "mc-writer", "tools": { "alsoAllow": ["spike-echo"] } }

// candidate B — namespaced tool
{ "id": "mc-writer", "tools": { "alsoAllow": ["spike-echo.whoami"] } }

// candidate C — wildcard under the server
{ "id": "mc-writer", "tools": { "alsoAllow": ["spike-echo:*"] } }

// candidate D — explicit mcp prefix
{ "id": "mc-writer", "tools": { "alsoAllow": ["mcp:spike-echo:*"] } }
```

Start with **A**. Save, then `openclaw gateway restart`.

### 5. Trigger from mc-writer

Open a chat with mc-writer. Prompt:

1. "list your available tools" — look for `whoami` / `spike-echo.whoami` / however openclaw labels it. **If it is not listed, Probe 3 says candidate A doesn't work** — try B, C, D in order, restarting between each. Record which one worked; that's the string format for the real `sc-mission-control` allowlist entries later.
2. Once the tool is listed, prompt: "call the whoami tool". Watch the log file.

### 6. Add a second agent (Probe 2)

Once mc-writer works, also allow-list mc-builder with the same string that worked. Restart. From mc-builder, prompt "call the whoami tool". Compare the `pid` in the two responses.

### 7. (Contingency) ACPX bridge path

If step 5 never surfaces the tool with any candidate string, the top-level `mcp.servers` path isn't being bridged into agent sessions. Enable the bridge:

```bash
# Edit ~/.openclaw/openclaw.json, add under plugins.entries.acpx.config:
#   "pluginToolsMcpBridge": true
openclaw gateway restart
```

Repeat step 5. If still nothing, register the server directly under `plugins.entries.acpx.config.mcpServers.spike-echo` with the same `{command, args, env}` object instead of the top-level `mcp.servers`.

## Observe

**Log file** — path printed to stderr at process start. macOS: `$TMPDIR/mcp-spike.log`; Linux: `/tmp/mcp-spike.log`.

```bash
tail -f "$(ls -t $TMPDIR/mcp-spike.log /tmp/mcp-spike.log 2>/dev/null | head -1)" | jq .
```

Key events:

- `process_start` — dumps `argv`, `cwd`, `pid`, `ppid`, and every openclaw/agent/mcp/mission/claw/gateway-matching env var. **Probe 1 result.**
- `initialized` — `clientInfo` and `clientCapabilities` from the MCP handshake. Secondary data for Probe 1.
- `tool_call_whoami` — `extra` keys + a JSON dump of the inbound request context. Tertiary data for Probe 1.

**Agent-side view**: the tool response text echoes the same info back into the chat, so the agent (and you) see what arrived without needing to switch terminals.

## Interpret

### Probe 1 — identity

| Where agent id appears | Design implication for sc-mission-control |
|---|---|
| `process.env.OPENCLAW_AGENT_ID` (or similar key) at `process_start`, AND a different value per agent in Probe 2 | **Best case.** Per-agent subprocess with env baked in. Shared stdio server design works; identity via env. |
| `clientInfo.name` / `clientInfo._meta` on `initialized` | Shared connection, identity in the handshake. Cache per session. |
| `extra._meta` on every `tool_call_*` | Identity per-call; read it each time, don't cache. |
| None of the above | Every MC tool takes `agent_id` as an explicit arg. Trust boundary = `MC_API_TOKEN` (same as today's HTTP). Ergonomics suffer, security doesn't. |

### Probe 2 — subprocess model

- **Different `pid` per agent** → openclaw spawns one subprocess per agent. We can use env/argv identity.
- **Same `pid` across agents** → shared subprocess. Identity must come from the per-call path (`clientInfo` or `_meta`).

### Probe 3 — allowlist format

Record which candidate string made `whoami` appear in mc-writer's tool list and stay absent from an agent that wasn't allow-listed. That string format is what the real sc-mission-control plan uses for `tools.alsoAllow` entries.

If the tool also shows up for agents we *didn't* allow-list, per-agent scoping isn't effectively gating — fall back to a pattern where every tool on the MC server is gated by MC-side checks (agent must be assigned to the task, etc.) and the openclaw allowlist is informational.

## Rollback

```bash
openclaw mcp unset spike-echo
# Remove the spike-echo alsoAllow entries from agents.list[*].tools
# Turn off pluginToolsMcpBridge if you set it
openclaw gateway restart
```

Log file at `$TMPDIR/mcp-spike.log` or `/tmp/mcp-spike.log` is the only artifact; delete when done.
