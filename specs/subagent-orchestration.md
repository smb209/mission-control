# Subagent orchestration — MCP-compliant context offloading and fan-out

## Why

The primary use case is **context offloading**. A named agent has a
limited working context that's expensive to dilute. When it knows a
chunk of material is relevant but doesn't want to ingest the raw
content, it hands the material plus a focused question to a subagent
and gets back a distilled answer. The subagent burns its own context
on the bulk material and returns ≤500 tokens of synthesis; the parent
keeps its working context clean.

Canonical example, in the named agent's voice:

> "I have these 3 documents and 2 websites that I know have relevant
> info but I don't want to ingest them into my context to avoid
> dilution. I'm going to hand this to a subagent."

Common shapes for that handoff:

- **Summarization** — "give me a 200-word brief on this 50-page
  policy doc."
- **Synthesis** — "across these 3 docs and 2 URLs, what are the
  recurring themes about X?"
- **Extraction** — "pull the action items from this transcript."
- **Classification** — "is this email candidate personal or
  business?"
- **Research** — "does package `foo` have a known CVE? cite sources."
- **Verification** — "is the path `auth/internal/sessions.go` still
  the right reference for our auth module?"

All share the same shape: parent provides prompt + references to
material; subagent reads the material; subagent returns a structured
distilled report. The parent never reads the raw material.

A secondary use case is **fan-out**: an orchestrator (gardener, PM,
seeding pipeline) spawning N parallel subagents to cover a topic
space. Same primitive, just used in plural.

Today MC has named long-lived agents (`mc-builder`, `mc-coordinator`,
`mc-project-manager`, etc.) registered in the openclaw gateway, plus
the `internal-dispatch.ts` path for handing tasks to those agents.
There is **no surface** for ephemeral, scoped subagents that:

- exist only for the duration of a single offload/research task,
- are not in the workspace's permanent agent roster,
- have an explicit parent (the agent that spawned them),
- speak the same MCP protocol as named agents — including
  `send_mail` for mid-flight check-ins back to their parent.

Without this surface, every offload or fan-out workflow either
inflates the parent's context (defeating the purpose) or reinvents
spawn/budget/collect logic and risks subagents that bypass the MCP
toolkit (e.g. raw LLM calls), losing audit, observability, and the
operator's ability to interrupt.

This spec defines the contract.

## Scope: what subagents do and don't do

**Do**: read, summarize, synthesize, extract, classify, research,
verify. Pure read-and-distill workloads.

**Don't (in v1)**: write code, edit files, create initiatives, save
memory, post proposals. Subagents *report* findings; only the
parent agent (or operator-mediated proposal review) acts on them.
Code-writing subagents are a plausible future extension but are not
in scope here — adding them is a new persona variant, not a redesign.

## Design summary

```
parent agent (named: builder / coordinator / PM / gardener / …)
    ↓ spawn_subagent MCP tool
       — prompt + material refs (urls, file paths, mail threads, …)
       — toolkit + budget + expected report shape
ephemeral agent (subagent_runs row + transient agent_id)
    ↓ runs against openclaw with reduced-permission MCP toolkit
    ↓ reads the referenced material
    ↓ send_mail back to parent for partial check-ins
    ↓ submit_subagent_report MCP tool when done
parent
    ↓ reads the structured report (small)
    ↓ decides next action — never sees the raw material
```

Subagents are **first-class MCP agents** — same protocol, same tool
namespaces, same audit. What makes them ephemeral is lifecycle: they
exist for one task, expire on completion or timeout, and never enter
the persistent agent roster.

## Subagent identity

Each subagent gets:

- `agent_id` — fresh UUID, transient. Visible in `whoami`, mail, and
  activity log just like any agent. Cleaned up on expiration.
- `parent_agent_id` — the spawning orchestrator's id. The MCP layer
  enforces that subagent mail / reports route to this parent.
