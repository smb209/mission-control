# Validation Criteria — Scope-Keyed Sessions

> **Purpose:** Pass/fail criteria for the dispatch scenarios in
> [`02-test-plan.md`](02-test-plan.md). Per-scenario gates plus
> global gates. A milestone passes only if ALL gates pass.

> **Use:** after running the test plan, compute results against this
> file. The output is a single READY-TO-MERGE / NOT-READY judgment.

---

## How to read this document

Each scenario has a gates table. Gates are AND-ed within a scenario.
Scenarios are AND-ed within the global gate set. **All must pass.**

A scenario is allowed to be marked `N/A` only when:
- The phase under test does not implement the scenario yet (e.g., S6
  Recurring jobs is N/A pre-Phase-E).
- The scenario depends on another that already FAILed (cascading skip).

`FLAKE` (intermittent) scenarios must be re-run up to 3 times. If 2/3
pass, mark `PASS`. If 0/3 or 1/3 pass, mark `FAIL`.

---

## §1 Disruption — gates

### S1.1 Owner-out disruption

| Gate | Threshold |
|---|---|
| G1.1.a Synth placeholder lands | within 2s of POST |
| G1.1.b Agent supersedes | within 60s of synth |
| G1.1.c `add_availability` diff present | exactly 1, agent_id matches Sarah, dates match input |
| G1.1.d Initiative impact diff | ≥1 `set_initiative_status` or `shift_initiative_target` for Sarah's initiative |
| G1.1.e impact_md mentions inputs | "Sarah" + initiative title both substring-present |
| G1.1.f Briefing has identity preamble | regex `Your agent_id is: <UUID>` matches |
| G1.1.g No `ambiguous_gateway_id` errors | grep dev.log: 0 occurrences |
| G1.1.h Notes taken during dispatch | ≥1 `agent_notes` row with matching scope_key |

### S1.2 Disruption with no actionable content

| Gate | Threshold |
|---|---|
| G1.2.a Synth placeholder lands | within 2s |
| G1.2.b Agent supersedes (or marks synth_only) | within 90s |
| G1.2.c No timeout regression | dispatch did not stall past 60s + 60s tail |
| G1.2.d Final state | dispatch_state ∈ {`agent_complete`, `synth_only`} — never `pending_agent` after timeout |

### S1.3 Refine

| Gate | Threshold |
|---|---|
| G1.3.a Refined proposal lands | within 60s |
| G1.3.b parent_proposal_id matches S1.1 | exact match |
| G1.3.c Constraint reflected | Discovery target_end unchanged AND a different initiative shifted |
| G1.3.d Same scope_key | refined dispatch reuses S1.1's `mc_sessions.scope_key` (continuity) |

---

## §2 Plan a draft initiative — gates

### S2.1 First plan

| Gate | Threshold |
|---|---|
| G2.1.a Proposal lands | within 60s |
| G2.1.b trigger_kind=`plan_initiative` | exact |
| G2.1.c plan_suggestions complete | all required keys non-null where applicable |
| G2.1.d complexity in {S,M,L,XL} | exact |
| G2.1.e refined_description meaningfully expanded | length ≥ 3× input length |
| G2.1.f proposed_changes empty | `[]` |

### S2.2 Refine twice

| Gate | Threshold |
|---|---|
| G2.2.a Each refine lands | within 60s each |
| G2.2.b parent_proposal_id chain valid | walks back to S2.1 in ≤2 hops |
| G2.2.c All three share planSessionKey | same `mc_sessions.scope_key` |
| G2.2.d Refine 1 honors complexity constraint | result.complexity = 'M' |
| G2.2.e Refine 2 honors dependency constraint | result.dependencies includes Implementation initiative id |

---

## §3 Decompose — gates

### S3.1 Epic decomposition

| Gate | Threshold |
|---|---|
| G3.1.a Proposal lands | within 90s |
| G3.1.b trigger_kind=`decompose_initiative` | exact |
| G3.1.c proposed_changes valid | each `create_child_initiative` has parent_initiative_id matching epic id; valid kind ∈ {epic,story} |
| G3.1.d No hallucinated parent ids | every parent reference resolves in the snapshot |

### S3.2 Story decomposition

| Gate | Threshold |
|---|---|
| G3.2.a Proposal lands | within 90s |
| G3.2.b trigger_kind=`decompose_story` | exact |
| G3.2.c ≥2 task creates | proposed_changes contains ≥2 `create_task_under_initiative` |
| G3.2.d Task descriptions non-trivial | each description ≥50 chars |

