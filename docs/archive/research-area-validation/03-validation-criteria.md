# Validation Criteria — Research Area Phase 1

> **Purpose:** Pass/fail gates for [`02-test-plan.md`](02-test-plan.md). Per-scenario gates AND-ed within a scenario; scenarios AND-ed within global gates.
>
> **`FLAKE` policy:** intermittent scenarios re-run up to 3×; pass if ≥ 2/3.

---

## How to read this

Each scenario gate is a single yes/no question. A scenario passes only if all its gates pass. The phase passes only if all in-scope scenarios pass + all global gates pass.

`N/A` allowed when the slice under test does not implement the scenario yet (e.g. `R6.*` is N/A pre-slice-5).

---

## §R1 — Topic CRUD

### R1.1 — Create a topic via API
| Gate | Pass condition |
|---|---|
| HTTP status | `201 Created` |
| Body shape | Includes `id` (uuid), `name`, `description`, `tags` (array), `workspace_id`, `created_at`, `updated_at`, `archived_at: null` |
| DB row | Single row inserted in correct workspace |
| Prepared-statement safety | No SQL injection from `name`/`description` (test with `'; DROP TABLE topics; --`) |

### R1.2 — List is workspace-scoped
| Gate | Pass condition |
|---|---|
| Workspace A list | Returns only A's topic(s) |
| Workspace B list | Returns only B's topic(s) |
| No leakage | A's topic IDs do not appear in B's response |

### R1.3 — Soft-delete
| Gate | Pass condition |
|---|---|
| `archived_at` set | Non-null after `DELETE` |
| Default list excludes | `GET /api/topics` does not include archived |
| `?include=archived` includes | Returns archived rows |

---

## §R2 — One-shot brief

### R2.1 — Create + run `general_brief` with no topic
| Gate | Pass condition |
|---|---|
| Initial state | `agent_runs.status = queued` immediately after `POST /api/briefs` |
| Dispatch | `agent_runs.status` transitions to `running` within 5s of `POST /api/briefs/:id/run` |
| Event emission | `research.brief.started` event in activity log within 5s of dispatch |
| Completion within budget | Brief reaches `complete` within 5 minutes (FLAKE eligible) |
| Final state | `agent_runs.status = complete`, `agent_runs.completed_at` set |
| Result body present | `briefs.result_md` non-empty, ≥ 200 characters |
| Output structure | `result_md` contains a recognizable executive-summary / findings / citations structure (per researcher SOUL output format) |
| Citations | `briefs.citations_json` non-null with ≥ 1 citation **OR** result body explicitly notes web access unavailable (YELLOW pass — surface in verdict) |
| No orphan run | After completion, no other `agent_runs` row for this brief is in `running` |

---

## §R3 — Topic-attached brief

### R3.1 — Brief inherits topic context
| Gate | Pass condition |
|---|---|
| Topic linkage in DB | `briefs.topic_id` set correctly |
| Prompt augmentation | Assembled prompt sent to researcher includes the topic `description` text (verifiable via dispatch debug log or persisted prompt column) |
| UI shows linkage | Brief detail page shows topic name with link to topic detail |

---

## §R4 — Streaming progress

### R4.1 — SSE events
| Gate | Pass condition |
|---|---|
| `started` event | Fires within 5s of dispatch |
| `progress` event | At least one fires during the run (token chunk OR heartbeat) |
| `completed` event | Fires within 5s of `agent_runs.status = complete` |
| Event payload | Each event includes `brief_id`, `agent_run_id`, `workspace_id` |

---

## §R5 — Failure handling

### R5.1 — Malformed response
| Gate | Pass condition |
|---|---|
| Status transition | `agent_runs.status = failed` |
| Error captured | `briefs.error_md` non-empty, human-readable |
| Event | `research.brief.failed` emitted |
| UI | Brief detail shows failure clearly (red status pill, error excerpt) |
| No silent retry | Phase 1 does not auto-retry; brief stays `failed` |