- `subagent_run_id` — links to the orchestration record (see schema).
- `session_key` — fresh openclaw session, isolated from the parent's
  context (subagent gets only its scoped prompt + retrieved memory,
  never the parent's full conversation).

Subagent agent_ids are namespaced (`subagent-<run_id>-<seq>`) so they
sort together in agent lists and don't pollute the named-agent roster.

## Persona + tool gate

Subagents run under a new `subagent` persona with a deliberately
narrow toolkit:

**Always available:**
- `whoami`, `log_activity`, `fetch_mail`, `send_mail` (parent-only)
- `search_memory`, `get_relevant_memory` (read)
- `submit_subagent_report` (new — the structured exit point)
- `request_extension` (new — asks parent for more time/tools)

**Available per subagent kind, configured at spawn time:**
- `read_file`, `read_url`, `web_search` for research / summarization
  / synthesis / extraction subagents
- `read_repo`, `git_log`, `git_diff` for code-investigation subagents
- `read_proposal`, `read_initiative`, `read_mail_thread` for
  PM-domain or extraction-from-mail subagents

**Never available (v1):**
- Any write tool (`save_memory`, `propose_changes`, `create_*`,
  `update_*`). Subagents *report* findings; only the parent acts.
- Any code-mutating tool. Subagents read code, they don't edit it.
- `spawn_subagent` itself — no recursive fan-out in v1. Parents
  spawn flat, not trees. (Open question below.)

The persona is enforced at the MCP layer the same way the existing
PM-vs-builder gates work. Adding a future "code-writer subagent"
persona would be a separate variant with a curated write toolkit;
not in scope here, not blocked architecturally.

## Lifecycle

### Spawn

```ts
interface SpawnSubagentInput {
  workspace_id: string;
  parent_agent_id: string;
  parent_run_id?: string;             // gardener_runs.id, etc; null for direct named-agent spawns
  kind:                                // shapes the persona toolkit + report expectations
    | 'summarize' | 'synthesize' | 'extract' | 'classify'
    | 'research' | 'verify' | 'reduce-topic';
  prompt: string;                     // self-contained task description
  material_refs?: MaterialRef[];      // see below — what the subagent should read
  toolkit: SubagentToolkit;           // which optional tools to enable
  budget: {
    max_tool_calls: number;
    max_output_tokens: number;
    deadline_ms: number;              // wall-clock cap
  };
  expected_report_shape?: JSONSchema; // structure the parent expects back
}

type MaterialRef =
  | { kind: 'url'; url: string; note?: string }
  | { kind: 'file'; path: string; note?: string }
  | { kind: 'repo_object'; repo: string; ref: string; path?: string; note?: string }
  | { kind: 'mail_thread'; thread_id: string; note?: string }
  | { kind: 'memory_entry'; entry_id: string; note?: string }
  | { kind: 'proposal'; proposal_id: string; note?: string }
  | { kind: 'initiative'; initiative_id: string; note?: string };

interface SpawnSubagentResult {
  subagent_run_id: string;
  agent_id: string;
  status: 'spawned';
}
```

`material_refs` is the heart of the context-offload pattern: the
parent names what to read, the subagent reads it. The MCP layer
validates that the subagent's toolkit covers the ref kinds attached
(e.g. `url` ref requires `read_url` in the toolkit).

Spawn is exposed two ways:

1. **MCP tool `spawn_subagent`** — callable by named agents
   (builder, coordinator, PM, gardener) under their existing personas.
   This is how a working agent offloads context mid-task. Persona
   gate restricts which agent kinds may spawn (in v1: any named
   agent; subagents themselves cannot).
2. **Internal API `spawnSubagent()`** — same underlying
   implementation, callable from privileged MC code (cron-driven
   gardener cycles, post-merge automation) without going through MCP.

Both paths:

1. Insert a `subagent_runs` row.
2. Mint the transient `agent_id` and register it with openclaw for
   the duration.
3. Post the prompt + materialized material refs to a fresh openclaw
   session keyed by `subagent_run_id`.
4. Return immediately — the parent awaits via the report channel,
   not a synchronous wait on the chat reply.

### Run

The subagent runs against openclaw exactly like a named agent:
receives its prompt, calls MCP tools, optionally `send_mail`s the
parent for partial findings or clarification asks, ultimately calls
`submit_subagent_report` with the structured output.

Mid-flight check-ins via `send_mail` are first-class. Examples:

- "Halfway through the commit history; here are the top 3 patterns
  so far. Should I continue or wrap up?"
- "I'm hitting a paywall on this URL — skip or surface as a partial?"
- "Found a contradiction with org memory entry #abc — flagging."

The orchestrator can read its mail mid-run and either reply (the
subagent reads it via `fetch_mail`), or let the subagent run to
completion. Two-way mail keeps the orchestration interactive without
forcing every subagent to be one-shot.

### Report

`submit_subagent_report` is the canonical exit:

```ts
interface SubagentReport {
  status: 'complete' | 'partial' | 'failed';
  summary_md: string;                 // ≤ configured token cap
  findings: Array<{                   // structured, machine-consumable
    body_md: string;
    confidence: number;               // 0..1
    citations: string[];              // URLs, file:line, commit shas, message-ids
  }>;
  unable_to_answer?: string[];        // questions the subagent could not resolve
  recommended_followups?: string[];   // hooks for the orchestrator
}
```

Calling this tool marks the subagent_runs row complete and signals
the orchestrator's await. The subagent's openclaw session is closed
shortly after (small grace window for the orchestrator to mail
"thanks, here's a follow-up" if it wants — but no recursion).

### Expire / timeout

If `deadline_ms` elapses without a report, the orchestration layer:

1. Sends a "wrap up now" mail to the subagent (final 30s grace).
2. If still no report, marks the row `status = 'timed_out'` and reaps
   the openclaw session.
3. Surfaces whatever partial check-ins were mailed back as a
   `partial` finding for the orchestrator's collection step.

Hard caps prevent runaway: any subagent hitting `max_tool_calls` or
`max_output_tokens` must report what it has so far via
`submit_subagent_report` with `status: 'partial'`.

## Fan-out collection

The orchestrator spawns N subagents (concurrent, bounded by the
per-cycle subagent cap), then awaits via:

```ts
const results = await collectSubagentReports({
  parent_run_id,
  expected_count: N,
  deadline_ms,
});
// results: SubagentReport[] (one per spawned, including partials and timeouts)
```

`collectSubagentReports` polls the `subagent_runs` table (or
subscribes via the same SSE channel pm_proposal events use). Returns
when all are complete OR `deadline_ms` elapses, whichever comes first.

Failure handling:
- Crashed subagent (openclaw error, MCP exception) → `status =
  'failed'` with `error` populated; orchestrator decides whether one
  failure aborts the cycle or it proceeds with remaining successes.
- Timed-out subagent → reported as `partial` if any mail was mailed
  back, else as a stub with `unable_to_answer = [<original prompt>]`.
- Mid-flight mail bounce (orchestrator unreachable) → not possible
  for in-process orchestrators; for cross-service orchestration,
  subagents queue mail to be delivered when parent reconnects (same
  pattern as `pm_pending_notes`).

## Storage

```sql
CREATE TABLE subagent_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  parent_agent_id TEXT NOT NULL,
  parent_run_kind TEXT NOT NULL,             -- 'gardener' | 'pm' | 'builder' | …
  parent_run_id TEXT NOT NULL,                -- gardener_runs.id, etc.
  agent_id TEXT NOT NULL,                     -- transient id assigned to subagent
  kind TEXT NOT NULL,                         -- 'research', 'verify', 'classify', ...
  prompt TEXT NOT NULL,
  toolkit_json TEXT NOT NULL,                 -- which tools enabled
  budget_json TEXT NOT NULL,                  -- caps
  status TEXT NOT NULL DEFAULT 'spawned'
    CHECK (status IN ('spawned','running','complete','partial','failed','timed_out')),
  report_json TEXT,                           -- SubagentReport when status final
  spawned_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  error TEXT
);
CREATE INDEX idx_subagent_runs_parent
  ON subagent_runs(parent_run_kind, parent_run_id, status);
CREATE INDEX idx_subagent_runs_agent
  ON subagent_runs(agent_id);
```

Mid-flight mail uses the existing mail table (subagents are MCP
agents; their mail is normal mail). The MCP layer enforces that
subagent `send_mail` only addresses `parent_agent_id`.

## Local-LLM-first considerations

Subagents reach LLM capacity via openclaw, same as named agents.
The model behind a subagent is whichever model the workspace's
openclaw gateway is configured for — local (Ollama, llama.cpp,
vLLM) or remote. No new direct LLM calls from MC code.

What MC's spawn layer must NOT do:
- Bake in a specific model or provider.
- Assume cloud-only round-trip latencies (subagents on local models
  may take 30-90s per check-in; budget defaults reflect that).
- Hardcode parallelism that overwhelms a single-GPU local setup.
  Per-cycle subagent cap is workspace-config (default 3 concurrent
  on a typical local box, configurable up to 20+ for cloud-backed
  workspaces).

## MCP surface

Three new tools registered in `src/lib/mcp/`:

- `spawn_subagent` — callable by named-agent personas (builder,
  coordinator, PM, gardener, learner). Not callable by the
  `subagent` persona (no recursion in v1). Wraps the internal
  spawn API; enforces caller-identity = `parent_agent_id`.
- `submit_subagent_report` — only callable by `subagent` persona.
  Validates against `expected_report_shape` if provided. Marks the
  run complete.
- `request_extension` — only callable by `subagent` persona. Opens
  a mail thread to the parent asking for more time or tools; parent
  replies via `send_mail` with a yes/no + new budget if applicable.

Plus internal API (not MCP-exposed) for privileged orchestrators:
- `spawnSubagent(input)` — the underlying spawn used by the MCP tool
  AND by cron-driven orchestrators (gardener cycles).
- `collectSubagentReports({ parent_run_id, deadline_ms })`
- `reapTimedOutSubagents()` — periodic cleanup, mirrors the existing
  drain workers in `instrumentation.ts`.

## Code layout

```
src/lib/subagents/
  index.ts                  # public API: spawnSubagent, collectSubagentReports
  persona.ts                # tool-gate definition for the 'subagent' persona
  lifecycle.ts              # spawn / monitor / reap
  reports.ts                # report validation + storage
  mail-gate.ts              # enforces parent-only send_mail
src/lib/mcp/
  spawn_subagent.ts         # new MCP tool (named-agent personas)
  submit_subagent_report.ts # new MCP tool (subagent persona)
  request_extension.ts      # new MCP tool (subagent persona)
```

## Backwards compatibility

Existing named agents are unaffected. The subagent persona is
purely additive. Orchestrators that don't fan out (most existing
flows) ignore the new surface entirely.

