# MCP surface review — `sc-mission-control`

**Status:** Draft v1 — role-scoping ruled out (runner-architecture constraint). Focus narrowed to action-discriminator consolidation. Implementation queue at the bottom.

## Inventory

47 tools registered globally on the `sc-mission-control` MCP server (`src/lib/mcp/server.ts` calls `registerAllTools` and `registerRoadmapTools`). Every session sees all 47 — there is no per-role / per-agent gating today.

### `tools.ts` (24 tools — worker / agent-loop concerns)

| # | Tool | Used by |
|---|---|---|
| 1 | `whoami` | All roles (bootstrap) |
| 2 | `get_workspace_context` | All roles |
| 3 | `list_peers` | Most roles |
| 4 | `get_task` | Workers (with task assignment) |
| 5 | `fetch_mail` | Coordinator / mail-receivers |
| 6 | `register_deliverable` | Workers (write outputs) |
| 7 | `submit_evidence` | Workers (evidence-gate flow) |
| 8 | `log_activity` | All roles |
| 9 | `take_note` | Most roles (breadcrumbs) |
| 10 | `read_notes` | Coordinator / reviewer |
| 11 | `mark_note_consumed` | Coordinator / next-stage |
| 12 | `archive_note` | Coordinator |
| 13 | `update_task_status` | Workers + coordinator |
| 14 | `fail_task` | Workers |
| 15 | `save_checkpoint` | Workers (long-running tasks) |
| 16 | `send_mail` | Mail-routing agents |
| 17 | `save_knowledge` | Learner / reflective |
| 18 | `request_knowledge` | Knowledge consumers |
| 19 | `spawn_subtask` | Coordinator (parent) |
| 20 | `list_my_subtasks` | Coordinator (parent) |
| 21 | `accept_subtask` | Coordinator (parent) |
| 22 | `reject_subtask` | Coordinator (parent) |
| 23 | `cancel_subtask` | Coordinator (parent) |
| 24 | `register_subagent_dispatch` | Runner only |

### `roadmap-tools.ts` (23 tools — PM / planning concerns + roadmap reads)

| # | Tool | Used by |
|---|---|---|
| 1 | `list_initiatives` | All roles (read) |
| 2 | `get_initiative` | All roles (read) |
| 3 | `get_initiative_tree` | All roles (read) |
| 4 | `get_roadmap_snapshot` | All roles (read) |
| 5 | `get_initiative_history` | All roles (read) |
| 6 | `get_task_initiative_history` | All roles (read) |
| 7 | `list_owner_availability` | PM, coordinator (read) |
| 8 | `get_velocity_data` | PM (read) |
| 9 | `list_proposals` | PM, coordinator (read) |
| 10 | `create_initiative` | Operator-direct path; agents rarely |
| 11 | `update_initiative` | Operator-direct |
| 12 | `move_initiative` | Operator-direct |
| 13 | `convert_initiative` | Operator-direct |
| 14 | `add_initiative_dependency` | Operator-direct |
| 15 | `remove_initiative_dependency` | Operator-direct |
| 16 | `move_task_to_initiative` | Operator-direct |
| 17 | `promote_initiative_to_task` | Operator-direct |
| 18 | `promote_task_to_inbox` | Operator-direct |
| 19 | `add_owner_availability` | Operator + PM via PmDiff |
| 20 | `propose_changes` | **PM only** |
| 21 | `propose_from_notes` | **PM only** |
| 22 | `refine_proposal` | **PM only** |
| 23 | `preview_derivation` | PM, advisory |

## Cost estimate

At ~400–500 tokens per tool definition (per the industry research): **47 tools × ~450 tokens ≈ 21K tokens of permanent overhead per session.** That's significant — Claude Sonnet 4 has 200K context, so every session burns ~10% of it on tool schemas alone.

Worse, every session pays this cost regardless of whether it'll ever invoke any of the tools. A researcher writing a brief sees the full PM proposal toolkit; the PM sees the subagent-spawn machinery; an autonomous worker sees `propose_changes`.

## What's well-shaped

### `propose_changes` is the textbook discriminated-union pattern

