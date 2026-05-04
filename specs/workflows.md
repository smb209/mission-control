# Workflows — Spec (Draft)

A **visual flowchart editor** for defining structured, reusable, multi-step automations. Nodes are authored in markdown (LLM-interpreted), then progressively *solidified* into deterministic code where possible. The result is a workflow that starts as a sketch and ends as a cheap, fast, debuggable pipeline — without ever leaving the editor.

## Mental model

A workflow is a **DAG of nodes** (one or more triggers → many action/decision nodes → terminal sinks). Each node has:

- A **kind** (trigger / action / decision / sink / loop / subworkflow)
- A **prompt** (markdown body — what this node should do, in plain language)
- An **execution mode** — see "Maturity ladder" below
- An **input schema** (what shape the previous node hands it)
- An **output schema** (what shape it hands to the next node)
- Zero or more **outgoing edges**, each with an optional condition

Edges carry typed payloads. The schemas are how a markdown-authored node and a code-solidified node remain interchangeable.

## Maturity ladder per node

This is the central idea. A single node moves through stages as the user gains confidence in it:

| Stage | What runs at exec time | When to use |
|---|---|---|
| **`draft`** | LLM with markdown prompt + freeform output | Sketching the idea |
| **`structured`** | LLM with markdown prompt + **enforced output schema** (JSON) | Working but format matters; downstream nodes depend on shape |
| **`validated`** | Same as `structured`, but flagged as "tested OK over N runs" | Ready to consider solidifying |
| **`solidified`** | Generated code (TS/Python) executing the same contract; no LLM call | Deterministic, cheap, fast |
| **`hybrid`** | Generated code with explicit LLM sub-calls for the parts that genuinely need judgment (summarization, classification) | The realistic end state for most non-trivial nodes |

**Solidify action**: on a `validated` node, click *Solidify*. The platform:
1. Reads the node's prompt + schemas + last N successful run traces (input/output pairs).
2. Generates a code module that satisfies the input → output contract.
3. Runs it against the prior traces as a regression test.
4. Surfaces a diff: `[node-code] generated`, plus "X/N traces match." User accepts → node mode flips to `solidified`. Rejects → stays at `validated`, code is kept as a draft for next attempt.

Solidified nodes are versioned; reverting to LLM is one click (useful when the upstream service changes shape).

## Node kinds

### Trigger
- `manual` — user click
- `schedule` — cron expression
- `event` — Mission Control event (`initiative.shipped`, `risk.created`, `brief.completed`, …)
- `webhook` — inbound URL with shared secret
- `subworkflow_call` — invoked by another workflow

### Action
- `http_fetch` — GET/POST a URL with auth (solidifies trivially)
- `llm_transform` — markdown prompt over input → output (the workhorse; the most common solidify target)
- `db_read` / `db_write` — read/write Mission Control tables (initiatives, risks, briefs, calendar entries, etc.)
- `template_render` — fill a template with input values (markdown / email / Slack)
- `external_call` — generic outbound integration (Slack, email, GitHub, Linear); each integration is its own kind once wired

### Decision
- `condition` — n-way branch on input fields (operators, regex, JSON-path)
- `llm_router` — when the routing decision genuinely needs judgment

### Sink
- `report_save` — persist a structured report to the workflow's report log
- `notification_send` — email / Slack / in-app (gated by the explicit-permission rules; no auto-send without operator opt-in for external sinks)
- `propose` — emit a Calendar / Risk / Decision proposal into the existing review flows
- `escalate` — see "Escalation sink" below

### Escalation sink

Distinct from `notification_send`. The `escalate` sink is how a workflow says **"I've gone as far as I can, the operator needs to make a call — here's everything teed up."** It is the first-class expression of MC's north star ("aware, involved, proactive — not do-everything"): when a workflow can't or shouldn't act autonomously, it packages the context and hands it off cleanly rather than nagging or silently failing.

**Inputs**
| Field | Notes |
|---|---|
| `title` | "DE Franchise Tax: missing gross assets figure" |
| `summary_md` | what happened, what's blocked, why MC stopped here |
| `severity` | `info` / `action_needed` / `urgent` |
| `decision_options` | structured: each option = label + consequence summary + (optional) one-click action |
| `context_bundle` | structured payload of everything the operator needs: linked entities (calendar entry, risk, brief), recent run trace, fetched-but-unprocessed data, the workflow's reasoning so far |
| `proposed_action` | what MC would do if approved (renderable as a diff/preview where possible) |
| `deadline` | optional — when this escalation becomes overdue |
| `linked_*` | calendar_entry_id, initiative_id, risk_id, brief_id, etc. |

