# Baseline Observations — Pre-Phase-A

> **Purpose:** State of the dev environment as of the spec's authoring,
> captured for diff against later milestone runs. Read-only snapshot —
> no DB modifications, no destructive commands, no interruption to the
> live dev session.

> **Captured:** 2026-05-02 evening. Before any phase of
> [`scope-keyed-sessions.md`](../scope-keyed-sessions.md) lands.

---

## 1. Live dev DB state

### Workspaces
| id | name | slug |
|---|---|---|
| `default` | Default Workspace | `default` |
| `1286dad1-b106-4c2a-9603-20a88add16d0` | FOIA | `foia` |

### Agent rows (the ambiguity surface)

`mc-runner-dev` exists in the `default` workspace only. The user
created it for this work. **Critical:** `mc-runner-dev` does NOT yet
exist in any other workspace, which means the spec can land Phase F
without having to clean up cloned-runner duplicates.

The other gateway-synced agents (`mc-builder-dev`, `mc-coordinator-dev`,
`mc-tester-dev`, `mc-reviewer-dev`, `mc-writer-dev`, `mc-researcher-dev`,
`mc-learner-dev`, `mc-project-manager-dev`) exist as expected: one row
per workspace per gateway agent. The `mc-project-manager-dev` row
exists in **both** `default` and FOIA workspaces — this is the
ambiguity that drove this morning's PM Chat bug.

Counts:
- `default` workspace: 18 agent rows (8 dev + 8 prod variants + `mc-runner-dev` + `main`).
- `FOIA` workspace: 9 agent rows (8 dev variants + `main`).

After Phase F the table should collapse to:
- `mc-runner-dev` × 1 (default workspace)
- `Project Manager` × 2 (one per workspace, `is_pm=1`, `gateway_agent_id=NULL`)

That's it. Everything else gets nulled `gateway_agent_id` and the
catalog sync stops re-creating them.

### Initiatives

| Workspace | Count |
|---|---|
| `default` | 71 |
| `foia` | 11 |

The FOIA tree (11 initiatives) matches the structure the seed fixture
recreates in [`scripts/seed-foia-fixture.ts`](../../scripts/seed-foia-fixture.ts):
1 milestone, 1 epic, 8 stories, 1 sibling story.

### Migrations head

Latest applied: `063_pm_proposals_decompose_story_trigger_kind`.

Phase A lands migrations 064–068 (per spec Appendix B):
- 064 agent-role-overrides
- 065 agent-notes
- 066 mc-sessions
- 067 recurring-jobs
- 068 coordinator-mode

---

## 2. MCP tool surface (current)

Existing tools that survive the refactor unchanged:
- `whoami`, `propose_changes`, `log_activity`, `register_deliverable`
- `update_task_status`, `save_checkpoint`, `send_mail`, `fetch_mail`
- `list_peers`, `get_task`, `propose_from_notes`, `refine_proposal`
- `spawn_subtask`, `cancel_subtask`, `accept_subtask`, `reject_subtask`

Tools added by Phase A:
- `take_note`, `read_notes`, `mark_note_consumed`, `archive_note`

No tools are deprecated by the spec. `spawn_subtask` survives but its
target peers shift from durable gateway agents to scope-keyed sessions
on `mc-runner-dev`.

---

## 3. Test suite state

`yarn test` last reported green from this morning's `pm.test.ts` run
(25/25 passing) after the identity-preamble fix landed. Pre-existing
TypeScript errors in `pm-decompose.test.ts:169` and
`pm-decompose.test.ts:173` are tracked, unrelated, and acceptable per
CLAUDE.md.

`yarn tsc --noEmit` total error count: **2** (the same two). The new
`scripts/seed-foia-fixture.ts` typechecks clean.

---

## 4. Openclaw workspace inventory

User-visible at `~/.openclaw/workspaces/`:
- 18 directories total.
- 8 role-specific workspace pairs (`mc-{role}` and `mc-{role}-dev`).
- `mc-runner` and `mc-runner-dev` (created by user for this work).
- Shared docs at workspace-root level: `MEMORY-ORG.md`,
  `MESSAGING-PROTOCOL.md`, `SHARED-RULES.md` — symlinked into each
  agent workspace.

