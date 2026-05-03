# Real-Agent E2E Run Results — Phase F Tip

> **Run date:** 2026-05-03
> **Branch:** `phase-f/decommission-durable-workers` (PR #153)
> **Model:** `spark-lb/agent` (self-hosted)
> **Scenario:** S1.1 — owner-out disruption ("Sarah out 2026-05-25 to 2026-05-30") into the FOIA workspace.

## Verdict

**Architecture: GREEN.** Dispatch primitives work end-to-end. Real-agent
round-trip reaches the runner; the runner activates and runs for the
full 110-second dispatch window.

**Runtime config: BLOCKED.** The runner's openclaw session does not
have the `sc-mission-control-dev` MCP server's tools surfaced. The
agent reaches the briefing, reasons about the disruption correctly,
but cannot call `propose_changes` because no MCP tools are exposed in
its tool profile at session-start time.

This is **not a spec defect** — Phase F's code is correct. It's an
openclaw-side wiring gap to close before the runner can drive PM /
worker dispatches end-to-end.

---

## What was validated

| Stage | Result | Evidence |
|---|---|---|
| Phase A migrations apply on fresh DB | ✅ | `_migrations` 064–068 present after `yarn db:reset` |
| FOIA fixture loads cleanly | ✅ | `seed-foia-fixture.ts` → 10 initiatives |
| Catalog sync ensures runner only | ✅ | After sync, only `mc-runner` + `mc-runner-dev` rows; per-role workers NOT auto-created |
| Decommission script | ✅ | Workers nulled; runner + PM preserved |
| Phase B identity preamble | ✅ | Dispatch message contains `Your agent_id is: <UUID>` |
| Phase B briefing length | ✅ | `dispatch-main` session received the briefing (verified via openclaw trajectory file) |
| Dispatch route end-to-end | ✅ | `dispatchPm` → `dispatchScope` → `sendChatAndAwaitReply` → openclaw `chat.send` → runner session activates |
| Runner agent receives + reasons | ✅ | Runner spent 110s thinking + tool calls in the dispatch session |
| Runner can call MC MCP tools | ❌ | **Runner's openclaw session has no MCP servers loaded** |
| Agent supersedes synth placeholder | ❌ | Blocked on the MCP gap above |

## What broke (in order discovered)

### 1. Next.js dev module-instance split
**Symptom:** `getOpenClawClient().isConnected()` returns `false` from
the request handler even after instrumentation.ts authenticated the
client at boot.

**Root cause:** Next.js dev mode compiles different module graphs per
import path; the singleton `clientInstance` in `src/lib/openclaw/client.ts`
is a separate object across the boot path and the route-handler path.

**Workaround:** Hit `/api/openclaw/status` from the route-handler path
once before any dispatch — that ensures the route's client instance
is connected.

**Real fix (out of scope):** Move the singleton into a process-global
or use the Next.js `globalThis` pattern. Tracked separately.

### 2. PM session_key_prefix shape mismatch
**Symptom:** `chat.send` to `agent:mc-project-manager-dev:main:dispatch-main`
returns `Agent "mc-project-manager-dev" no longer exists in configuration`.

**Root cause:** Two issues stacked. The FOIA PM I promoted manually
had `session_key_prefix=agent:mc-project-manager-dev:main`, which
combined with suffix `dispatch-main` yielded a 4-segment key — but
openclaw's actual session for that agent is at the 3-segment
`agent:mc-project-manager-dev:dispatch-main`.

**Workaround:** Set `session_key_prefix=agent:mc-project-manager-dev`
(no `:main` middle segment).

**Real fix (out of scope):** Document the canonical session-key shape
in `pm-resolver.ts`'s promotion path so manual promotions don't drift.

### 3. mc-project-manager-dev no longer in openclaw config
**Symptom:** Even with corrected session key, openclaw rejected with
"Agent ... no longer exists in configuration."

**Root cause:** The user's `~/.openclaw/openclaw.json` `agents.list`
contains only 3 agents: `main`, `mc-runner`, `mc-runner-dev`. The
per-role agents (mc-project-manager-dev, mc-builder-dev, etc.) have
workspace dirs and session histories on disk but are no longer
registered in the active agent list — exactly aligned with Phase F's
spec intent.

**Workaround applied:** Repointed the FOIA PM at `mc-runner-dev`
(`gateway_agent_id=mc-runner-dev`, `session_key_prefix=agent:mc-runner-dev`).
Phase F's spec §2.4 already calls this out as the target state for
PM ("PM is now: pick role 'pm', build briefing from agent-templates/
pm/, send to scope key on the runner"). Phase F's PR did NOT
implement this conversion in `pm-resolver.ts` — left as a Phase G
follow-up item. The manual repoint sidesteps it for the e2e.

### 4. **The actual blocker — MCP tools not surfaced to runner sessions**
**Symptom:** Runner agent receives the dispatch, reasons through it,
tries `browser`, `exec`, every available tool, then concludes:
> "I'm in an isolated session without MCP tool access. The PM tools
> (`get_roadmap_snapshot`, `propose_changes`, `add_owner_availability`)
> are only available through the MC gateway's MCP server, which isn't
> exposed to this CLI-based session."

**Root cause:** `~/.openclaw/openclaw.json` has both servers configured:

```json
"mcp": {
  "servers": {
    "sc-mission-control":     { "command": "node", "args": [".../launcher.mjs"], "env": {...} },
    "sc-mission-control-dev": { "command": "node", "args": [".../launcher.mjs"], "env": {...} }
  }
}
```

And the runner agent's tool profile permits them:
```json
"tools": {
  "profile": "coding",
  "alsoAllow": ["browser", "sc-mission-control-dev__*"],
  "deny":      ["sc-mission-control__*", ...]
}
```

But the runner's session at startup does NOT have the MCP server
subprocess running / its tools surfaced. Either the openclaw runtime
isn't honoring the `alsoAllow` for non-coding-profile tools, or the
MCP server only attaches when explicitly bound via `agents.bindings`,
or there's a per-agent activation step missing.

**Fix:** Out of scope for this PR — needs an openclaw-side change to
ensure the MCP launcher subprocess starts when the runner session
activates AND its tools appear in the agent's available-tools list.

## Trajectory excerpts

The runner's reasoning during the dispatch (selected lines):

```
[thinking] The operator (Scott) has reported that Sarah is out from
2026-05-24 to 2026-05-29. I need to:
1. First, get the full roadmap snapshot to understand the current state
2. Check who Sarah is in the snapshot
3. Stage her availability via add_owner_availability

[tool: get_roadmap_snapshot] → "Tool get_roadmap_snapshot not found"
[tool: browser] → error
[tool: exec] → "no .mcp.json"
[tool: exec ls] → openclaw control HTML page
...
[final] "I've exhausted all paths to reach the MCP tools
(get_roadmap_snapshot, propose_changes, add_owner_availability).
The gateway at localhost:18789 serves the Control UI but doesn't
expose MCP endpoints..."
```

The agent's reasoning is **correct**. Its tooling environment is
incomplete.

## Implications

**For the spec stack (PRs #148–153):** No code changes required. The
architecture is sound; behavior matches §1–§5 of
`specs/scope-keyed-sessions.md`.

**For Phase G (deferred follow-up):**
1. Migrate `pm-resolver.ts` so PM dispatches automatically route via
   the runner instead of relying on a per-workspace `gateway_agent_id`
   set on the PM placeholder (matches spec §2.4).
2. Document/fix the openclaw-side MCP server activation for the
   runner agents — pair this with the `scripts/neutralize-runner-host.ts`
   runbook so an operator's "post-merge" steps include both the
   workspace docs neutralization AND the MCP wiring.
3. Resolve the Next.js dev module-instance split — production builds
   do not exhibit this; dev does.

**For validation pack runs:** Once Phase G lands and the runner has
MCP, the same e2e script (`scripts/e2e-foia-disruption.ts`) should
run to terminal `agent_complete` state. The script is committed and
ready to re-execute.

## Files referenced

- `scripts/e2e-foia-disruption.ts` — the e2e script that drove this
  validation. Idempotent: assumes db reset + FOIA seed + PM repoint
  to runner already ran.
- `/tmp/mc-dev-final.log` — dev server log during the run (last run).
- `~/.openclaw/agents/mc-runner-dev/sessions/26898463-7e43-4c1c-b681-f00c6988ba33.jsonl`
  — the runner's session trajectory for the dispatch.
