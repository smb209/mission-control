# MCP surface v2 — build plan

Companion to [`mcp-surface-review.md`](./mcp-surface-review.md). The spec carries the **why**; this doc carries the **how/order/test-strategy**. Validation pack lives at [`mcp-surface-v2-validation/`](./mcp-surface-v2-validation/).

## Audit (state at branch-cut)

- 47 MCP tools registered globally via `src/lib/mcp/server.ts → buildServer()` calling `registerAllTools` (24 in `tools.ts`) + `registerRoadmapTools` (23 in `roadmap-tools.ts`).
- One route: `/api/mcp` (`src/app/api/mcp/route.ts`). Both PM and runner mount it. PM-only tools (`propose_changes`, etc.) are visible to every persona today.
- Existing operator-facing scripts in this neighborhood: `yarn openclaw:sync` (`scripts/sync-openclaw-agents.mjs`), `yarn workspace:provision` (`scripts/provision-workspace-runner.ts`), `yarn runner-host:reseed` (`scripts/neutralize-runner-host.ts`). The two new tools (PR 3, PR 3.5) live alongside.
- `instrumentation.ts` already starts the recurring scheduler + DB backup loop. No additional wiring required for this work.
- `agent-templates/_shared/messaging-protocol.md` is referenced by every role-specific AGENTS.md as the canonical tool list. PR 4 / PR 5 must edit it in lockstep with the code change.
- Named gateway agents (PM, runner-host) read AGENTS.md / SOUL.md / IDENTITY.md from `~/.openclaw/workspaces/mc-{role}-{dev,stable}/` at session start — physical files, not MC's briefing pipeline. PR 3.5 closes that staleness gap.

## Design decisions

**1. Group split: by *audience*, not by surface area.** Files: `core` (universally needed), `read` (read-only roadmap), `work` (worker write tools), `pm` (proposal toolkit), `crud` (operator-direct mutations). Reversibility: trivial — refactor only, no schema or DB change.

**2. Default `/api/mcp` keeps the union.** The default route imports every group. No agent loses tools at PR 1 / PR 2 land. The token savings are realized at PR 3 (operator points PM at `/api/mcp/pm`). Reversibility: roll back the openclaw.json edit, PM is back to full surface.

**3. CRUD tools parked, not deleted.** Future direct-edit agents may want them. Cost is 8 tool registrations on a route nobody mounts by default. Reversibility: trivial.

