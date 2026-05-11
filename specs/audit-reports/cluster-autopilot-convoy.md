# Cluster: Autopilot / Convoy / Orchestration

## Verdict table

| Spec | Class | 1-line rationale | Key evidence |
|------|-------|-----------------|--------------|
| agent-health-overhaul-spec.md | 2 (aspirational) | Health/escalation core shipped, but most named tables/columns (`dispatch_token`, `session_alive`, `is_system`, `last_real_activity_at`) never landed | `src/lib/db/migrations.ts` greps return zero hits; `src/lib/agent-health.ts:49,60` does have stalled/stuck/zombie semantics |
| autopilot-build-pipeline-spec.md | 3 (drift) | Migration ships `build_mode` not `build_automation`; per-task `cost_cap_*` columns missing on tasks; spec preceded simpler implementation | `migrations.ts:1244` `build_mode TEXT … ('auto_build','plan_first')`; `autopilot/swipe.ts:294` reads `build_mode` |
| autopilot-resilience-and-activity-feed.md | 1 (current) | `research_cycles` phase columns + `ideation_cycles` table shipped as specified | `migrations.ts:1177-1212` (phase, phase_data, session_key, last_heartbeat); `autopilot/recovery.ts` exists |
| convoy-mode-spec.md | 2 (aspirational) | Convoy primitives + tables + UI shipped; "checkpoint persistence", inter-agent mailboxes-as-broadcast, and decomposition-during-planning are partial | `migrations.ts:679-819` (convoys, convoy_subtasks, agent_health, work_checkpoints, agent_mailbox); `src/lib/convoy.ts:219` `checkConvoyCompletion`; spawn_subtask supersedes most of §7 |
| coordinator-delegation-via-convoy-spec.md | 1 (current) | Shipped: `spawn_subtask` exists, `delegate` removed, UNIQUE on `convoys.parent_task_id` dropped | `mcp/groups/work.ts:1146` `spawn_subtask`; `mcp/mcp.test.ts:90` asserts delegate is gone; `migrations.ts:2081-2118` drops UNIQUE |
| parallel-build-isolation-spec.md | 1 (current) | `workspace_path`, `workspace_strategy` columns + `workspace-isolation.ts` shipped and strict-mode enforced per #118 | `migrations.ts:1303-1307`; `workspace-isolation.ts:108,178` |
| product-autopilot-spec.md | 2 (aspirational) | Phase 1 & 2 mostly shipped (products, ideas, swipes, research/ideation cycles, learning, cost caps). Phase 3 ops + Phase 4 full-loop are aspirational | `migrations.ts:832-1101` shipped most schema; no shipped `operations_log` driver; `autopilot/products.ts,research.ts,ideation.ts,swipe.ts` |
| subagent-orchestration.md | 2 (aspirational) | No `spawn_subagent` MCP tool, no `subagent_runs` table; only the lower-level `dispatch-subagent.ts` primitive (Phase J1 skeleton) exists | `agents/dispatch-subagent.ts:1-30` says "J1 ships the primitive without wiring it"; no migration column matches |
| autonomous-flow-tightening-spec.md | 1 (current) | All 7 implementation slices landed (PRs #114–#120, migrations 058–060) | `migrations.ts:3473,3513,3540` (task_evidence, is_failed, runtime_kind); `mcp/groups/work.ts:404` submit_evidence; role souls present `agents/{builder,tester,reviewer}-soul.md` |
| autonomous-flow-validation-plan.md | 4 (historical) | One-shot validation pass over PRs #113–#120 already merged 2026-04-30; archive | doc body explicitly says "all merged into main on 2026-04-30" |

## Per-spec notes

### agent-health-overhaul-spec.md
- Spec claims: migration `add_health_overhaul` adds `last_real_activity_at` on agent_health, `is_system` on task_activities, `dispatch_token`/`dispatch_token_expires_at` on tasks, `last_checked_at`/`session_alive` on openclaw_sessions, plus a session-liveness monitor and recovery_attempts table.
- Code reality: none of those columns appear in `src/lib/db/migrations.ts` (grep returns zero). `src/lib/agent-health.ts:49,60` does implement stalled/stuck/zombie states and a comment alludes to filtering "health check logs," but via timestamp logic, not an `is_system` flag. No task-scoped dispatch tokens.
- Recommendation: update spec to reflect the smaller surface actually shipped (timestamps + escalation in `agent-health.ts`) and drop the unshipped DB layer, or archive if the milder design was an intentional pivot.
- Cross-cluster: overlaps with autonomous-flow-tightening (FM1 evidence gates) and convoy-mode §8.

### autopilot-build-pipeline-spec.md
- Spec says: products gets `build_automation TEXT … ('supervised','semi_auto','full_auto')`, `build_agent`, `cost_cap_per_task`, `cost_cap_monthly`.
- Code does: `migrations.ts:1244` ships `build_mode TEXT … ('auto_build','plan_first')`; cost caps live in a separate `cost_caps` table (`migrations.ts:985`), not as task columns. `tasks` did get `repo_url`, `repo_branch`, `pr_url`, `pr_status` (`migrations.ts:1263+`).
- Recommendation: update spec to current names or annotate as drifted.
- Cross-cluster: overlaps with product-autopilot-spec §3.

### autopilot-resilience-and-activity-feed.md
- Spec phases + columns match `migrations.ts:1176-1212` exactly. `autopilot/recovery.ts` implements the startup recovery routine.
- Recommendation: keep.

### convoy-mode-spec.md
- Shipped: tables, statuses (`convoy_active`), checkConvoyCompletion, agent_mailbox, work_checkpoints, agent_health.
- Aspirational / drifted: §7 task-decomposition path is now superseded by coordinator-delegation-via-convoy (`spawn_subtask`). §9 work-state checkpoints have a table but light driver use. §10 inter-agent mailboxes have a table but the active surface is `send_mail` + `rollcall_entries`.
- Recommendation: mark "partially superseded by coordinator-delegation-via-convoy-spec.md" at top; trim §7.
- Cross-cluster overlap: coordinator-delegation-via-convoy-spec, autonomous-flow-tightening (workspace isolation, evidence gates).

### coordinator-delegation-via-convoy-spec.md
- Implementation matches: `spawn_subtask` (work.ts:1146), `delegate` removed (mcp.test.ts:90), UNIQUE drop in migration (`migrations.ts:2110-2118`). `checkConvoyCompletion` exists (`convoy.ts:219`).
- Recommendation: keep as canonical.

### parallel-build-isolation-spec.md
- Workspace columns exist on tasks (`migrations.ts:1303-1307`), `workspace-isolation.ts` ships strategy detection + `createTaskWorkspace`, autonomous-flow-tightening #118 made this strict.
- Recommendation: keep, optionally annotate "strict mode enforced via autonomous-flow-tightening #118."

### product-autopilot-spec.md
- Phase 1 (products, ideas, swipes, cycles, costs, schedules) all in `migrations.ts:832-1101`. Phase 2 preference_models, maybe_pool, learning signals all present.
- Aspirational: Phase 3 (post-launch ops, content_inventory, social_queue, seo_keywords) — tables exist (`migrations.ts:1020-1097`) but no shipped operation drivers in `autopilot/` (no ops scheduler beyond `scheduling.ts`). Phase 4 full-loop unimplemented.
- Recommendation: split into "Phase 1-2 (shipped)" and "Phase 3-4 (aspirational)" sections; remove redundancy with autopilot-build-pipeline-spec.
- Cross-cluster overlap: autopilot-build-pipeline-spec, convoy-mode-spec §integration.

### subagent-orchestration.md
- Spec claims: new `spawn_subagent` and `submit_subagent_report` MCP tools, `subagent_runs` table, ephemeral agent identity.
- Code reality: zero hits for `spawn_subagent` or `subagent_runs` across `src/`. Only `agents/dispatch-subagent.ts` exists and its own header says "J1 ships the primitive without wiring it into the dispatch route."
- Recommendation: keep as aspirational; reference `dispatch-subagent.ts` as the partial groundwork.

### autonomous-flow-tightening-spec.md
- Every slice has corresponding shipped code: `task_evidence` migration 058, `is_failed` 059, `runtime_kind` 060; `submit_evidence` tool at `work.ts:404`; role souls at `agents/{builder,tester,reviewer}-soul.md`; ACL widening visible in `mcp/groups` patterns. Rollcall propagation via `formatPendingRollcallsForDispatch` (`rollcall.test.ts:2`).
- Recommendation: keep; this is the load-bearing recent spec.

### autonomous-flow-validation-plan.md
- One-shot validation pass for already-merged PRs (#113–#120 merged 2026-04-30). Useful as historical record.
- Recommendation: move to `specs/archive/` (or annotate "completed").

## Cross-cluster overlap flags

- **agent-health-overhaul + convoy-mode §8 + autonomous-flow-tightening**: three specs all touch stall/stuck escalation. autonomous-flow-tightening is the only one whose design fully landed.
- **autopilot-build-pipeline + product-autopilot §3**: same product-table/task-table schema additions described twice with diverging column names (`build_automation` vs `build_mode`). Merge target = product-autopilot.
- **convoy-mode §7 + coordinator-delegation-via-convoy**: coordinator-delegation explicitly supersedes §7; convoy-mode-spec should link out.
- **subagent-orchestration + coordinator-delegation-via-convoy**: both describe "parent fans out to children." Subagent is read-only/distill; convoy is full task lifecycle. Distinct but should cross-reference.

## Consolidation suggestions

1. **Archive** `autonomous-flow-validation-plan.md` (one-shot, done).
2. **Merge** `autopilot-build-pipeline-spec.md` into `product-autopilot-spec.md` Phase 1 — pick `build_mode` naming; delete duplicate schema.
3. **Annotate** `convoy-mode-spec.md` and `agent-health-overhaul-spec.md` with "superseded in part by autonomous-flow-tightening / coordinator-delegation-via-convoy."
4. **Rewrite** `agent-health-overhaul-spec.md` to the actually-shipped surface or archive it; the drift is large enough to be misleading.
5. **Mark** `subagent-orchestration.md` as aspirational with a pointer to `agents/dispatch-subagent.ts` (Phase J1) as the only landed code.