PR target was 10+ proposal-variant endpoints; instead we have **one tool** carrying a `PmDiff[]` with `z.discriminatedUnion('kind', [...])`. Current variants (~9): `shift_initiative_target`, `add_availability`, `set_initiative_status`, `add_dependency`, `remove_dependency`, `reorder_initiatives`, `update_status_check`, `create_child_initiative`, `create_task_under_initiative`. A new variant adds ~50 tokens to the schema; a new endpoint would have added ~450. **Keep doing this. Don't break the pattern.**

### Read-only tools are cheap and useful

`list_initiatives`, `get_roadmap_snapshot`, `get_initiative_tree`, etc. are all read-only and let the agent introspect state on demand instead of pre-loading everything in the briefing. This is the right tradeoff — the briefing sends a summary, the agent fetches details only when needed. Keep all of them.

### The PM uses the union; nothing needs splitting

Adding new PM proposal variants almost always means adding a `PmDiff` `kind`, not a new endpoint. The discriminated-union budget has plenty of headroom.

## What to fix

### 1. Consolidation candidates (~1.5–2K tokens recoverable)

These are tools that share enough shape they could merge with a discriminated-union or `action` parameter:

| Group | Current tools | Proposed | Estimated savings |
|---|---|---|---|
| Subtask lifecycle | `accept_subtask`, `reject_subtask`, `cancel_subtask` | One `update_subtask({ subtask_id, action: 'accept'\|'reject'\|'cancel', reason? })` | ~900 tokens |
| Note lifecycle | `mark_note_consumed`, `archive_note` | One `update_note({ note_id, action: 'consume'\|'archive', stage_slug? })` | ~450 tokens |
| Initiative deps | `add_initiative_dependency`, `remove_initiative_dependency` | One `update_initiative_dependencies({ initiative_id, add: [], remove: [] })` | ~450 tokens |

These collapses don't change semantics — each branch keeps its current logic; we're just routing through a discriminator. The tradeoff: a tiny ergonomic loss (the agent picks an action enum instead of a verb) for clearer surface + ~1.8K token savings.

**Do not merge:** `propose_changes` / `propose_from_notes` / `refine_proposal` are domain-distinct (propose-from-scratch vs. propose-from-notes-queue vs. refine-existing). Merging would make the schema worse, not better.

**Do not merge:** `update_task_status` / `fail_task`. They look similar but `fail_task` carries failure-specific fields (reason taxonomy, retryable, evidence pointers) that would muddy `update_task_status`'s schema.

### 2. Composable MCP servers grouped by scope

Originally I'd written this section off because role-scoping at the *runner* level doesn't help (the runner hosts every persona, so it mounts the union). But there's a real win for the **PM** — it's a separate gateway agent that only needs PM-relevant tools, yet today it sees the full 47-tool worker bundle.

**Proposal:** factor the single `sc-mission-control` MCP server into composable scope groups, mount each at its own HTTP route, and let gateway config choose which to attach per agent.

```
src/lib/mcp/
  build.ts              # buildServer(groups[]) factory
  groups/
    core.ts             # whoami, log_activity, take_note, get_workspace_context, list_peers
    read.ts             # all read-only roadmap/initiative/proposal queries
    work.ts             # task lifecycle, register_deliverable, submit_evidence, mail, subtasks
    pm.ts               # propose_changes, propose_from_notes, refine_proposal, preview_derivation
    crud.ts             # create_initiative, update_initiative, move/convert/promote/etc

src/app/api/mcp/
  route.ts              # default — core+read+work+pm (back-compat, unchanged surface)
  pm/route.ts           # core+read+pm                          ← ~16 tools, mount on PM
  work/route.ts         # core+read+work                        ← ~22 tools, mount on runner
  crud/route.ts         # core+read+crud                        ← parked for future use
```

**Why this works given the runner-everything-mounts constraint:**

- **PM (separate gateway agent):** mounts `/api/mcp/pm` only → sees ~16 tools instead of 47. **Saves ~14K tokens per PM dispatch.** This is the big real win.
- **Runner (hosts every persona):** keeps mounting `/api/mcp` (default — same as today) or moves to `/api/mcp/work`. Either way it sees the union it needs — no behavior change.
- **CRUD endpoints stay alive but unmounted by default.** When the operator wants to wire a direct-edit agent (e.g. for openclaw-driven schedule manipulation), they mount `/api/mcp/crud` on that specific agent. No tools are deleted; they just stop polluting the runtime surfaces that don't use them.