### R5.2 — Gateway down
| Gate | Pass condition |
|---|---|
| Fast-fail | Brief reaches `failed` within 30s |
| Error specificity | `error_md` identifies gateway/connection issue (not generic "fetch failed") |
| No orphans | No `agent_runs` row stuck in `running` after failure |

---

## §R6 — Eval harness

### R6.1 — Fixture run stability
| Gate | Pass condition |
|---|---|
| Script runs cleanly | `yarn research:eval` exits 0 |
| Output structure | Per-brief scores on every rubric axis; aggregate score reported |
| Score persisted | Output written to `tmp/research-eval/<run_id>/` with timestamps |
| Stability | Re-running the eval on the same fixtures within the same hour produces aggregate scores within ±10% (judge stochasticity acceptable; below this gate indicates rubric or prompt is too unstable to be useful) |

### R6.2 — Bad-brief detection
| Gate | Pass condition |
|---|---|
| Low scores assigned | The deliberately bad fixture scores in the bottom quartile on relevant axes |
| Aggregate impact | Bad fixture pulls aggregate score below the all-good baseline by a measurable amount (≥ 0.5 on a 0–5 scale) |

---

## §R7 — UI surfaces

### R7.1 — Hub dashboard
| Gate | Pass condition |
|---|---|
| Loads without errors | No console errors on page load (per `preview_console_logs`) |
| Lanes render | "In progress" / "Upcoming" / "Recent results" present even when empty |
| Live update | An in-flight brief appears in "In progress" within 5s of dispatch and moves to "Recent results" within 5s of completion |

### R7.2 — Topic detail
| Gate | Pass condition |
|---|---|
| Renders | All topic metadata displayed |
| Brief history | Lists all briefs for that topic, newest first |
| Run-a-brief affordance | Drawer opens; only `general_brief` enabled |

### R7.3 — Brief detail
| Gate | Pass condition |
|---|---|
| Markdown rendered | `result_md` rendered with `react-markdown` + `remark-gfm` styling |
| Citations panel | Visible when present, collapsed by default |
| Status pill | Reflects current `agent_runs.status` |
| Re-run button | Visible (non-functional in phase 1; hover tooltip says "phase 2") |

---

## §R8 — Cross-workspace isolation

### R8.1 — No leakage
| Gate | Pass condition |
|---|---|
| List endpoints | A workspace's listing endpoints never include another workspace's rows |
| Direct fetch | `GET /api/briefs/:id` for a brief in another workspace returns 404 or 403, never 200 |
| Topic linkage | Briefs cannot be created with a `topic_id` that belongs to another workspace (returns 400) |

---

## Global gates

These apply across the whole run.

| Gate | Pass condition |
|---|---|
| No unhandled errors | Dev server log has no `[ERROR]` lines from research code paths during the run |
| No DB lock errors | No `SQLITE_BUSY` / `SQLITE_LOCKED` in dev server log |
| Migration idempotency | Re-running `yarn db:reset` produces the same schema (no drift) |
| Test suite intact | `yarn test` passes the same set as `00-baseline-observations.md`'s baseline (any new failures attributed to research code = FAIL) |
| Type check | `yarn tsc --noEmit` clean |
| Cost reasonable | Sum of `agent_runs.cost_cents` across all phase-1 validation runs ≤ $5 (sanity check; not a hard gate) |
| Capture completeness | Every scenario has its `/tmp/mc-validation/research/<scenario_id>/` directory with at minimum a `notes.md` and any cited transcripts |

---

## Verdict shape

After running the test plan, write a top-level verdict in `04-e2e-run-results.md`:

- **GREEN** — all in-scope scenarios PASS, all global gates PASS. Stack ready to merge.
- **YELLOW** — all in-scope scenarios PASS but with caveats (e.g. R2.1 passed without citations because web tools are not wired). Operator must explicitly accept the YELLOW conditions before merge.
- **BLOCKED** — at least one scenario blocked by infra outside this stack's control (e.g. gateway not reachable). Surface the blocker; do not change the verdict to RED.
- **RED** — at least one in-scope scenario or global gate FAILED due to code in this stack. Stack does NOT merge; surface the failure with reproduction steps and proposed fix.