**Behavior at runtime**
1. Workflow run pauses at the `escalate` node (does not advance downstream nodes).
2. An Escalation record is created and appears in the operator's escalations inbox (see below).
3. Run state is `awaiting_escalation`; resumes only when the operator picks an option (or marks resolved).
4. Resolution writes the chosen option + any operator notes back into the workflow's run trace, and downstream nodes execute with that decision as their input.
5. Timeout behavior is configurable per node: `block` (default — wait forever), `auto_choose:<option>` (after deadline, pick a pre-declared safe default), or `fail`.

**Escalations inbox** (`/escalations`, separate top-level surface)
- Cross-workflow, cross-source list of pending escalations.
- Sorted by severity then deadline.
- Each row: title, source (workflow/calendar/risk-sweep/etc.), age, severity pill.
- Detail view: rendered `summary_md`, `context_bundle` panels (collapsible), `decision_options` as buttons, free-text resolution field, "Resolve & resume" / "Resolve without resuming" / "Snooze" actions.

**Other producers of escalations**
The same Escalation record type is also produced by:
- Calendar readiness sweep when a requirement is `unsatisfiable` or stale-without-an-automatable-source.
- Risk sweep when a sweep proposal hits "needs human judgment."
- Stakeholder & comms when a draft can't be auto-completed.
- Any future surface that needs to hand a decision back to the operator with full context.

This keeps escalation a *uniform* affordance across MC rather than each surface inventing its own "alert" pattern. Tracks time-to-resolution as a project-health metric.

**What it is not**
- Not a notification — notifications inform; escalations *block on a decision*.
- Not an error — an error is "MC tried and broke." An escalation is "MC reached the boundary of what it can decide alone."
- Not a task — a task is work to do; an escalation is a decision needed before work proceeds.

### Control
- `loop` — fan out over an array
- `subworkflow` — call another workflow inline
- `wait` — sleep / wait for event / wait for human approval

## Example: "Daily Sentry digest" (the user's case)

```
[schedule: daily 09:00]
        │
        ▼
[http_fetch: Sentry /issues last 24h]      ← solidifies trivially
        │
        ▼
[llm_transform: reduce + summarize, flag NEW issues]
   prompt: "Group by fingerprint. For each group, …"
   output schema: { groups: [{title, count, first_seen, is_new, severity}] }
        │
        ▼
[report_save: structured report → workflow report log]
        │
        ▼
[db_read: last 7 daily reports for this workflow]   ← solidifies trivially
        │
        ▼
[llm_transform: identify trends vs prior reports]
   output schema: { trends: [{metric, direction, callout}] }
        │
        ▼
[template_render: email body from {today, trends, top_groups}]   ← solidifies trivially
        │
        ▼
[notification_send: email to oncall@…]   ← requires explicit-permission opt-in
```

Of seven nodes, **five solidify to code** after a few successful runs. Two stay LLM (`reduce + summarize`, `identify trends`) but with enforced output schemas — that's where actual judgment lives. Cost drops by an order of magnitude versus an all-LLM pipeline; failures are localizable to the two LLM nodes.

## Editor surface

`/workflows` — list view: each workflow with status (active/disabled), trigger summary, last run, success rate over last 30 runs, total monthly cost estimate.

`/workflows/[id]` — graph editor. Pannable canvas, snap-to-grid, multi-select. Right rail = property panel for the selected node (kind, prompt markdown editor, schema editor, exec mode, last 10 runs). Bottom drawer = run log (filterable).

`/workflows/[id]/runs/[runId]` — single-run trace. Each node shows: input payload, output payload, mode at exec time (LLM vs code), latency, cost, errors. LLM nodes show the rendered prompt + raw response. This is the primary debugging surface.

## Schema authoring

Schemas are JSON Schema (subset). The property panel offers:
- Auto-infer from sample run output (one-click)
- Hand-edit
- "Tighten" — propose narrower types based on N runs of observed data

Schema mismatch at runtime → node fails with structured error pointing at the offending field. Failure does not silently coerce.

## Solidify pipeline (detail)