**Why grouped files instead of one big tools.ts:**

The current `tools.ts` (1991 lines) and `roadmap-tools.ts` (809 lines) intermix tools that have very different audiences. Splitting them into scope-grouped files is a worthwhile refactor independent of the endpoint split — it makes "when does this tool register?" a one-line answer per file. The endpoint-split is then trivial: each route imports the groups it wants and calls `buildServer(...)`.

**Additive, not destructive:**

- Default route stays at `/api/mcp` with the same tool surface. Nothing breaks.
- New routes are opt-in via gateway agent config.
- Each agent type can be migrated independently — operator updates one config entry per agent type to point at the narrow endpoint, validates, moves on.

**Open question:** what's the gateway-side configuration unit that picks which MCP server an agent mounts? Likely a `skills.json` / `skills.yaml` per workspace agent (per the `agent-templates/_shared` patterns). The split needs the operator to update those configs to realize the savings — the code change alone is necessary but not sufficient.

### 3. Operator-direct CRUD tools — keep, but park them in their own endpoint

`create_initiative`, `update_initiative`, `move_initiative`, `convert_initiative`, `add/remove_initiative_dependency`, `move_task_to_initiative`, `promote_initiative_to_task`, `promote_task_to_inbox` — these 8 tools are mostly invoked from MC's UI (REST API), not by agents. The PM uses `propose_changes` instead; no autonomous agent calls them today.

But they may be useful in the future for direct openclaw-driven schedule manipulation. Rather than delete them, **park them in `groups/crud.ts` and expose at `/api/mcp/crud`** — unmounted by default. The code stays maintained as the rest of the surface evolves; the only cost is 8 unused tool registrations in a route nobody calls. When a use case emerges, mount the endpoint on the relevant agent.

## Net token-savings estimate

With composable MCP servers + action-discriminator consolidation:

| Change | PM session | Runner session |
|---|---|---|
| Consolidate subtask + note actions | ~1.4K | ~1.4K |
| Park CRUD tools at `/api/mcp/crud` (unmounted) | ~3.5K | ~3.5K |
| PM mounts `/api/mcp/pm` instead of full | ~14K | — |
| **Total** | **~18.9K** | **~4.9K** |

Translated: a typical **PM dispatch** drops from ~21K → ~2K of schema overhead (a 90% reduction). A typical **runner-hosted persona dispatch** drops from ~21K → ~16K (~24% reduction). The runner stays expensive because it has to mount everything by architecture — but the PM doesn't, and the PM is the surface that's been giving us trouble (silent-empty replies, stale anchoring, etc.).

The dependency-tools merge (`add_initiative_dependency` / `remove_initiative_dependency`) is structurally a batch operation, not a discriminator — defer to its own decision.

## Decisions locked in

1. **`propose_changes` extension policy.** Keep extending the discriminated union until we hit a complexity threshold; spin up dedicated research at that point. Don't preemptively split into sibling tools.
2. **In-flight session migration.** Hard rename when we consolidate. In-flight sessions get reset; no deprecation shims.
3. **Where gateway MCP servers are configured.** `openclaw.json`. Two relevant sections:
   - `mcp.servers.<server-name>` — registers each MCP server (command, args, env including the `MC_URL` for the route).
   - `agents[].tools.alsoAllow / deny` — per-agent allowlist. Patterns like `"sc-mission-control-dev__*"` grant every tool from that MCP server to that agent.

   The split design slots in cleanly:

   ```jsonc
   "mcp": {
     "servers": {
       "sc-mc-dev":      { "env": { "MC_URL": "http://localhost:4010/api/mcp"      } },
       "sc-mc-pm-dev":   { "env": { "MC_URL": "http://localhost:4010/api/mcp/pm"   } },
       "sc-mc-crud-dev": { "env": { "MC_URL": "http://localhost:4010/api/mcp/crud" } },
       // ... matching prod entries pointing at :4001 ...
     }
   }
   ```

   Per-agent allow patterns:
   - **Runner (dev):** `alsoAllow: ["sc-mc-dev__*"]`, deny prod variants. Same surface as today.
   - **PM (dev):** `alsoAllow: ["sc-mc-pm-dev__*"]` instead of the full `sc-mc-dev__*`. Smaller surface.
   - **Future direct-edit agent:** `alsoAllow: ["sc-mc-crud-dev__*"]`. Parked until needed.

   Existing scripts in this neighborhood: `yarn openclaw:sync` (`scripts/sync-openclaw-agents.mjs`), `yarn workspace:provision` (`scripts/provision-workspace-runner.ts`), `yarn runner-host:reseed` (`scripts/neutralize-runner-host.ts`). The new responsibility — keeping the MCP server registry + per-agent allowlists in sync with the MC-side route layout — should live in the same script family. Likely a single new tool that:

   - Reads MC's "intended layout" (groups → URL → which agent type each maps to) from a small declarative config.
   - Idempotently writes the matching `mcp.servers` entries and per-agent `alsoAllow` / `deny` patterns into `openclaw.json`.
   - Runs both for dev and prod variants in one pass.
   - Is callable via `yarn openclaw:apply-mc-servers` (or as a step inside `workspace:provision`).

   This is the operator-facing change that actually realizes the savings from the route split — code-only work without it just adds inert routes.