## Tests

- `src/lib/subagents/lifecycle.test.ts` — spawn → run → report
  round-trip with a fake openclaw client; material_refs are
  materialized into the subagent prompt; budget caps enforced;
  timeout produces `timed_out` status with mailed-partial findings
  surfaced.
- `src/lib/subagents/persona.test.ts` — write tools rejected;
  `send_mail` to non-parent rejected; `spawn_subagent` rejected
  when called by a subagent.
- `src/lib/subagents/spawn-mcp.test.ts` — named-agent persona can
  call `spawn_subagent`; toolkit validation rejects spawn when
  attached `material_refs` aren't covered by the toolkit.
- `src/lib/subagents/collect.test.ts` — fan-out of N subagents with
  mixed outcomes (success / partial / timeout / fail); deadline
  semantics; cancellation via parent.
- E2E (context offload): a builder agent calls `spawn_subagent`
  with kind=`synthesize` and 3 url + 1 file refs; observes the
  report return; asserts the builder's openclaw context never
  contains the raw material bodies.
- E2E (fan-out): gardener's verify pass spawns 3 verification
  subagents, two succeed, one times out → orchestrator emits a
  partial verify proposal noting the third was skipped.

## Open questions

- **Recursive fan-out.** A subagent that wants to spawn its own
  subagents would be a tree, not a flat fan-out. v1 forbids it
  (`spawn_subagent` not in the subagent persona) to keep the
  lifecycle simple. If a real workload needs it, the lifecycle
  reaper has to walk the tree.