**4. Action-discriminator over discriminated-union for the consolidations.** `update_subtask({action})` and `update_note({action})` use a string `action` enum (not Zod's `discriminatedUnion`) because the per-action argument shape barely diverges. Keeps the JSON schema legible and the agent decision tree simple. `propose_changes`'s `PmDiff` stays a true discriminated union because per-kind shapes are genuinely different.

**5. Hard rename on consolidations.** Per spec decision-log item 2: in-flight sessions get cleared, no shims. Old tool names disappear at PR 4 / PR 5 land.

**6. Named-agent sync uses MC's briefing-builder composition order.** The PR 3.5 script imports the same composition function MC's dispatch pipeline uses for runner-hosted personas. Single source of truth.

## Slice plan

| PR | Branch | Base | Scope | Files (rough) | Becomes testable |
|---|---|---|---|---|---|
| 1 | `feat/mcp-groups-refactor` | main | Move tools into `src/lib/mcp/groups/{core,read,work,pm,crud}.ts` + `buildServer(groups[])` factory | `src/lib/mcp/{groups/*.ts,server.ts,tools.ts→removed,roadmap-tools.ts→removed}` | Existing MCP test suite still green; tool list unchanged on `/api/mcp` |
| 2 | `feat/mcp-routes-pm-crud` | PR 1 | New `/api/mcp/pm`, `/api/mcp/crud`; rewrite pm/SOUL.md line 32 | `src/app/api/mcp/{pm,crud}/route.ts`, `agent-templates/pm/SOUL.md` | Curl shows 16-tool PM endpoint, 16-tool CRUD endpoint; default route still 47 |
| 3 | `feat/openclaw-apply-mc-servers` | PR 2 | `scripts/apply-mc-servers.ts` + `package.json` script | scripts + small declarative config | `yarn openclaw:apply-mc-servers --dry-run` reports the diff to be applied; live run rewrites openclaw.json idempotently |
| 3.5 | `feat/openclaw-sync-named-agents` | PR 3 | `scripts/sync-named-agent-workspaces.ts` + script entry | scripts + briefing-builder import | `yarn openclaw:sync-named-agents --dry-run` shows expected diffs; live run brings PM/runner workspace files in line with `_shared` |
| 4 | `feat/update-subtask` | PR 3.5 | New `update_subtask`; remove `accept/reject/cancel_subtask`; update coordinator templates + messaging-protocol | `src/lib/mcp/groups/work.ts`, `agent-templates/coordinator/{SOUL,AGENTS}.md`, `agent-templates/_shared/messaging-protocol.md`, `src/app/api/tasks/[id]/dispatch/route.ts`, mcp.test.ts | New tool exposed at `/api/mcp` + `/api/mcp/pm` if applicable; coordinator dispatches use new tool |
| 5 | `feat/update-note` | PR 4 | New `update_note`; remove `mark_note_consumed` + `archive_note`; add `consume` guidance to `_shared/notetaker.md` + `messaging-protocol.md` | `src/lib/mcp/groups/core.ts`, `agent-templates/_shared/{messaging-protocol,notetaker}.md`, `agent-templates/runner-host/AGENTS.md`, mcp.test.ts | Notes can be consumed/archived via the unified tool |
| 6 | `docs/mcp-discriminated-union` | PR 5 | Doc-only: PM SOUL + spec stating "extend `propose_changes`, don't add new tools" | `agent-templates/pm/SOUL.md`, `docs/archive/mcp-surface-review.md` | n/a |

## Test strategy per slice

- **PR 1**: `yarn test` (full suite); `mcp.test.ts` validates tool count and per-tool registration. Same 47 tools after refactor.
- **PR 2**: extend `mcp.test.ts` with route-scoped tests asserting `/api/mcp/pm` returns the PM subset, `/api/mcp/crud` returns the CRUD subset, default route unchanged. Curl smoke documented in PR body.
- **PR 3**: unit test for `applyMcServers()` covering dry-run vs apply; idempotence (run twice, second is a no-op); dev/stable variant pass.
- **PR 3.5**: unit test that recompose produces byte-identical output to MC's briefing builder for runner-hosted personas, then asserts the file write is gated on diff. Mock `~/.openclaw/workspaces/` via a fixture dir.
- **PR 4**: replace existing `accept/reject/cancel_subtask` test cases with `update_subtask({action})` cases. Coordinator dispatch e2e (validation V4).
- **PR 5**: replace existing note-lifecycle test cases with `update_note({action})` cases. Note consume/archive e2e (validation V5).
- **PR 6**: doc-only, no tests.

## Validation gates (real-agent dispatches)

Detailed in `mcp-surface-v2-validation/02-test-plan.md`. Summary:
- **V1** PM dispatch lists tools after PR 2/3 → expect ~16 tools, no `register_deliverable` etc.
- **V2** Runner-hosted persona dispatch still has full surface (`/api/mcp` default).
- **V3** PR 3.5 sync brings PM workspace AGENTS.md in line with `_shared/messaging-protocol.md` after a deliberate edit; idempotent on second run.
- **V4** Coordinator dispatch uses `update_subtask` (real OpenClaw against `spark-lb/agent`).
- **V5** Worker dispatch consumes/archives a note via `update_note`.
- **V6** PM `propose_changes` flow unaffected by the route split — dispatch a small proposal end-to-end.

Per `project_openclaw_model.md` all real-agent dispatches use `spark-lb/agent`.

## Open questions

1. **Where are MC's briefing-builder composition rules?** Need to grep `src/lib/agents/briefing.ts` or similar at PR 3.5 start to confirm the import target. Listed as PR 3.5 first task.
2. **`agent_role_overrides` for PM/runner-host?** Need to check at PR 3.5 whether per-workspace overrides exist for the named agents and how they should interact with the sync (override wins / sync warns / sync skips).

## Out of scope

- Initiative dependency tool merge (`add_/remove_initiative_dependency`) — deferred per spec.
- Anthropic MCP Tool Search / lazy loading.
- Code-execution wrapping pattern.
- Per-session tool injection.
- Any change to the `propose_changes` discriminated union — extension policy is "do nothing until threshold."

## Cost ceiling

Real-agent model `spark-lb/agent` (self-hosted, no budget concern per `project_openclaw_model.md`). Expected total real-agent dispatches across V1–V6: ~12–15 (each scenario plus 1–2 retries on flake).
