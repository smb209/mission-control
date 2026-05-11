# Initiative Investigate flow

A researcher-driven audit pass over an initiative. Fills the gap between **Plan with PM** (refine a draft) and **Decompose with PM** (break into children) — neither of which can answer "what's already built, what's drifted, what's missing" because the PM doesn't have read/exec access to the codebase.

## Operator intent

> "Take this epic and have an agent go in and research what's already done and what still needs work."

The output is **diagnostic**, not transformational. After reviewing the report, the operator decides whether to:
- Click **Plan with PM** with explicit guidance ("apply the audit findings, mark slice 3 done, push slice 4 to next sprint")
- Manually edit `status_check_md` / `target_*` fields
- Kick off **Decompose with PM** to add new child stories that surfaced
- Mark the initiative `done` / `cancelled` directly

No automatic PM hand-off. The audit produces evidence; the operator chooses the next move.

## Two modes

### Narrow (single node)
"Just look at this one initiative." One researcher dispatch. Reads description, status_check_md, attached tasks (no children). Produces one report.

### Subtree (bottom-up fan-out)
"Audit this whole epic." MC orchestrates a per-level researcher fan-out:

1. Enumerate leaves (descendants with no children of their own that are still `planned` / `in_progress` / `at_risk` / `blocked` — skip `done`/`cancelled`).
2. **Layer 1**: dispatch N narrow researchers in parallel, one per leaf. Each writes a `take_note` against its own initiative_id.
3. **Wait** for all Layer 1 dispatches to complete (or hit per-node timeout).
4. **Layer 2**: for each parent of Layer 1 leaves, dispatch a roll-up researcher. Brief includes the parent's own description + a synthesized digest of children's findings (from their notes, fetched by MC and inlined).
5. Repeat upward until the original target initiative is reached.

This keeps each individual researcher's context small (one node at a time) and avoids the "investigate the whole tree in one session" failure mode.

## Architecture

### New scope_type
```ts
// src/lib/db/mc-sessions.ts
export type ScopeType =
  | …existing…
  | 'initiative_audit';   // NEW
```

### New API endpoint
`POST /api/initiatives/:id/investigate`

Body:
```ts
{
  mode: 'narrow' | 'subtree';
  guidance?: string;        // operator-supplied focus area, optional
}
```

Returns immediately with `{ dispatch_id, scope_keys[] }`. SSE events surface progress; the modal renders a live tree of which nodes are pending / running / complete.

### Dispatch wiring

Reuses `dispatchScope` exactly as the brief flow does:

```ts
dispatchScope({
  workspace_id,
  role: 'researcher',
  agent: runner,
  session_suffix: `initiative-${id}:audit:${attempt}`,
  scope_type: 'initiative_audit',
  initiative_id: id,
  trigger_body: buildAuditPrompt({ initiative, mode, guidance, child_findings }),
  attempt_strategy: 'fresh',         // no resume — each audit is its own scope
  timeoutMs: 15 * 60_000,            // 15 min; audits can be slow
});
```

For subtree mode, MC's orchestration layer does:

```ts
async function runSubtreeAudit(rootId: string) {
  const layers = enumerateLayersBottomUp(rootId);   // [[leaf ids], [parent ids], …, [root id]]
  const findingsByInitiative = new Map<string, string>();
  for (const layer of layers) {
    await Promise.all(layer.map(async (id) => {
      const childFindings = childrenOf(id).map(c => findingsByInitiative.get(c.id) ?? '');
      const reply = await dispatchScope({ /* trigger_body inlines childFindings */ });
      findingsByInitiative.set(id, extractDeliverableSummary(reply));
    }));
  }
  return findingsByInitiative.get(rootId);
}
```

### Audit prompt template

New file: `agent-templates/researcher/initiative-audit-prompt.md` (loaded at dispatch time, parameterized).

Skeleton:

```
**Initiative audit (mode: {{mode}})**

Target: {{initiative.title}}  (kind={{kind}}, status={{status}})

Description:
> {{initiative.description}}

Status check:
{{initiative.status_check_md ?? "_(none)_"}}

Target window: {{target_start}} → {{target_end}}

{{#if mode=='narrow' && tasks}}
Direct child tasks (this initiative's tasks):
{{#each tasks}} - {{title}} ({{status}}) {{/each}}
{{/if}}

{{#if mode=='rollup' && childFindings.length}}
Findings from child initiatives (already audited):
{{#each childFindings}}
### {{child.title}}
{{this}}
---
{{/each}}
{{/if}}

{{#if guidance}}
Operator focus: {{guidance}}
{{/if}}

## Your job

Audit this initiative against reality. Produce a markdown report covering:

1. **Done with evidence** — what's been built. Cite commit shas, PR numbers, file paths, test names.
2. **In-flight** — partial implementations, what's covered vs gaps.
3. **Not started** — items in description / status_check that have no code yet.
4. **Drift** — discrepancies between the initiative description and what the codebase actually does. Don't speculate; only flag drift you can prove with a file path / test result / git log.
5. **Verdict** — one of: **on track**, **partially done**, **stale (rescope)**, **done in entirety**, **never built**, **cancelled-in-effect**.
6. **Recommended next action** — concrete suggestion the PM can act on. Phrased as "Suggest: …", not a tool call.

Save the report by calling:

- `take_note({ initiative_id: "{{initiative.id}}", kind: 'observation', audience: 'pm', importance: 2, body: <full report> })`

The note is the audit trail for now. **No `register_deliverable` call** — see "Output capture" below for why.

Don't call propose_changes; you don't have it on your mount. The PM will pick up your note when the operator decides to act.

If the initiative has no associated code yet (planned-only), early-exit with a short verdict ("never built — planned-only, no audit work to do"). Don't burn ten minutes of exec on greenfield.
```

