# 03 — Validation criteria

Pass/fail gates per scenario (AND-ed within a scenario). Plus global gates that apply across the whole run. A milestone passes only if **all** gates pass.

`FLAKE` policy: re-run the affected scenario 3×, pass if ≥ 2/3 succeed. Flake is logged in the verdict.

## Per-scenario gates

### R-S1 — Suggest scoped to initiative

- [ ] G1.1 `research_suggestions` rows have `payload_json.initiative_id = <seed_id>`.
- [ ] G1.2 3–5 candidates produced (not 0, not >5).
- [ ] G1.3 PM prompt contains the seed initiative's title and at least one phrase from its description.
- [ ] G1.4 PM prompt does **not** contain workspace-wide context blocks (other initiatives, blocked tasks at workspace scope).

### R-S2 — Auto-note on completion

- [ ] G2.1 Brief row has `initiative_id = <seed_id>`, `summary` non-empty and ≤160 chars.
- [ ] G2.2 Exactly one agent_notes row matches `(initiative_id=<seed_id>, source_kind='brief', source_ref=<brief_id>)`.
- [ ] G2.3 Auto-note has `kind='discovery'`, `audience='pm'`, `importance=2`, `archived_at IS NULL`.
- [ ] G2.4 Auto-note `body` contains the brief title and an excerpt of `result_md` no longer than 600 chars (excluding the title + link footer).
- [ ] G2.5 No auto-note is written for any other initiative.

### R-S3 — Rerun replace

- [ ] G3.1 New brief row has `initiative_id = <seed_id>`, `source_ref='brief:<original_id>'`.
- [ ] G3.2 Original auto-note is now `archived_at` non-null with `archived_reason='superseded_by_rerun'`.
- [ ] G3.3 A new auto-note exists for the rerun, not archived.
- [ ] G3.4 `read_notes({initiative_id, audience:'pm', min_importance:2})` returns the rerun's note, not the archived one.
- [ ] G3.5 Total non-archived auto-notes for this initiative = 1.

### R-S4 — Decompose context loads auto-note

- [ ] G4.1 PM transcript shows a `read_notes` call with `min_importance:2, audience:'pm'`.
- [ ] G4.2 Response to that call includes the auto-note body.
- [ ] G4.3 Final proposal row exists.
- [ ] G4.4 Proposal `impact_md` or `rationale` contains a phrase traceable to the brief's `summary` or first 200 chars of `result_md`. (Substring match, case-insensitive, ≥6 consecutive words.)

### R-S5 — `read_brief` discoverability + shape

- [ ] G5.1 If invoked by an agent: tool call captured with correct `brief_id`. Else direct MCP probe used and noted.
- [ ] G5.2 Response includes all keys: `id, title, prompt, result_md, citations, status, completed_at, initiative_id, summary`.
- [ ] G5.3 No `null` for `result_md` (the brief is complete).

### R-S6 — Full UI loop

- [ ] G6.1 Preview screenshots captured for steps 1–5; each shows the expected state.
- [ ] G6.2 No errors in `preview_console_logs` across the run.
- [ ] G6.3 No 4xx/5xx in `preview_network` for the listed endpoints.
- [ ] G6.4 Notes rail renders the auto-note with a working "View brief" link.

### R-S7 — Proposal references research (qualitative)

- [ ] G7.1 Reviewer (this agent) writes a 1–2 sentence claim in the comparison.md identifying which phrase in the proposal traces back to the brief.
- [ ] G7.2 The traceable phrase is concrete (a fact, a number, a named pattern), not generic ("we should research more" doesn't count).

## Global gates

- [ ] GG.1 Every slice's per-PR test slice (`yarn test <files>`) is green at the stack tip.
- [ ] GG.2 `yarn mcp:smoke` is green at the stack tip.
- [ ] GG.3 `yarn typecheck` (or whatever the project uses — `yarn build` if no separate typecheck) is green.
- [ ] GG.4 No new entries in dev server log matching `/error|unhandled|EADDR|ECONNREFUSED/i` introduced during the run.
- [ ] GG.5 Pending-brief queue is empty at the end of the run (no orphan dispatches still in flight).
- [ ] GG.6 No more than 1 brief was dispatched per scenario (HMR runaway smoke).
- [ ] GG.7 Pre-existing test failures, if any, are listed verbatim in the verdict doc per CLAUDE.md.

## Verdict mapping

- **GREEN** — all per-scenario gates + all global gates pass. Ready to merge.
- **YELLOW** — global gates pass; one or more scenario gates fail but the failure is well-understood and documented. Operator decides.
- **BLOCKED** — pre-check 01 halted; validation didn't run.
- **RED** — global gate failure, or scenario failure that points to a wrong design call. Stop, surface, do not merge.