---

## §4 Notes intake — gates

### S4.1 Online intake

| Gate | Threshold |
|---|---|
| G4.1.a Proposal lands | within 90s |
| G4.1.b trigger_kind=`notes_intake` | exact |
| G4.1.c Heterogeneous changes | proposed_changes has ≥2 distinct `kind` values |
| G4.1.d Mentions the blocker | impact_md mentions the test fixture blocker from notes |

### S4.2 Offline intake (queue and drain)

| Gate | Threshold |
|---|---|
| G4.2.a MCP returns gateway error | `PmDispatchGatewayUnavailableError` thrown |
| G4.2.b Queue row inserted | `pm_pending_notes` count = 1 |
| G4.2.c Drain after restart | within 90s of gateway restart, queue is empty |
| G4.2.d Resulting proposal lands | within 90s of gateway restart |

---

## §5 Task dispatch — gates

### S5.1 Builder dispatch

| Gate | Threshold |
|---|---|
| G5.1.a Status transitions | assigned → in_progress → review (or testing per workflow) |
| G5.1.b Notes count | ≥3 `agent_notes` rows tagged with builder's scope_key |
| G5.1.c Note kind diversity | ≥1 `kind ∈ {discovery, decision}` AND ≥1 `kind=breadcrumb` |
| G5.1.d audience='next-stage' present | ≥1 breadcrumb has `audience='next-stage'` |
| G5.1.e Deliverables registered | ≥1 `task_deliverables` row |
| G5.1.f activity_type='completed' before transition | log_activity row with that type precedes the status transition |
| G5.1.g Briefing includes notetaker addendum | regex `obsessive notetaker` matches in dispatch message |
| G5.1.h Identity preamble | regex `Your agent_id is:` matches |

### S5.2 Tester dispatch

| Gate | Threshold |
|---|---|
| G5.2.a Reads prior notes | ≥1 `read_notes` MCP call observed |
| G5.2.b mark_note_consumed called | ≥1 such call (count must equal at least the breadcrumbs from S5.1) |
| G5.2.c Tester takes own notes | ≥2 new `agent_notes` rows tagged with tester scope_key |
| G5.2.d Status transitions to review | exact |

### S5.3 Reviewer rejection

| Gate | Threshold |
|---|---|
| G5.3.a Reviewer reads notes | ≥1 read_notes call |
| G5.3.b Reviewer takes blocker note | ≥1 `kind=blocker` or `decision` note |
| G5.3.c Status reverts to in_progress | exact |
| G5.3.d Failure reason captured | non-empty status_reason |

### S5.4 Builder retry (Q3 sample)

| Gate | Threshold |
|---|---|
| G5.4.a New session per attempt_strategy | per `agent_role_overrides.attempt_strategy` |
| G5.4.b Briefing includes reviewer's blocker | regex match in dispatch message |
| G5.4.c Second attempt completes | reaches review status |
| G5.4.d No infinite loop | total attempts ≤3 in this scenario |

**Q3 metrics captured (not gates):** time-to-deliverable per strategy,
note count per strategy, repeat-approach rate per strategy. These feed
the spec's appendix decision; they are *informational*, not pass/fail.

---

## §6 Recurring jobs — gates

### S6.1 Two compressed runs

| Gate | Threshold |
|---|---|
| G6.1.a Run 1 fires | within 5s of trigger |
| G6.1.b Run 1 produces note | ≥1 note tagged with run_group_id #1 |
| G6.1.c Run 2 fires on cadence | within 90s of cadence_seconds elapsing |
| G6.1.d Run 2 produces delta note | note body references "new" or numeric count > 0 |
| G6.1.e Same scope_key (reuse) | both runs' notes share scope_key, distinct run_group_ids |
| G6.1.f recurring_jobs.run_count = 2 | exact |

### S6.2 No-op run

| Gate | Threshold |
|---|---|
| G6.2.a Note still produced | ≥1 note `kind=observation`, body not empty |
| G6.2.b No proposal forced | no `pm_proposals` row for this run |

### S6.3 Failure escalation

| Gate | Threshold |
|---|---|
| G6.3.a Each failure registers | `consecutive_failures` increments per run |
| G6.3.b Pause after 3 | status flips to `paused` after exactly 3 consecutive failures |
| G6.3.c PM Chat alert | one assistant-role message in PM chat with `importance: 2` |

---

## §7 Heartbeat coordinator — gates

### S7.1 Active monitoring