### UI

New section on the initiative detail page action bar:

```
[Plan with PM ▾] [Decompose with PM ▾] [Investigate ▾]
                                         │
                                         ├── Just this initiative (narrow)
                                         └── Whole subtree (bottom-up fan-out)
```

Click → modal:
- Mode (radio: narrow / subtree)
- Guidance (optional textarea)
- Estimated time + node count for subtree mode
- Submit button

After submit → in-flight tray on the initiative detail page (mirrors the PM in-flight strip):
- Per-node status: queued / running / complete / failed
- Live preview of the current researcher's reasoning (latest delta)
- Abort button (cancels future layers; in-progress nodes complete or hit per-node timeout)

### Output capture

Each audit writes a single **`take_note`** with `initiative_id`, `kind: 'observation'`, `audience: 'pm'`, `importance: 2`. Renders on the initiative detail page's notes panel (already wired to show notes filtered by `initiative_id`).

**No `register_deliverable`.** The original spec called for a parallel deliverable row as the audit trail, but the deliverables system is task-scoped today (no `initiative_id` column on the deliverables table) and won't accept an initiative-only deliverable. The note carries the full report body and serves as the audit trail. Revisit if/when deliverables grow initiative scope. (Decision landed in PR 2; the prompt no longer instructs the researcher to call `register_deliverable`.)

Subtree mode produces N notes (one per audited node), all linked to their respective initiative_ids. The root-level note synthesizes children's findings into a single report; the operator can drill into per-child notes if they want detail.

### PM hand-off (manual)

When the operator clicks **Plan with PM** *after* an audit, the PM's existing dispatch flow already pulls notes via `read_notes`. We add a small instruction to `agent-templates/pm/SOUL.md` under the Plan flow: **"Before composing your proposal, call `read_notes(initiative_id, audience: 'pm', min_importance: 2, limit: 5)` to ingest any recent audit findings. Reference the most relevant ones explicitly in `impact_md`."**

The operator can also pass guidance into the Plan dispatch to focus the PM ("Apply the audit findings — mark Slice 1+2 done, rescope Slice 3 with the new constraints, drop Slice 4").

## Schema gap (parallel slice)

The PmDiff `set_initiative_status` enum is `['planned', 'in_progress', 'at_risk', 'blocked']` (`src/lib/mcp/shared.ts:226`). The InitiativeStatus type allows `done` and `cancelled` (`src/lib/db/initiatives.ts:23`).

**Today the PM literally cannot propose marking an initiative `done` or `cancelled`.** That breaks the operator's intended audit-outcome chain (rescope/done/cancel).

Fix: extend the PmDiff `set_initiative_status` enum to match `InitiativeStatus`. One-line schema change + matching `acceptProposal` branch update if there's branching logic on terminal states (probably none — status is just an UPDATE).

This is independent of the investigate flow but blocks the full operator outcome chain. Ship as a sibling PR.

## Slice plan

Five PRs, stackable:

| # | PR | Scope |
|---|---|---|
| 1 | `feat(pm): allow done/cancelled in set_initiative_status` | Schema gap. Tiny — enum + maybe a test. |
| 2 | `feat(initiatives): scope_type=initiative_audit + dispatch endpoint (narrow only)` | DB enum, API route, prompt template, no UI yet. Test via curl. |
| 3 | `feat(ui): Investigate button + narrow-mode modal on initiative detail` | UI slice. Wires #2 into the detail page. Operator can run a narrow audit end-to-end. |
| 4 | `feat(initiatives): subtree mode with MC-driven layered fan-out` | The roll-up orchestration. Per-level await, child-findings injection. |
| 5 | `feat(pm): read recent audit notes during Plan dispatch` | Tiny SOUL edit + maybe a pre-fetch in pm-dispatch's plan trigger_body. |

## Decisions

1. **Per-node timeout + subtree concurrency cap**: stored as **workspace settings**, configurable per workspace. Defaults from the spec apply when unset (15 min timeout, 4 parallel). New columns / fields:
   - `audit_per_node_timeout_ms` (integer, default 900000)
   - `audit_subtree_concurrency` (integer, default 4, min 1, max 8)
   Reachable from the workspace settings page; surfaced as a small "Audit defaults" subsection. Operator can dial up timeout for slow-codebase audits or up concurrency on machines that can hose the LLM.

