# Dogfood Playbook — iterating on Mission Control with Mission Control

This is the operator playbook for running two MC instances side by
side: a **stable** instance you actually plan against, and a **dev**
instance you iterate on. The split lets you use MC's PM/roadmap
surface to drive the evolution of MC itself without a half-baked dev
change taking out the planning surface you're using to plan the change.

## TL;DR

| | Stable | Dev |
|---|---|---|
| Run via | `docker compose up` | `yarn dev` |
| Port | `4001` | `4010` |
| Database | persisted volume | `mission-control.db` in repo |
| Agent roster | `mc-pm`, `mc-builder`, … | `mc-pm-dev`, `mc-builder-dev`, … |
| MCP server | `sc-mission-control` | `sc-mission-control-dev` |
| Workspace dirs | `~/.openclaw/workspaces/<agent>` | `~/.openclaw/workspaces/<agent>-dev` |
| Catalog-sync filter | `MC_AGENT_SYNC_EXCLUDE=*-dev` | `MC_AGENT_SYNC_INCLUDE=*-dev` |
| Updated when | a tested PR merges + image rebuilds | every save (HMR) |

> Port `4000` is the local LiteLLM gateway and stays put. Don't bind MC
> to it.

## Why two instances

- **Stable is durable.** It runs the last code you tested + merged. The
  PM, the operator UI, the SSE channel, the roadmap — all of it stays
  up while you break things in dev.
- **Dev is throwaway.** Migrations, prompt edits, MCP-tool refactors all
  land in dev first. Its DB is `git`-adjacent and frequently reset.
- **They never share a database.** A new migration on a feature branch
  must not touch stable's data. A new MCP tool shape on a dev branch
  must not be visible to stable's agents.
- **Their agent rosters are isolated.** Same agent IDs across both
  rosters would mean one MCP server registration silently routes to
  whichever MC instance won the race — exactly the cross-contamination
  this playbook prevents.

## How the isolation works

`~/.openclaw/openclaw.json` is global, but two things in it are
independently-keyed:

1. **`mcp.servers.<name>`** — each entry spawns its own launcher process
   and points at its own URL + token. We add a parallel
   `sc-mission-control-dev` entry pointing at `http://localhost:4010/api/mcp`.
2. **`agents.list[].id`** — each agent has a unique ID and its own
   `workspace` dir + `tools.alsoAllow` list. We duplicate each MC agent
   block (`mc-pm`, `mc-coordinator`, …) under a `-dev`-suffixed ID, swap
   its `alsoAllow` to reference `sc-mission-control-dev__*`, and point
   its `workspace` at a copied directory.

When you chat in openclaw, the agent ID you pick determines which MC
you talk to. Picking `mc-project-manager-dev` drives dev; picking
`mc-project-manager` drives stable.

## One-time setup

### 1. Copy the agent workspace directories

Each MC agent has a workspace dir under `~/.openclaw/workspaces/` holding
SOUL.md, MEMORY.md, and session caches. Copy them to `-dev`-suffixed
counterparts:

```bash
cd ~/.openclaw/workspaces
for d in mc-builder mc-coordinator mc-learner mc-project-manager \
         mc-researcher mc-reviewer mc-tester mc-writer; do
  [ -d "$d" ] && [ ! -d "$d-dev" ] && cp -r "$d" "$d-dev"
done
```

The `-dev` dirs start as exact copies; their SOUL.md and MEMORY.md
diverge naturally as you iterate. Stable's dirs stay untouched.

### 2. Generate a dev MC API token

The dev MC instance needs its own bearer token (don't share with
stable — that defeats the isolation). Whatever process you use to mint
stable's token, repeat for dev. Stash the dev token; you'll wire it
into the openclaw config below.

### 3. Sync the openclaw agent roster

Run the sync script. It will:

- add `mcp.servers.sc-mission-control-dev` to `openclaw.json` (with a
  placeholder for the API token),