- **Code-writing subagents.** Out of scope here. The architecture
  doesn't preclude a future `writer` persona variant with a curated
  write toolkit (e.g. `propose_diff` against a repo), but the v1
  use case is read-and-distill only. Adding writers later is a new
  persona class, not a redesign.
- **Cross-orchestrator subagents.** A subagent reporting to a
  non-MC orchestrator (e.g. an external tool driving MC via the
  MCP server) is not in scope. Parent must be an in-workspace agent.
- **Subagent observability.** A future operator UI for "what
  subagents are running right now" is useful but out of scope here.
  The `subagent_runs` table is the source of truth; UI is a
  follow-up.
- **Reuse of openclaw sessions.** Each subagent currently mints a
  fresh session. For workloads spawning hundreds of subagents in
  quick succession, session pool reuse may be worth adding —
  measure first.

## Verification

- `yarn typecheck && yarn test`.
- MCP smoke: `submit_subagent_report` and `request_extension`
  registered under the subagent persona only.
- Preview pass:
  1. Trigger a gardener verify run.
  2. Observe 3 subagent_runs rows appear with `status = 'running'`.
  3. Watch mid-flight mail land in the orchestrator's inbox.
  4. Confirm reports land, status flips to `complete`.
  5. `preview_logs` confirms no MCP write-tool calls from any
     subagent.

## Out of scope (followups)

- Subagent observability UI.
- Recursive fan-out (subagents spawning subagents).
- Cross-workspace subagents.
- Subagent session pooling / reuse.
- Parallel-subagent rate limiting beyond the per-cycle cap (e.g.
  per-tool, per-domain quotas for web research).