1. **Eligibility check**: node is `validated`, has ≥ N (default 5) successful runs with matching output schema.
2. **Trace collection**: fetch input/output pairs, redact secrets.
3. **Code generation**: dispatched agent with the prompt + schemas + traces. Output is a TypeScript module exporting `async function run(input): Promise<output>` with a small allowlist of permitted imports (no arbitrary npm).
4. **Regression run**: execute against collected traces; compare outputs structurally (with tolerance configurable per field).
5. **Sandbox run**: live one-shot against current upstream input; verify output schema match.
6. **Diff review**: show the generated code, regression results, and cost/latency delta side-by-side. User accepts → mode flips, code is committed to workflow source. Rejects with notes → next solidify attempt incorporates the notes.

For `hybrid`: the agent identifies which sub-steps within a solidified node still need an LLM (e.g. "this is a summarization step; keep it as a sub-call"). Those become inline `llm_call({prompt, schema})` invocations in the generated code.

## Reusability

- **Subworkflows** — any workflow can be invoked as a node by another workflow.
- **Node templates** — save a configured node (any mode) as a reusable template; appears in the node palette.
- **Library** — community/team library of templates; importable with versioning.

## Versioning, rollback, env

- Each saved edit creates a workflow version. Live runs use a pinned version; switching versions is explicit.
- Solidified node code is part of the version snapshot.
- Every run records its workflow version + node modes; reproducibility for postmortems.
- Per-environment secrets (Sentry API key, Slack token) live in the existing settings layer; nodes reference by name, never inline.

## Cost & safety guardrails

- Per-workflow monthly cost ceiling; runs above the ceiling pause and notify rather than silently continuing to bill.
- Per-node max LLM calls per run; loop nodes have explicit max-iterations.
- All external sinks (`notification_send`, `external_call` writes, `db_write` to user-visible tables) require **explicit per-workflow opt-in** before they execute live. New workflows default to "dry-run sinks" — outputs captured to the run trace but not actually sent.
- Workflow runs are workspace-scoped; cross-workspace reads require explicit declaration.

## Integrations with the rest of MC

- **Triggers** can listen on the existing event bus (`initiative.*`, `task.*`, `risk.*`, `brief.completed`, etc.).
- **Sinks** can write into Calendar / Risks / Decisions / Stakeholders / Memory via the same proposal flows those surfaces already consume.
- **Escalations inbox** is a top-level MC surface fed by the `escalate` sink and by escalations from Calendar/Risks/Stakeholders sweeps. One affordance, many producers.
- **Research briefs** are themselves a candidate to be re-implemented as a built-in workflow once the engine is mature — but not in phase 1.
- **PM agent** can suggest workflows: "you've manually triaged Sentry every morning for two weeks; want me to draft a workflow for that?"

## Open questions

- Editor library: build on something (React Flow, Rete) or roll our own? Strong default is React Flow — it's mature, MIT, and has the gestures.
- Code-gen target language: TS to match the rest of the codebase, or also Python for data-heavy nodes? Start TS-only.
- Where do solidified node modules live — in DB (rows of code) or on disk (a `workflows/` tree)? Lean DB for v1 so versioning is uniform; on-disk export for git review later.
- LLM-call accounting at the node level vs run level — needed for the per-workflow cost ceiling. Reuse the existing cost telemetry in `src/components/costs/`.
- "Hybrid" handoff: how does generated code call back into the LLM? Probably a stable `llm_call(prompt, schema)` helper module the codegen targets.
- Dry-run mode for the whole workflow (sample input + traces every node, no sinks fire) — lean yes, useful for debugging.

## Phase plan

1. Workflow + Node + Edge + Run tables. Editor with `manual` trigger, `llm_transform` action, `notification_send` (in-app only) sink. All LLM, no solidify.
2. Output schemas + structured-mode runs; per-run trace UI.
3. `http_fetch`, `template_render`, `condition` nodes; `schedule` trigger.
4. **Escalation sink + escalations inbox** (cross-cutting surface). Pause/resume on escalation. Wire Calendar readiness sweep as a second producer.
5. Solidify pipeline: regression-test → diff review → mode flip.
6. Hybrid mode + node templates + subworkflows.
7. Event-bus triggers + proposal sinks (Calendar/Risks/Decisions integration).
8. External sinks (email/Slack) behind explicit opt-in; cost ceilings + dry-run.