- duplicate every `mc-*` agent block as `mc-*-dev` with the workspace
  path and `tools.alsoAllow` rewritten,
- back up your existing config to `openclaw.json.bak.<timestamp>`.

```bash
yarn openclaw:sync:check   # dry-run, exits non-zero if drift found
yarn openclaw:sync         # apply
```

The script is **idempotent**: re-running mirrors any subsequent edits
to a stable agent block back to its `-dev` counterpart. Run it after
any change to a stable agent (new skill, tool change, model swap) to
keep the dev block aligned.

### 4. Replace the API token placeholder

Open `~/.openclaw/openclaw.json`, find:

```json
"sc-mission-control-dev": {
  "command": "node",
  "args": ["/.../mcp-launcher/launcher.mjs"],
  "env": {
    "MC_URL": "http://localhost:4010/api/mcp",
    "MC_API_TOKEN": "__SET_DEV_MC_API_TOKEN__"
  }
}
```

Replace `__SET_DEV_MC_API_TOKEN__` with your dev MC token from step 2.
Match `MC_URL` to wherever your dev MC actually listens (default
`4010`; override via `PORT=…` in the dev MC's env).

### 5. Filter the catalog sync per instance

The openclaw gateway is single-source-of-truth for the workspace
agent roster, so without filtering each MC instance mirrors **every**
agent the gateway exposes — meaning prod's `/agents` page shows the
`-dev` roster and vice versa. Set one of the two env vars below per
instance so each MC only mirrors its own subset:

| Instance | env var |
|---|---|
| Prod (docker) | `MC_AGENT_SYNC_EXCLUDE=*-dev` |
| Dev (`launch.json`) | `MC_AGENT_SYNC_INCLUDE=*-dev` |

For dev, add `MC_AGENT_SYNC_INCLUDE=*-dev` to the env block of your
`.claude/launch.json` (`mission-control-dev` config) — that file is
gitignored so each operator wires it once locally. For prod, add
`MC_AGENT_SYNC_EXCLUDE=*-dev` to whichever env source your
`docker-compose.yml` uses.

Both vars accept comma-separated lists with `*` wildcards
(e.g. `mc-builder,mc-coordinator-dev`, `mc-*` ). When both are set,
exclude wins for the same id. Default empty → no filter (current
behavior).

When a previously-synced agent stops matching the filter, the next
catalog sync flips its `status` to `offline` (does **not** delete
the row — task / mailbox FK references stay valid). Re-including it
later flips status back to `idle` automatically.

### 6. Restart openclaw

Openclaw reads `openclaw.json` once at start. After the sync, restart
the gateway so the new agent roster and MCP server are picked up.

### 7. Smoke test

Pick `mc-project-manager-dev` in the openclaw chat surface. Ask it
something simple ("call `whoami`"). The reply should report
`agent_id: mc-project-manager-dev` and the dev MC's workspace details.
Then pick `mc-project-manager` and confirm it reports stable's.

If the dev agent gets MCP errors or routes to stable's data, double-check:

- Dev MC is running on `4010` (`curl http://localhost:4010/api/health`).
- The token in `sc-mission-control-dev` matches the dev MC's expected token.
- The dev agent's `tools.alsoAllow` contains `sc-mission-control-dev__*`,
  not `sc-mission-control__*`.

## Daily workflow

### Plan in stable

Open `http://localhost:4001/pm` (or wherever the docker stable lives
in your environment). Decompose specs into epics, accept proposals,
track work. **This is where the durable roadmap of MC's evolution
lives.** It survives container restarts, prompt iterations, and dev
breakage.

### Build in dev

Branch, code, `yarn test`, run the preview-test flow against
`http://localhost:4010`. Drive interactive testing through the
`-dev`-suffixed agents — they reach into dev's DB and exercise dev's
MCP-tool shape.

### Validate before merge

For changes that touch the agent prompts (`src/lib/agents/*-soul.md`)
or the MCP tool surface, walk the relevant section of
`docs/PREVIEW_TEST_FLOW.md` against dev. Reset the dev agent's session
on `/agents` after a SOUL.md change so it picks up the new prompt.

### Merge → rebuild stable

PR merges to main → CI rebuilds the stable docker image → restart
the stable container. The persisted volume keeps stable's planning
state across restarts; only the code changes.

### Optional: hydrate dev with realism

To test against non-trivial data, snapshot stable's DB into dev:

```bash
yarn db:checkpoint save stable-realistic --source=/path/to/stable.db
yarn db:checkpoint:restore stable-realistic
```

Treat the copy as throwaway — dev's DB is reset frequently.

## Maintenance

### When a stable agent block changes

Run `yarn openclaw:sync` after editing any `mc-*` agent in
`openclaw.json`. The script re-mirrors the change to the matching
`-dev` block. Forgetting this means dev silently drifts behind stable
on tools/skills until the next sync.

### When a SOUL.md changes

Live SOUL.md lives at `~/.openclaw/workspaces/<agent>/SOUL.md`. The
canonical copy is in the MC repo at `src/lib/agents/<agent>-soul.md`.
After editing the repo copy:

1. Copy to dev: `cp src/lib/agents/pm-soul.md ~/.openclaw/workspaces/mc-project-manager-dev/SOUL.md`
2. Test in dev. Reset the agent's session.
3. On merge, copy to stable: `cp src/lib/agents/pm-soul.md ~/.openclaw/workspaces/mc-project-manager/SOUL.md`
4. Reset stable's agent session.

There's no automatic sync between the repo and the live workspace
dirs — that's intentional, because stable should stay on the
last-known-good prompt until you choose to update it.

### When a new MC agent is added

If a new agent ID matching `^mc-[a-z-]+$` appears in `openclaw.json`,
the next `yarn openclaw:sync` will create the `-dev` counterpart
automatically. You still need to manually `cp -r` the workspace dir
(step 1 above).

### When you remove an MC agent

The sync script doesn't currently prune `-dev` agents whose stable
counterpart was deleted. Remove the `-dev` block by hand and delete
its workspace dir.

## Risks and gotchas

- **Stable can't pick up MCP-tool changes without rebuilding.** Fine
  in steady state; just don't expect mid-session hot-reload.
- **Dev's PM may give different recommendations than stable's** because
  it's running in-progress prompts. That's correct, but watch for
  "I refined this in dev's PM" → "doesn't repro in stable" — they're
  different agents now.
- **Schema drift between branches.** A long-lived feature branch with
  migrations should checkpoint dev frequently; rolling back is easier
  than untangling a polluted DB.
- **Agent session caching.** Both stable and dev cache openclaw
  sessions per agent. After a SOUL.md change, hit `/agents` Reset
  session — same as in production, just more frequent.
- **Token leakage.** Don't commit `~/.openclaw/openclaw.json`
  anywhere. The dev token belongs to the operator's machine, not the
  repo.

## Why not the alternatives

- **One MCP server, route by `agent_id` inside the launcher.** Hacky;
  breaks isolation: a typo in agent_id could cross workspaces. The
  proxy is the wrong place for routing.
- **Per-workspace openclaw config.** Doesn't exist; openclaw.json is
  global.
- **Run dev with stable's MCP server and a different token.** Tempting,
  but stable's agents would reach into dev's DB whenever they call MCP
  — exactly the cross-contamination this split prevents.

## Future tightening (out of scope here)

- Lifecycle hooks: when MC's repo bumps a SOUL.md, automate the
  workspace-dir copy with `--target=stable|dev` so steps 1/3 of the
  SOUL.md flow above collapse.
- Sync-script prune: detect `-dev` agents whose stable counterpart
  was deleted and remove them (with a confirm prompt).
- A `yarn dev:fresh` script that resets dev's DB + reseeds + restarts.