## Recommended action queue

1. **PR 1 — Refactor `tools.ts` + `roadmap-tools.ts` into scope groups.** Pure code move; zero runtime change. Files end up in `src/lib/mcp/groups/{core,read,work,pm,crud}.ts` plus a `buildServer(groups[])` factory. The default `/api/mcp` route imports all of them — same tool surface as today. Easy review (it's a refactor); sets the foundation for everything else.

2. **PR 2 — New `/api/mcp/pm` and `/api/mcp/crud` routes.** PM endpoint imports `core+read+pm`; CRUD endpoint imports `core+read+crud`. Default route unchanged. No agent picks them up yet — the gateway-side config update is a separate operator action.

3. **PR 3 — Operator action: re-point PM gateway config to `/api/mcp/pm`.** Documentation + concrete config diff. Validates the split actually saves ~14K tokens per PM dispatch. Mostly a one-line config change in `~/.openclaw/workspaces/mc-pm-default-dev/skills.json` (or whichever file declares MCP servers there).

4. **PR 4 — Consolidate subtask actions.** New `update_subtask({ subtask_id, action: 'accept'|'reject'|'cancel', reason?, new_acceptance_criteria? })`. Replaces three separate tools. Touches: `src/lib/mcp/groups/work.ts`, `agent-templates/coordinator/{SOUL,AGENTS}.md`, `agent-templates/_shared/messaging-protocol.md`, `src/app/api/tasks/[id]/dispatch/route.ts` (the dispatch template that coaches coordinators). Saves ~900 tokens. Lands in `work.ts` so it propagates to default + work + pm endpoints automatically.

5. **PR 5 — Consolidate note lifecycle.** New `update_note({ note_id, action: 'consume'|'archive', stage_slug?, reason? })`. Replaces `mark_note_consumed` + `archive_note`. Touches: `src/lib/mcp/groups/core.ts`, `agent-templates/runner-host/AGENTS.md`, `agent-templates/_shared/{messaging-protocol,notetaker}.md`. Saves ~450 tokens.

6. **PR 6 — Doc-only.** Codify the discriminated-union principle in the PM SOUL + this review file as the standing reference for "should I add a new MCP tool or extend `propose_changes`?". Cheap, sets direction.

**Sequencing notes:**
- PR 1 is a clean prerequisite — every later PR is easier in the grouped layout.
- PR 2 lands the new endpoints but they're inert until PR 3 wires the PM at the gateway side. Could be combined into one PR if you'd rather move atomically.
- PRs 4 & 5 (consolidations) are independent of 1–3 mechanically but cleaner to land after 1.
- PR 6 can land anytime — pure doc.

The dep-tool merge is deferred. Two paths if we ever consolidate: (a) `update_initiative_dependencies({ initiative_id, add: [], remove: [] })` — clean batch shape; (b) leave as two tools — ~450 tokens cost. Defer until a use case forces it.

## Out of scope

- Anthropic's MCP Tool Search / lazy loading — not supported by OpenClaw's gateway today. Worth tracking as upstream improves.
- Code-execution wrapping (Anthropic's "tools as code" pattern) — bigger architectural shift; reconsider when individual sessions chain >5 MCP calls regularly.
- Per-session tool injection — explicitly disallowed by OpenClaw; revisit if/when the gateway protocol supports it.