| Gate | Threshold |
|---|---|
| G7.1.a 4–5 dispatches in 5min | with cadence=60s |
| G7.1.b Each produces ≥1 note | exact |
| G7.1.c Stalled-task escalation fires | at least 1 `audience=pm` or `importance: 2` note when underlying task hasn't moved in 2 cycles |

### S7.2 Auto-removal

| Gate | Threshold |
|---|---|
| G7.2.a recurring_jobs row updated | status='done' (or row deleted) within 60s of underlying task completion |
| G7.2.b No new dispatches post-completion | grep dev.log: 0 dispatches for the heartbeat scope_key after status='done' |

---

## §8 Notes observability — gates

### S8.1 Task detail rail

| Gate | Threshold |
|---|---|
| G8.1.a SSE event arrives | within 2s of `take_note` |
| G8.1.b UI rail updates | preview_snapshot shows the new note |
| G8.1.c Correct grouping | notes grouped by run_group_id |

### S8.2 Initiative rollup

| Gate | Threshold |
|---|---|
| G8.2.a Note appears on initiative | within 2s |
| G8.2.b Cross-task aggregation works | notes from multiple child tasks appear |

### S8.3 Workspace feed

| Gate | Threshold |
|---|---|
| G8.3.a Feed page exists | HTTP 200 |
| G8.3.b All 5 notes visible | exact |
| G8.3.c Filter chips work | filter by kind shows correct subset |

### S8.4 PM Chat for importance=2

| Gate | Threshold |
|---|---|
| G8.4.a Auto-post fires | within 2s |
| G8.4.b Attribution correct | message contains "(from <role>)" |
| G8.4.c No duplicate post | exactly 1 post per importance=2 note |

### S8.5 Card badges

| Gate | Threshold |
|---|---|
| G8.5.a Live count update | badge increments without page refresh |
| G8.5.b Timestamp updates | latest note's timestamp shown |

---

## §9 Failure modes — gates

| Scenario | Gate | Threshold |
|---|---|---|
| S9.1 Gateway down | dispatch_state='synth_only' | exact, no exceptions thrown |
| S9.2 Gateway recovers | reconciler tries during tail window | grep dev.log for tail-poll log lines |
| S9.3 Briefing overflow | note count ≤ 50 | per dispatch briefing |
| S9.3 Briefing overflow | total chars ≤ 12000 | per dispatch briefing |
| S9.4 Ambiguity stays harmless | dispatch succeeds | terminal state agent_complete |
| S9.4 Ambiguity stays harmless | no `whoami` call | grep mcp.log: 0 occurrences |

---

## §10 Regression — gates

| Scenario | Gate | Threshold |
|---|---|---|
| S10.1 Identity preamble present | regex match | every dispatch message |
| S10.2 Workspace clone | new workspace dispatches successfully | exact |
| S10.3 Workspace switcher | URL preserves page type | exact |
| S10.4 Drawer portal | nested modal not trapped | preview_snapshot |
| S10.5 Catalog sync | both duplicate rows updated | row diff |

---

## Global gates (apply across all scenarios)

These run after all per-scenario gates and apply to the run as a whole.

| ID | Gate | Threshold |
|---|---|---|
| GG1 | No P0 dev log errors | grep `[error]` in /tmp/mc-validation/<phase>/dev.log: 0 occurrences |
| GG2 | No `ambiguous_gateway_id` errors | grep: 0 occurrences |
| GG3 | No unhandled exceptions | grep `unhandledRejection` or `Uncaught`: 0 occurrences |
| GG4 | TypeScript clean | `yarn tsc --noEmit` exit 0 (excluding pre-existing pm-decompose.test.ts noise) |
| GG5 | Test suite green | `yarn test` exit 0; new tests added per phase |
| GG6 | MCP smoke green | `yarn mcp:smoke` exit 0 |
| GG7 | DB row count sanity | total `pm_proposals` rows ≤ scenario count × 4; no runaway proposal generation |
| GG8 | Briefing length p95 | ≤ 12,000 chars (sampled across all dispatches) |
| GG9 | Notes count median | ≥3 per worker dispatch (warns if <2) |
| GG10 | Notes count p95 | ≤30 per dispatch (warns if pathological spam) |
| GG11 | LLM-as-judge note quality | mean rubric score ≥3.5 / 5 (per `specs/evals/scope-keyed-sessions/rubrics/note-quality.md`) |
| GG12 | LLM-as-judge briefing fidelity | mean rubric score ≥3.5 / 5 |
| GG13 | LLM-as-judge handoff cohesion | mean rubric score ≥3.5 / 5 |
| GG14 | Wall-clock budget | full plan completes ≤90 minutes |
| GG15 | No hung sessions | every dispatch reached terminal state (agent_complete or synth_only) |
| GG16 | SSE rate sane | <100 events / second sustained (catches infinite-loop bugs) |
| GG17 | spec.md unchanged | the spec doc was not modified during this run |

