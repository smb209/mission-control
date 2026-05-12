# 02 — Test plan

7 scenarios. Each is independent given pre-check 01 was run cleanly. Capture path: `/tmp/mc-validation/research-loop/<scenario_id>/`.

All real-agent dispatches use `spark-lb/agent`. Time budget per scenario: ~5 min agent time.

---

## R-S1. Suggest scoped to initiative produces initiative-relevant candidates

**Setup:** seed initiative from pre-check P6. No prior briefs.

**Action:** From the initiative detail page, click **Suggest research**. (Or POST `/api/research/suggestions { initiative_id }`.)

**Observation:**
- `research_suggestions` rows appear with `payload_json.initiative_id = <seed_id>`.
- 3–5 candidates produced.
- The PM prompt (capture from agent transcript) contains the initiative title + description + status (not workspace-wide context).
- Capture: full transcript → `R-S1/transcript.json`; suggestions list → `R-S1/suggestions.json`.

---

## R-S2. Accepted brief writes one auto-note on completion

**Setup:** R-S1 completed; pick one suggestion.

**Action:** Accept the suggestion from the SuggestPickerDrawer. Brief dispatches.

**Observation:**
- Brief row created with `initiative_id = <seed_id>` and `source_ref = NULL`.
- Brief completes (`agent_runs.status = 'complete'`, `briefs.result_md` non-empty).
- `briefs.summary` populated, ≤160 chars.
- **Exactly one** `agent_notes` row appears with: `kind='discovery'`, `audience='pm'`, `importance=2`, `initiative_id=<seed_id>`, `source_kind='brief'`, `source_ref=<brief_id>`, `archived_at IS NULL`, body containing brief title and a ≤600-char excerpt.
- Capture: brief row, agent_run row, agent_notes row → `R-S2/db_state.json`.

---

## R-S3. Rerun replaces the prior auto-note (soft-delete + insert)

**Setup:** R-S2 completed.

**Action:** POST `/api/briefs/<R-S2 brief_id>/rerun`. New brief row created with `source_ref='brief:<R-S2 brief_id>'`. Wait for completion.

**Observation:**
- New brief row has `initiative_id = <seed_id>`, copied from the original.
- The R-S2 auto-note now has `archived_at` set, `archived_reason='superseded_by_rerun'`.
- A new auto-note exists with `source_ref=<rerun brief_id>`, not archived.
- `read_notes({ initiative_id, audience: 'pm', min_importance: 2 })` returns the rerun's note, not the archived one.
- Capture: pre/post agent_notes snapshot → `R-S3/notes_diff.json`.

---

## R-S4. Decompose context loads the auto-note with no further changes

**Setup:** R-S2 completed (R-S3 not required for this scenario).

**Action:** From the initiative, dispatch `decompose_initiative` via the existing PM flow.

**Observation:**
- Capture the PM agent's transcript. The transcript shows `read_notes` being called with `audience: 'pm', min_importance: 2`, and the auto-note appears in the response.
- The proposal output (in `agent_proposals` or wherever the PM writes its draft) references content from the brief — verify by grepping the proposal `impact_md` / `rationale` for a phrase from the brief's `summary`.
- Capture: PM transcript + final proposal row → `R-S4/`.

---

## R-S5. Researcher fetches a prior brief's full body via `read_brief`

**Setup:** R-S2 brief exists with non-trivial `result_md`.

**Action:** Dispatch a second research suggestion → brief on the same initiative. The new brief's PM prompt references prior briefs by `{id, title, summary}`. Inspect the researcher's tool calls.

**Observation:**
- Researcher (or PM, depending on who's reading priors) calls `read_brief({ brief_id: <R-S2 brief_id> })` at least once.
- Response shape matches: `{ id, title, prompt, result_md, citations, status, completed_at, initiative_id, summary }`.
- Capture: tool call + response → `R-S5/read_brief_call.json`.

If the agent doesn't naturally call `read_brief` (it's not strictly required by the prompt), this scenario falls back to a direct MCP smoke probe: invoke `read_brief` with the known id and assert the response shape. Note in results which mode was used.

---

## R-S6. Full UI loop end-to-end

**Setup:** fresh seed initiative (pre-check rerun, or new initiative via UI).

**Action:** preview-driven. From the initiative detail page:
1. **Suggest research** → drawer opens with initiative-scoped suggestions.
2. Accept one → brief appears in the new Research section with `running` status.
3. Wait for completion → status flips to `complete`, citation count visible.
4. Open notes rail → auto-note visible with "View brief" affordance.
5. Click **Decompose with PM** → new proposal appears that references the research finding.

**Observation:**
- Each step verifiable in `preview_snapshot` / `preview_screenshot`.
- No console errors in `preview_console_logs` across the run.
- No 4xx/5xx in `preview_network` for `/api/briefs`, `/api/research/suggestions`, `/api/pm/decompose-initiative`.
- Capture: screenshots per step → `R-S6/step-N.png`; final notes rail → `R-S6/notes-rail.png`.

---

## R-S7. Decompose proposal demonstrably uses the research finding

**Setup:** R-S6 completed through step 5.

**Action:** Inspect the resulting proposal.

**Observation:**
- Proposal `impact_md` / `rationale` quotes or paraphrases something specific from the brief's `result_md` — not just generic boilerplate.
- This is the qualitative gate: a human (or this agent) reads the proposal and confirms the research changed the output. Subjective but the most important gate.
- Capture: proposal row + brief `result_md` → `R-S7/comparison.md` with the specific phrase callouts.

---

## Capture conventions

- All scenario directories under `/tmp/mc-validation/research-loop/`.
- `db_state.json` files use `sqlite3 -json` output.
- Transcripts are the raw `agent_runs.transcript_md` or equivalent.
- Screenshots are PNG from `preview_screenshot`.
- Each scenario folder has a `notes.md` for any anomalies observed during the run.