2. **Re-audit policy**: operator picks per dispatch via a radio in the modal:
   - **Fresh context** (default): new run, new scope_key suffix attempt — `:audit:1` → `:audit:2` → ... — the researcher sees the initiative state but no prior audit findings.
   - **Build on priors**: same scope_key (resume semantics), and the brief inlines the prior audit's note(s) so the researcher refines instead of re-deriving.
   Both create new note rows tagged `importance=2` so the audit trail accumulates either way.

3. **MC-driven fan-out** (vs agent-driven): confirmed. The runner-hosted researcher stays simple; orchestration lives in MC TS.

4. **Guidance on subtree**: flows to **every layer**. Cheap to inline.

5. **Failure handling on subtree**: if a Layer-N node fails or times out, MC proceeds to Layer-N+1 with a `(audit failed)` placeholder for that branch. The roll-up researcher reads the placeholder verbatim and flags the gap explicitly in its synthesis.

## Verification pipeline (iteration loop)

Reproducible loop for tightening the prompt + dispatch behavior against a real partially-completed epic without contaminating each retry with prior state.

### Target fixture

Initiative `0c9419ff-d511-4511-86c6-57a6387e19f7` on the dev DB (operator-confirmed ground truth):
- 1 child marked `done` (legitimately complete)
- Several children **partially** built
- One child **not used at all**

Expected audit verdict surface: `partially done` at the epic level, with per-child breakdown that correctly classifies the done child as `done in entirety`, the partials as `partially done`, and the unused one as `never built` or `cancelled-in-effect`.

### Loop

```sh
# 0. One-time setup: snapshot the current dev DB as the audit fixture
yarn db:checkpoint audit-fixture

# 1. Bring up preview + run the investigate (narrow first, subtree later)
yarn dev                                      # :4010
# (in browser) /initiatives?selected=0c9419ff-d511-4511-86c6-57a6387e19f7
# Click Investigate ▾ → Just this initiative
# Read the resulting note + deliverable

# 2. Iterate on the prompt or dispatch logic (edit files in HMR;
#    most changes pick up live without restart)

# 3. Reset for next pass (kills the WAL noise + stale researcher session)
#    Order matters: stop dev server BEFORE restoring DB so SQLite isn't
#    writing into a file we're about to overwrite.
pkill -f 'next dev' || true                   # stop dev server
yarn db:checkpoint:restore audit-fixture       # restore the fixture
# Reset the researcher session for this scope so the next run is fresh:
RUNNER_ID=$(sqlite3 mission-control.db "SELECT id FROM agents WHERE gateway_agent_id='mc-runner-dev' LIMIT 1;")
TOKEN=$(grep MC_API_TOKEN .env | cut -d= -f2)
yarn dev &                                    # background
sleep 5                                       # let server boot
curl -sS -H "Authorization: Bearer $TOKEN" -X POST \
  "http://localhost:4010/api/agents/$RUNNER_ID/reset?session_suffix=initiative-0c9419ff-d511-4511-86c6-57a6387e19f7:audit:1"

# 4. Re-run from step 1.
```

### Pass criteria for narrow mode

- Note lands with `initiative_id = 0c9419ff…`, `kind = 'observation'`, `audience = 'pm'`, `importance = 2`.
- Report includes a per-child breakdown that aligns with the operator's ground truth (1 done, several partial, one unused).
- Verdict is one of the documented enum values (`partially done` is the expected verdict for this fixture).
- Total dispatch time under the per-node timeout (15 min default).

### Pass criteria for subtree mode (added in PR 4)

- Layer 1: each open child gets exactly one researcher dispatch.
- Roll-up: the root researcher's note correctly summarizes children's findings (cross-check by reading each child's note and confirming the root mentions each one's verdict).
- Layered concurrency: at any moment, no more than `concurrencyCap` parallel dispatches in-flight.
- A failed leaf doesn't block the rest of its layer or the roll-up — the root researcher should call out the gap explicitly.

### What to capture per iteration

Save to `/tmp/mc-validation/initiative-investigate/iter-<n>/`:

- `note.md` — the take_note body the researcher produced
- `transcript.txt` — full chat transcript from openclaw's session log (or webui export)
- `dispatch-log.txt` — MC server logs filtered to `[investigate]` / `[dispatch-scope]` lines
- `verdict.txt` — one-line operator assessment of how the audit landed against ground truth ("matched", "missed unused child", "false-positive on partial X", etc.)

After 3-5 iterations the prompt should be stable enough to start subtree work.

## Out of scope

- Auto-applying audit findings as proposals (operator decides + clicks Plan).
- Re-auditing on a schedule.
- Cross-initiative audits ("audit everything in milestone X" — that's just subtree mode on the milestone).
- Sandboxing the researcher's exec calls (it already runs against the workspace's repo via the runner; existing security model applies).
