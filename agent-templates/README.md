# Agent Templates

Source-controlled role definitions for Mission Control's scope-keyed
session model. Every agent dispatch builds its briefing from these
files (plus per-workspace overrides from the `agent_role_overrides`
table).

See [`specs/scope-keyed-sessions.md`](../specs/scope-keyed-sessions.md)
§2 for the architectural context.

## Layout

```
agent-templates/
├── README.md                     ← this file
├── _shared/                      ← appended to every role's briefing
│   ├── notetaker.md              ← obsessive-notetaker addendum
│   ├── messaging-protocol.md     ← MCP tool reference (mirror)
│   └── shared-rules.md           ← org-wide behavioral rules (mirror)
├── pm/                           ← Project Manager (per-workspace persistent)
├── coordinator/                  ← Coordinator (per-task scope)
├── builder/                      ← Builder (per-stage scope)
├── researcher/                   ← Researcher
├── tester/                       ← Tester
├── reviewer/                     ← Reviewer
├── writer/                       ← Writer
├── learner/                      ← Learner
└── runner-host/                  ← Neutral host SOUL/AGENTS/IDENTITY
                                    for the mc-runner-dev gateway agent
```

Each role directory contains `SOUL.md`, `AGENTS.md`, `IDENTITY.md`.
The briefing builder concatenates these in order, then appends the
shared addenda, then the task context, then the identity preamble.

## Authoring a new role

1. Create `agent-templates/<new-role>/`.
2. Drop `SOUL.md`, `AGENTS.md`, `IDENTITY.md` modeled on existing roles.
3. Add the role to the `agent_role_overrides` schema's check constraint
   (migration update if needed).
4. Update the dispatch resolver so scope keys can route to the new role.
5. Add a synthetic task in the validation pack
   (`specs/scope-keyed-sessions-validation/02-test-plan.md`) covering
   the new role.

## Refreshing from openclaw workspaces

Initial seed came from `~/.openclaw/workspaces/mc-{role}-dev/`. To
refresh after upstream changes:

```sh
yarn tsx scripts/import-agent-templates.ts
git diff agent-templates/
```

The script never touches `runner-host/` or `_shared/notetaker.md` —
those are hand-authored.

## Per-workspace overrides

Operators can override any role's text per-workspace via the
`agent_role_overrides` table (see migration 064). The settings UI
exposes a live preview / "Reset to template" button per role.

Resolution order at briefing time:

1. `agent_role_overrides.soul_md` if a row exists for `(workspace_id, role)`.
2. Else `agent-templates/<role>/SOUL.md`.

Same for `AGENTS.md` and `IDENTITY.md`.

## Shared addenda

`_shared/notetaker.md` is appended to **every** role's briefing. It's
the load-bearing instruction that turns agents into observability
sources via the `take_note` MCP family. Edit with care — every agent
in the system reads it.

`_shared/messaging-protocol.md` and `_shared/shared-rules.md` are
imported from openclaw's symlinked shared docs. They describe the MCP
tool surface and org-wide behavioral rules, respectively. Refresh via
the import script when openclaw upstream changes.
