# PM chat prompt — lightweight spec

**Status:** Draft v1 — operator answered open questions; ready to implement.
Drives one PR that updates `agent-templates/pm/SOUL.md`,
`runDisruptionDispatchInBackground`'s `trigger_body`, and the `/pm`
chat input.

## Goal

Make the workspace PM agent useful as both a planning specialist (its current strength: structured `propose_changes` with rich `impact_md`) AND as a conversational interface (status checks, clarifying questions, "ping" replies, light steering).

## What's broken today

From investigation in #198 / #199:

1. **Silent-empty failure mode.** For vague prompts ("Hi PM", "Test", "Status check please"), the model emits a `chat_event` with `state=final` and **no `message` field at all**. Operator sees the typing indicator, then nothing.
2. **No graceful fallback.** When the model doesn't call `propose_changes`, MC's synth fallback shows a "Proposal — 0 changes" card (mitigated by #197 — now suppressed when there's truly nothing — but the underlying issue is the model not producing text).
3. **`Test`-style inputs aren't disambiguated.** SOUL recently grew a "conversational mode" carve-out, but the model still suppresses output. Either the conversational-mode rule isn't strong enough or the trigger_body framing is anchoring the model to "this is a disruption to analyse".

## Goals (numbered for easy reference)

**G1.** PM replies to conversational input with 1–4 sentences of text. Always.
**G2.** PM still calls `propose_changes` for inputs that warrant structural changes (date shifts, status updates, scoping, decomposition). Output discipline for that path is unchanged: tool call first, single-line `Proposal {id}.` reply.
**G3.** PM never emits a fully empty `final` chat_event. If unsure, asks a clarifying question.
**G4.** PM never calls `propose_changes` with `[]` — that produces a misleading 0-changes card. (Already covered in current SOUL but re-stating because it's the concrete failure shape we're trying to avoid.)
**G5.** The mode decision is made at the top of the response, deterministically, based on the operator's input. No mid-stream switching once the model commits.

## Mode taxonomy

Two modes the PM picks between, based on the operator's input.

### Mode A — Disruption / Planning

Triggers when the input describes a real change to roadmap state: dates shifting, owners blocked, status updates, new dependencies, decomposition asks, schedule pressure, etc.

Examples:
- `"Sarah is out next week — what slips?"`
- `"Refactor-X is blocked by upstream API changes; need to push it 2 weeks"`
- `"What's the impact of cancelling Initiative Foo?"`
- `"Decompose this epic into stories for May"`

**Output contract:** unchanged from today.
1. Call `propose_changes` first, with a structured `PmDiff[]` and rich `impact_md`.
2. After the tool returns, emit a single line: `Proposal {proposal_id}.`
3. All substance — headlines, bullets, recommendations — goes in `impact_md`. Keep it ≤ 8 bullets, each quantifying one effect.

### Mode B — Conversational

Triggers when the input is a question, status check, greeting, ambiguous prompt, or anything that doesn't warrant structural change.

Examples:
- `"Hi PM"` → greet back, offer next-step suggestions.
- `"Status check please"` → 2–3 sentence summary from the snapshot.
- `"What's blocked right now?"` → enumerate from snapshot.
- `"Test"`, `"ping"`, `"?"` → ask what the operator needs.
- `"What is X?"` (where X is an initiative / role / concept) → answer plainly.

**Output contract:**
1. Do NOT call `propose_changes`. Especially not with `[]`.
2. Reply with **1–4 sentences of plain text**. No `## Heading` formatting needed; this is chat, not a brief.
3. If the input is genuinely unclear, ask one clarifying question.
4. If you reference workspace state, lift it from the snapshot you were given — don't fabricate.

## Required behavior to prevent silent failures

**Hard rule:** every response MUST contain at least one of:
- a `propose_changes` tool call with a non-empty `proposed_changes` array, OR
- a chat reply of at least one full sentence (≥ 8 words).

If the model finds itself about to emit `Proposal {id}.` after a `propose_changes` call with `[]`, it must instead emit a Mode-B chat reply explaining what it considered and didn't propose.

If the model is uncertain which mode to use, default to Mode B with a clarifying question.

## Trigger_body changes

Currently the dispatch trigger_body always frames the input as "Operator-reported event", tells the agent to "analyse the disruption", AND inlines a workspace snapshot summary on every send.

Two problems with that:
1. Mode B inputs ("Hi PM", "Status check") get framed as disruption-analysis tasks, anchoring the model on the wrong mode.
2. The snapshot is unconditional — wastes context for short / conversational prompts that don't need it.

Proposed shape (snapshot dropped from default; PM fetches on demand via MCP):

```
**PM dispatch (correlation_id: …)**

Operator input:
> {trigger_text}

Pick mode per your SOUL:
- Mode A (disruption / planning): call propose_changes with PmDiff[] + impact_md, then `Proposal {id}.`
- Mode B (conversational): reply with 1–4 plain-text sentences. No propose_changes.

Tool tip: if you need workspace state to answer (status questions,
"what's blocked", impact analysis, planning), call
`get_roadmap_snapshot` via MCP. Skip it when the input doesn't need it
(greetings, clarifying questions, "Test").

Hard rule: emit at least one sentence OR one non-empty propose_changes
call. Never both empty.
```

The "Hard rule" line is verbatim. Embedded inline because models pattern-match more reliably against rules right next to the input than against rules buried in SOUL.md.

The `get_roadmap_snapshot` MCP tool is already registered (`src/lib/mcp/roadmap-tools.ts:284`) — no new endpoint needed.

## Examples we should be able to pass

| Input | Expected mode | Expected behavior |
|---|---|---|
| `"Hi PM"` | B | "Hi! …happy to help… anything you want me to look at?" (1–2 sentences) |
| `"Status check please"` | B | 2–3 sentence summary lifted from snapshot ("3 epics in progress, 2 stories blocked on …") |
| `"Test"` | B | Brief acknowledgement + ask what operator wants ("Got it — what would you like me to look at?") |
| `"What's blocked?"` | B | Enumerate blockers from snapshot |
| `"Sarah is out next week — what slips?"` | A | `propose_changes` with `add_availability` + cascading shifts; impact_md narrating |
| `"Decompose epic X into stories"` | A | `propose_changes` with `create_child_initiative[]`; impact_md narrating |
| `"What is the foia-pipeline initiative about?"` | B | Lift description from snapshot, 2–3 sentences |

## Decisions locked (operator-answered)

1. **Length cap for Mode B:** **1–4 sentences.** Long-form ("explain X in detail") still ≤ 4 sentences — if the answer genuinely needs more, the PM should suggest the operator follow up with a more specific question rather than dumping a wall of text.

2. **Mode B → Mode A cascade:** **Strictly two-turn.** Operator asks "what's blocked?", PM replies in Mode B. If the operator wants action, they follow up with "Propose an update". The PM never tries to be helpful and silently produce a proposal when asked a question.

3. **Workspace snapshot:** **On-demand via MCP, not pre-loaded into trigger_body.** The PM calls `get_roadmap_snapshot` (already registered) when it determines workspace state is needed. The trigger_body says "if you need workspace state, call this tool" — it's not always-on context. Cuts dispatch token cost for the common short-prompt case.

4. **Tone (emojis / casual):** **Out of scope here — set in the PM's IDENTITY.md on the OpenClaw side.** This spec doesn't constrain tone; that lives upstream of MC.

5. **Multi-message dispatch (steering / abort):** OpenClaw exposes `sessions.steer` (inject a new operator message into an active run, cancelling pending tool calls at the next model boundary) and `sessions.abort` (kill the active run). **MC's client doesn't call either today.** Decision: **wire both up**, paired with **visibility into in-process work products** (the agent's `take_note` / `log_activity` calls + streamed assistant deltas) so the operator can see what the PM is doing in real time and steer/abort intelligently — not just blindly toggle a "stop" button. Until that lands, default to one-at-a-time send.

## Implementation plan

The spec now spans two stacked PRs — **A: prompt + UI** (the shape of
the conversation) and **B: steer/abort + in-flight visibility** (live
control of an ongoing turn). A is the immediate fix; B unlocks
proper mid-flight UX.

### PR A — Prompt + one-at-a-time UI

1. **`agent-templates/pm/SOUL.md` — Output Discipline.** Replace the
   current two-mode draft with the locked-in version (1–4 sentence cap,
   no Mode B→A cascade, hard rule on non-empty output).
2. **`src/lib/agents/pm-dispatch.ts` — `runDisruptionDispatchInBackground` trigger_body.**
   - Drop the inline workspace snapshot summary.
   - Replace "analyse the disruption" framing with the mode-picker.
   - Append the verbatim "Hard rule" line.
   - The `notes_intake` path stays separate via `buildNotesIntakeMessage`.
3. **`src/lib/agents/pm-dispatch.ts` — drop snapshot precompute.**
   The current code calls `getRoadmapSnapshot()` and inlines it. Once
   the PM fetches on demand, that precompute is dead weight. Audit
   whether `synthesizeImpactAnalysis` still needs it — if so, keep it
   for that path only.
4. **`src/app/(app)/pm/page.tsx` — one-at-a-time send UI.**
   - Disable the chat send button (and Enter shortcut) while a
     dispatch is in flight.
   - Existing typing indicator surfaces the in-flight state (PR B
     enriches this with live notes).
   - Re-enable when the dispatch resolves (success, error, OR a
     bounded fallback: 3× `namedAgentTimeoutMs` so the operator
     isn't locked out forever in the silent-PM case).

### PR B — `sessions.steer` / `sessions.abort` + in-flight visibility

Goal: turn the typing indicator into a live workspace where the
operator can see what the PM is doing AND course-correct it.

1. **`src/lib/openclaw/client.ts` — RPC surface.** Add `steerSession`
   and `abortSession` wrappers around the existing `call()` primitive,
   matching the gateway's `sessions.steer` and `sessions.abort` shapes.
   Smoke-test against the dev gateway.

2. **In-flight event capture.** During `runDisruptionDispatchInBackground`'s
   `dispatchScope` await, the gateway streams `chat_event` deltas and
   `agent_event` payloads (tool calls — including `take_note`,
   `log_activity`, `propose_changes`). Today we collect them privately
   inside `sendChatAndAwaitReply`. Wire an `onEvent` tap that emits
   each event (post-filtered) onto our SSE bus as
   `pm_dispatch_in_flight` events:
   - tool calls → `{ kind: 'tool_call', name, summary }`
   - assistant deltas → `{ kind: 'delta', text }` (debounced /
     batched so we don't spam at every token).
   - errors / aborts → `{ kind: 'control', state }`.

3. **`/pm` UI — live work products panel.** Replace the static typing
   indicator with a small in-flight strip that surfaces the events
   above:
   - "PM is reading workspace state…" (when `get_roadmap_snapshot` fires)
   - "PM noted: …" (one line per `take_note`)
   - "PM is composing a proposal…" (when `propose_changes` is in flight)
   - Streaming text preview (last ~200 chars of accumulated delta).

   Two action buttons next to the strip:
   - **Steer** — opens a small inline input. Operator types
     additional context; on submit, MC calls `sessions.steer` with
     the new message; the run continues but with the steer
     injected at the next model boundary.
   - **Stop** — calls `sessions.abort` for the dispatch session.
     The chat thread records "Operator stopped this turn" and the
     send button re-enables immediately.

4. **Recovery semantics.** When `sessions.abort` lands, the synth
   placeholder is left as-is (same as today's silent-timeout path)
   but the chat message just says "stopped" — no misleading
   proposal card.

5. **Handle the steer queue mode.** OpenClaw's gateway has multiple
   queue modes (`steer`, `interrupt`, `collect`, `followup`,
   `steer-backlog`). Default to `steer` for our case (queue at next
   boundary) — that matches the operator-typed-too-fast scenario
   without aborting work. Surface the mode choice as a per-button
   detail rather than the full mode taxonomy in the UI.

## Verification

### PR A

- Mode A canary: `"Sarah is out next week — what slips?"` → expect
  `propose_changes` call with `add_availability` + cascading shifts.
- Mode B canaries: `"Hi PM"`, `"Status check please"`, `"What's blocked?"`,
  `"Test"` → each should produce 1–4 sentences. The blocked-state
  example should also see the PM call `get_roadmap_snapshot` first.
- Hard-rule canary: capture chat thread shape — never an empty
  assistant message, never a "Proposal — 0 changes" card.
- Send-button canary: send two prompts in rapid succession — second
  should be blocked / queued locally until first resolves.

### PR B

- Live notes: ask `"What's blocked?"` and confirm the in-flight strip
  shows `get_roadmap_snapshot` firing, then any `take_note` calls,
  then the streaming reply preview.
- Steer canary: while a Mode A dispatch is in flight, click Steer
  and inject `"actually only consider initiatives owned by Sarah"`.
  Confirm the resulting proposal reflects the steered constraint.
- Abort canary: while a dispatch is in flight, click Stop. Confirm
  `sessions.abort` lands, the chat thread shows a "stopped" line,
  and the send button re-enables. Subsequent send works normally.
- Stale-event canary: trigger a dispatch, abort midway, send a new
  prompt. Confirm we don't see lingering `pm_dispatch_in_flight`
  deltas from the aborted run leaking into the new turn.

## Out of scope

- Changing how `propose_changes` itself works.
- The `notes_intake` flow (separate prompt path).
- New MCP tools (we use the existing `get_roadmap_snapshot`).
- Steer/abort for non-PM dispatches (workers, researchers,
  coordinators). The infrastructure added in PR B is generic but
  the UI lives in `/pm`. Other surfaces are a follow-up.
- PM tone / IDENTITY.md changes (lives upstream in OpenClaw).
- The bulk-vs-per-session reset infrastructure (already shipped in #199).
