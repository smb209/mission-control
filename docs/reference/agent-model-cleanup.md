# Agent model cleanup — drop residual N-gateway assumptions

## Background

Mission Control's agent topology was collapsed some time ago. The current intended model:

- **Workspace PM** — one gateway-bound openclaw agent **per workspace** (`mc-pm-<slug>(-dev)`). Owns workspace memory, dispatches workers, makes roadmap proposals.
- **Org runner** — exactly **one** gateway-bound openclaw agent **org-wide** (`mc-runner` / `mc-runner-dev`). Reused across every workspace. Hosts ephemeral, scope-keyed sessions adopting whichever role's `SOUL.md` the dispatcher attaches.
- **Role templates** — `builder`, `tester`, `reviewer`, `researcher`, `writer`, `learner`, `auditor`, `coordinator`. These exist as MC agent rows (so they appear in `list_peers`, fill `task_roles`, hold the role's display name and emoji), but have **`gateway_agent_id = NULL`** by design. They are not gateway-bound. When dispatch routes a task to a role-template agent, it routes the chat to the **runner** with the role's SOUL attached.

The old model had one gateway-bound agent per role per workspace (`mc-builder-<ws>`, `mc-reviewer-<ws>`, etc.). The dispatcher, sync, and agent docs were updated to the new model in waves, but several surfaces still encode N-gateway assumptions. Symptom that surfaced this audit: a coordinator session (runner hosting `coordinator/SOUL.md`) tried `spawn_subtask({ peer_gateway_id: 'mc-builder-<ws>' })`, looped through guesses, and gave up — there is **no valid `peer_gateway_id`** in the new model that resolves to a builder role template (they all have null gateway_id).

This spec records the audit, defines the cleanup, and scopes the implementation for this PR.

## Audit summary

### Tier 1 — Load-bearing bugs

1. **`spawn_subtask` requires `peer_gateway_id`.** [src/lib/mcp/groups/work.ts:1154-1158, 1269-1297](../src/lib/mcp/groups/work.ts). Lookup is `WHERE gateway_agent_id = ? AND workspace_id = ?`. Role templates have `gateway_agent_id IS NULL`, so this query can never resolve them. The coordinator has no way to delegate to a builder/tester/reviewer/etc. via the current contract.

2. **`spawn_subtask` workspace filter excludes the org runner.** [src/lib/mcp/groups/work.ts:1269-1297](../src/lib/mcp/groups/work.ts). The lookup scopes by parent-task workspace; the org runner lives in `workspace_id='default'` regardless of caller's workspace. The "Found in: rr-s2-..." error in the source session was the residual symptom — stale `mc-builder-rr-s2-dev` rows from the old per-role/per-workspace model bled into the lookup.

3. **Coordinator dispatch roster filters out role templates.** [src/app/api/tasks/[id]/dispatch/route.ts:567-592](../src/app/api/tasks/[id]/dispatch/route.ts). The roster section the coordinator sees in its briefing filters `WHERE gateway_agent_id IS NOT NULL` — so the only peers the coordinator is told about are the workspace PM, the org runner, and any stale role-bound rows. The actual role templates it should be delegating to are filtered out.

4. **Stale per-role gateway-bound agent rows still exist in the DB.** Confirmed via the source session log (`mc-builder-rr-s2-dev`, `mc-builder-rr-s5-dev`, `mc-builder-rr-s5b-dev` in workspaces `rr-s2-…`, `rr-s5-…`). Catalog sync at [src/lib/agent-catalog-sync.ts:356-358](../src/lib/agent-catalog-sync.ts) explicitly stopped materialising new ones, but only marks offline rows whose gateway_id was explicitly **excluded by the include/exclude filter**. Rows whose gateway agent has been deleted from openclaw entirely (or was never re-created) keep `status != 'offline'` indefinitely and bleed into peer lookups.

### Tier 2 — Stale assumptions (silent gaps)

5. **`list_peers` returns a flat list with no dispatchability signal.** [src/lib/mcp/groups/core.ts:262-297](../src/lib/mcp/groups/core.ts). Coordinator sees role templates and gateway-bound peers in the same shape; nothing tells it which is mailable vs. delegable-via-spawn.

6. **Authz session-role plumbing.** [src/lib/authz/agent-task.ts:189](../src/lib/authz/agent-task.ts). `delegate` action checks `agent.role === 'coordinator'` on the DB row. In the new model the question is "is this *session* running coordinator SOUL?" (briefing-driven, not row-driven). Currently dormant — the assignee row's role does happen to match the session's SOUL today — but will break the moment a session's adopted role diverges from its assigned agent row (e.g. a runner session hosting coordinator SOUL where the assignee is a PM).

7. **Briefing role-section variable safety.** [src/lib/agents/briefing.ts:119-130](../src/lib/agents/briefing.ts). `buildRoleSection` has no guard against `{{working_dir}}`-style variables in workspace role overrides. Since the runner is org-global, any agent-row-derived workspace field that leaked into the role section would point at the wrong workspace.

8. **Schema lacks an invariant for the org runner's workspace.** No CHECK constraint enforcing `workspace_id='default'` for `gateway_agent_id IN ('mc-runner','mc-runner-dev')`. Convention only.

### Tier 3 — Doc / prompt surfaces

9. **Coordinator SOUL.md** ([agent-templates/coordinator/SOUL.md:35](../agent-templates/coordinator/SOUL.md)) tells the coordinator to discover peers via "gateway_id ↔ MC agent_id" — wrong abstraction for the new model where role templates have no gateway id.

10. **Coordinator AGENTS.md** ([agent-templates/coordinator/AGENTS.md:11, 22-39](../agent-templates/coordinator/AGENTS.md)) shows `peer_gateway_id: '<gateway_id from list_peers>'` in the contract example. Following this contract verbatim cannot delegate to a role template under the new model.

11. **Shared messaging-protocol.md** ([agent-templates/_shared/messaging-protocol.md:62](../agent-templates/_shared/messaging-protocol.md)) — same `peer_gateway_id` shape in the spawn_subtask reference. Read by every role.

Other doc surfaces (`docs/DOGFOOD_PLAYBOOK.md`, `docs/MCP-QUICKSTART.md`, `specs/subagent-orchestration.md`, `specs/coordinator-delegation-via-convoy-spec.md`) carry the same residue but are out of scope for this PR — they get a follow-up doc sweep.

## In scope for this PR (Slices A-D)

### Slice A — `spawn_subtask` addressing

Make `spawn_subtask` accept three addressing axes, with the role lookup as the documented primary path:

- `role: 'builder' | 'tester' | ...` — looks up the workspace's primary role-template agent for that role.
- `peer_agent_id: '<MC UUID>'` — direct lookup by MC agent row id.
- `peer_gateway_id: '<gateway id>'` — back-compat (now mostly useful for addressing the workspace PM or the org runner). When the value is `'mc-runner'` / `'mc-runner-dev'`, the workspace filter is dropped so the org-global runner resolves from any workspace.

Exactly one of the three must be supplied. The internal lookup resolves to an MC agent row (with `id`, `role`, optional `gateway_agent_id`), then the rest of the existing flow (`spawnDelegationSubtask` → `internalDispatch`) runs unchanged.

Error messages updated:
- `peer_not_found` includes a hint: "Try `role: '<builder|tester|...>'` or `list_peers` to see addressable peers."
- The current `peer_not_in_workspace` error becomes a Runner-specific guard (cleaner branch when stale role-bound rows do still exist).

### Slice B — `list_peers` + coordinator dispatch roster

`list_peers` response gains per-peer flags (additive — existing fields kept):

```json
{
  "peers": [
    {
      "id": "...", "gateway_agent_id": null, "name": "Grace ...", "role": "builder",
      "dispatchable": true,
      "addressing": { "role": "builder", "peer_agent_id": "<uuid>" },
      "is_workspace_pm": false,
      "is_org_runner": false
    },
    {
      "id": "...", "gateway_agent_id": "mc-pm-default-dev", "name": "MC PM ...", "role": "pm",
      "dispatchable": false,
      "addressing": { "peer_gateway_id": "mc-pm-default-dev", "peer_agent_id": "<uuid>" },
      "is_workspace_pm": true,
      "is_org_runner": false
    }
  ]
}
```

`dispatchable=true` means the peer is delegable via `spawn_subtask` (role template). PM and runner are mailable but not delegable.

Coordinator dispatch roster ([src/app/api/tasks/[id]/dispatch/route.ts:567-592](../src/app/api/tasks/[id]/dispatch/route.ts)):

- Drops the `gateway_agent_id IS NOT NULL` filter.
- Includes role templates in the listed roster.
- Includes the org-global runner regardless of caller's workspace (`workspace_id = ? OR (gateway_agent_id IN ('mc-runner','mc-runner-dev'))`).
- Marks each row with its addressing axis in the rendered markdown so the coordinator knows whether to spawn_subtask or send_mail.

### Slice C — Doc rewrites (coordinator + shared)

- [agent-templates/coordinator/SOUL.md](../agent-templates/coordinator/SOUL.md): rewrite "Discover peers" step to lead with role-based addressing. Drop the "gateway_id ↔ MC agent_id" framing.
- [agent-templates/coordinator/AGENTS.md](../agent-templates/coordinator/AGENTS.md): update `spawn_subtask` contract example to use `role: 'builder'`. Keep a short note that `peer_agent_id` and `peer_gateway_id` are also accepted for direct addressing / back-compat.
- [agent-templates/_shared/messaging-protocol.md](../agent-templates/_shared/messaging-protocol.md): update the spawn_subtask example shape. The paragraph framing at line 7 (workspace PM + org runner; everything else ephemeral on the runner) is already correct — leave it.

### Slice D — Sweep stale gateway-synced rows

Extend `syncGatewayAgentsToCatalog` so that rows with `source='gateway'` whose `gateway_agent_id` no longer appears in the openclaw list **and** doesn't match the canonical patterns (`mc-pm-*`, `mc-runner`, `mc-runner-dev`) are marked `status='offline'`. Don't delete (FK preservation; operator might be debugging history).

Stale rows like `mc-builder-rr-s2-dev` from the old model will be marked offline on the next sync. Once offline, they're filtered out of `pickDynamicAgent` and the coordinator roster.

## Out of scope (follow-ups)

- **Session-role authz plumbing** (Tier 2 #6) — needs a richer briefing→authz channel and is larger surgery. File as a follow-up issue.
- **Briefing variable safety guard** (Tier 2 #7) — small but unrelated; do as standalone PR.
- **Schema CHECK constraint for runner workspace_id** (Tier 2 #8) — needs a migration; nice-to-have.
- **Other doc surfaces** (Tier 3 — DOGFOOD, MCP-QUICKSTART, specs/subagent-orchestration, specs/coordinator-delegation-via-convoy-spec): doc sweep PR; mechanical once Slice C lands as the canonical reference.
- **Authz: reject spawn_subtask from a runner session not in coordinator mode**: belongs with #6.

## Test plan

- `npx tsc --noEmit` — must pass.
- `yarn test` — full suite; inventory any pre-existing failures up front.
- Targeted: any existing tests for `spawn_subtask`, `list_peers`, `agent-catalog-sync`. Add coverage for the new addressing axes (role / peer_agent_id) and the runner workspace-filter exemption.
- Manual smoke: dispatch a coordinator-shaped task in dev MC (`:4010`), confirm coordinator briefing now lists role templates and that `spawn_subtask({ role: 'builder', … })` resolves and dispatches.

## Migration / back-compat notes

- `spawn_subtask` keeps `peer_gateway_id` accepted. Existing coordinator transcripts and integration tests that pass it continue to work; they only resolve cleanly for PM / runner / any remaining stale role-bound rows (which Slice D will sweep offline).
- `list_peers` response is additive — existing consumers see the same fields plus new ones.
- Slice D's offline sweep is conservative (no deletes). A row marked offline by mistake can be unstuck by recreating the gateway agent in openclaw and re-syncing.

## Implementation order

1. Slice A (`spawn_subtask`) — unblocks coordinator delegation. Smallest blast radius.
2. Slice B (`list_peers` + dispatch roster) — makes the new addressing discoverable.
3. Slice C (docs) — teach the coordinator the new shape.
4. Slice D (sync sweep) — cleans the lingering stale rows so error messages stop being misleading.

Each slice is its own commit. PR opens after Slice D + typecheck/tests pass.