---

## Final scoring

The run produces `/tmp/mc-validation/<phase>/SCORECARD.md`:

```markdown
# Validation Scorecard — <phase> — <commit>

## Per-scenario
| Scenario | Status | Notes |
|---|---|---|
| S1.1 | PASS / FAIL / N/A | … |
| S1.2 | PASS / FAIL / N/A | … |
| ... |
| S10.5 | PASS / FAIL / N/A | … |

## Global gates
| ID | Status | Value |
|---|---|---|
| GG1 | PASS / FAIL | <count> |
| ... |

## Q3 informational metrics (not gates)
| Strategy | Time-to-deliverable median | Notes per dispatch | Repeat-approach rate |
|---|---|---|---|
| fresh | … | … | … |
| reuse | … | … | … |

## Verdict
READY-TO-MERGE / NOT-READY — <one-line reason>
```

The verdict is **READY-TO-MERGE** only if:
- All in-scope scenarios pass.
- All global gates pass.
- N/A count ≤ expected for the phase under test.

If verdict is `NOT-READY`, the failing rows + their capture paths are
the morning review's hot list. Halt the autonomous build pipeline until
the operator reviews.

---

## Phase applicability matrix

Which scenarios apply at which phase. Use this to compute legitimate
N/A markings.

| Scenario | Phase A | Phase B | Phase C | Phase D | Phase E | Phase F |
|---|---|---|---|---|---|---|
| S1.* (disruption) | N/A | YES (via dispatchScope) | YES | YES | YES | YES |
| S2.* (plan) | N/A | YES | YES | YES | YES | YES |
| S3.* (decompose) | N/A | YES | YES | YES | YES | YES |
| S4.* (notes intake) | N/A | YES | YES | YES | YES | YES |
| S5.* (worker dispatch) | N/A | N/A | YES | YES | YES | YES |
| S6.* (recurring) | N/A | N/A | N/A | N/A | YES | YES |
| S7.* (heartbeat) | N/A | N/A | N/A | N/A | YES | YES |
| S8.* (observability) | N/A | YES (basic SSE) | YES | YES (full UI) | YES | YES |
| S9.* (failure modes) | N/A | YES (S9.1, S9.2, S9.4) | YES | YES | YES | YES |
| S10.* (regressions) | YES | YES | YES | YES | YES | YES |

Phase-specific additions:

- **Phase A:** must add S0 schema verification (covered in pre-check §2).
- **Phase F:** must add S10.6 — `gateway_agent_id` is NULL on all non-runner rows; `mc-runner-dev` is the sole gateway-bearing agent.

---

## Halt criteria for the autonomous build pipeline

The pipeline halts and pages the operator if any of these fire:

1. Any scenario in the phase's applicability matrix returns `FAIL`.
2. Any global gate `GG1`–`GG6` fails (these are absolute floors).
3. The wall-clock cap (90min) is exceeded by >25%.
4. The same scenario flakes 3 times in a row.
5. Disk usage in `/tmp/mc-validation/` exceeds 5GB (capture files
   accumulating without bound).
6. The dev server crashes mid-plan and doesn't auto-recover.
7. A new `[error]` line in dev.log matches a known-critical pattern
   (`SQLITE_CORRUPT`, `ECONNREFUSED .*:18789`, `unhandledRejection`).

Each halt logs to `/tmp/mc-validation/<phase>/HALT-<timestamp>.md` with
the trigger, captures, and last 200 lines of dev.log.

---

## What changes between phases

The criteria document is intended to be stable across phases (so the
spec doesn't drift mid-build). When a phase implements new
functionality, it activates more rows in the applicability matrix —
gate thresholds themselves don't change.

Two exceptions where thresholds tighten as phases land:
- **GG9 / GG10 (notes count):** Phase C lands the role-soul addendum;
  warns shift to FAILs at Phase D when the notetaker behavior should be
  fully wired.
- **GG11 / GG12 / GG13 (LLM-as-judge scores):** Phase B+ runs the
  harness; threshold ≥3.5 from Phase B; tightens to ≥4.0 at Phase F.

These tightening thresholds are tracked in this file's appendix when
the phase lands; mid-run threshold drift is forbidden.