`mc-runner-dev/` currently contains a *verbatim copy* of
`mc-project-manager-dev/`'s SOUL/AGENTS/IDENTITY (PM-flavored, "Margaret
Hamilton"). This needs neutralization in Phase C — replaced with the
generic host docs from `agent-templates/runner-host/`.

`mc-runner-dev/MC-CONTEXT.json` reports `my_gateway_id: mc-project-manager`
— a leftover from the copy. Should self-heal on the first dispatch
under the new architecture (MC writes this file). Non-blocking.

---

## 5. The PM Chat bug (this morning's fix)

Confirmed fixed by [`pm-dispatch.ts:140 buildIdentityPreamble`](../../src/lib/agents/pm-dispatch.ts:140).
The dispatch now embeds:
```
Your agent_id is: <UUID>
Your gateway_agent_id is: mc-project-manager-dev
```

The agent skips the `whoami` round-trip entirely. Test coverage in
[`pm.test.ts:357`](../../src/lib/agents/pm.test.ts:357) asserts the
preamble appears in every dispatch.

This means the validation pack's regression scenario S10.1 should pass
on the current commit. (It hasn't been executed yet — it'll run when
Phase A lands and the full plan goes green for the first time.)

---

## 6. Risk inventory at start of build

| Risk | Mitigation in spec | Phase landing |
|---|---|---|
| Dual writes during phase A→B transition (old + new dispatch paths) | Feature flag per phase | A onward |
| Test workspace pollution from real-agent runs | Validation pack pre-check wipes DB | every milestone |
| Notes table growth | 90d archival pass, indexed by recent-time | F follow-up |
| Trajectory file growth (recurring jobs) | After 5 compactions, mint new attempt key | E |
| Briefing length overflow | Hard cap, oldest-first truncation, p95 metric | B |
| Notes spam | Rubric-scored against rate; tighten addendum | C |
| Operator note-fatigue | importance levels, filter chips on `/feed` | D |
| Real-agent flake | up to 3 retries, FLAKE marker, 90min wall-clock | every milestone |
| Pre-existing pm-decompose typecheck errors | Excluded from gates | already noted in CLAUDE.md |

---

## 7. Open work hand-off

**Tonight's deliverables (this commit):**
- [x] [`specs/scope-keyed-sessions.md`](../scope-keyed-sessions.md) — full spec, 804 lines.
- [x] [`specs/scope-keyed-sessions-validation/01-pre-check-initialization.md`](01-pre-check-initialization.md) — destructive runbook for fresh-state setup.
- [x] [`specs/scope-keyed-sessions-validation/02-test-plan.md`](02-test-plan.md) — concrete dispatch scenarios per role.
- [x] [`specs/scope-keyed-sessions-validation/03-validation-criteria.md`](03-validation-criteria.md) — pass/fail per scenario + global gates.
- [x] [`scripts/seed-foia-fixture.ts`](../../scripts/seed-foia-fixture.ts) — idempotent FOIA tree fixture for tests.
- [x] [`specs/scope-keyed-sessions-validation/00-baseline-observations.md`](00-baseline-observations.md) — this file.

**For morning review:**
1. Read the spec — push back on anything that's wrong; the design is
   not yet locked in code.
2. Read the validation pack — confirm the scenarios cover what you
   actually need to feel confident shipping.
3. Decide: green-light Phase A implementation, or iterate the spec
   first.

**What I did NOT do tonight:**
- Did not run the destructive pre-check (would have wiped your live
  PM Chat dev session).
- Did not start Phase A implementation (waiting for green light).
- Did not run the LLM-as-judge eval harness (doesn't exist yet — it's
  built in Phase B).
- Did not push or open a PR.

**What I'm ready to do once green-lit:**
- Spawn worktree subagents in parallel for Phase A's slices (migrations,
  MCP tools family, agent-templates/ seed, briefing builder skeleton).
- Run the pre-check + test plan + validation criteria after each slice.
- Halt and surface any FAIL or unexpected behavior, per
  [`03-validation-criteria.md`](03-validation-criteria.md) §halt-criteria.

The validation pack is intentionally over-specified for Phase A
(many scenarios will be N/A until later phases implement the
underlying flow). Per spec §6.1, each phase activates more rows in the
applicability matrix in [`03-validation-criteria.md`](03-validation-criteria.md);
gate thresholds themselves don't change between phases.
