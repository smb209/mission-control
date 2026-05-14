---
status: current
last-verified: 2026-05-13
code-anchors:
  - agent-templates/pm/SOUL.md
  - src/lib/agents/pm-dispatch.ts
  - src/lib/openclaw/client.ts
  - src/lib/types.ts
  - src/app/(app)/pm/page.tsx
  - src/app/api/pm/active-dispatch/route.ts
  - src/app/api/jobs/[id]/cancel/route.ts
mcp-tools:
  - propose_changes
  - get_roadmap_snapshot
db-tables:
  - pm_proposals
---

# PM chat prompt — reference

Reference doc for how the workspace PM agent splits between
planning-specialist mode (`propose_changes` with rich `impact_md`) and
conversational mode (status, clarifying Qs, "ping" replies), plus the
steer/abort + in-flight visibility layer that wraps it.

Both halves are shipped. See §"Open: queue mode UI" for the one
sub-scope still genuinely unresolved.

## Goals (numbered for easy reference)

**G1.** PM replies to conversational input with 1–4 sentences of text. Always.
**G2.** PM still calls `propose_changes` for inputs that warrant structural changes (date shifts, status updates, scoping, decomposition). Output discipline for that path is unchanged: tool call first, single-line `Proposal {id}.` reply.
**G3.** PM never emits a fully empty `final` chat_event. If unsure, asks a clarifying question.
**G4.** PM never calls `propose_changes` with `[]` — that produces a misleading 0-changes card.
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

**Output contract:**
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

## Hard rule (anti-silent-failure)

Every response MUST contain at least one of:
- a `propose_changes` tool call with a non-empty `proposed_changes` array, OR
- a chat reply of at least one full sentence (≥ 8 words).

If the model finds itself about to emit `Proposal {id}.` after a `propose_changes` call with `[]`, it must instead emit a Mode-B chat reply explaining what it considered and didn't propose.

If the model is uncertain which mode to use, default to Mode B with a clarifying question.

## Trigger_body shape

The dispatch trigger_body in `src/lib/agents/pm-dispatch.ts` is the
mode-picker, not a disruption framing. Snapshot is NOT pre-loaded;
the PM fetches via `get_roadmap_snapshot` (MCP) on demand. Shape:

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

The "Hard rule" line is verbatim. Embedded inline because models pattern-match more reliably against rules right next to the input than against rules buried in SOUL.md. `get_roadmap_snapshot` is registered at `src/lib/mcp/roadmap-tools.ts:284`.

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

## Locked design decisions

1. **Length cap for Mode B:** 1–4 sentences. Long-form ("explain X in detail") still ≤ 4 sentences — if the answer genuinely needs more, the PM suggests a more specific follow-up.

2. **Mode B → Mode A cascade:** Strictly two-turn. Operator asks "what's blocked?", PM replies in Mode B. If the operator wants action, they follow up with "Propose an update". The PM never tries to be helpful and silently produce a proposal when asked a question.

3. **Workspace snapshot:** On-demand via MCP, not pre-loaded into trigger_body. Cuts dispatch token cost for the common short-prompt case.

4. **Tone (emojis / casual):** Out of scope here — set in the PM's IDENTITY.md on the OpenClaw side.

5. **Multi-message dispatch (steering / abort):** Both wired up — see §"Steer / abort + in-flight visibility" below.

## Steer / abort + in-flight visibility

Turns the typing indicator into a live workspace where the operator can see what the PM is doing AND course-correct it. All shipped.

1. **RPC surface (`src/lib/openclaw/client.ts`).** `steerSession` at `:636` and `abortSession` at `:645` wrap the gateway's `sessions.steer` and `sessions.abort`. Also called from `src/app/api/jobs/[id]/cancel/route.ts:40` and `src/app/api/.../sessions/abort-matching/route.ts:106` for non-PM cancel paths.

2. **In-flight event broadcast.** During the dispatch await in `src/lib/agents/pm-dispatch.ts`, the gateway-streamed `chat_event` deltas and `agent_event` tool calls are tapped via `onEvent` and re-emitted onto the SSE bus as `pm_dispatch_in_flight` events (`src/lib/agents/pm-dispatch.ts:419,441,458`):
   - tool calls → `{ kind: 'tool_call', tool, phase, note }`
   - assistant deltas → `{ kind: 'delta', text }` (debounced via `DELTA_BROADCAST_INTERVAL_MS`)
   - control/final → `{ kind: 'control', control: 'final' }`

   Event type registered at `src/lib/types.ts:1054`.

3. **`/pm` UI — live work products + actions.** `src/app/(app)/pm/page.tsx:374,405` consumes `pm_dispatch_in_flight` events and surfaces the in-flight strip with Steer / Stop buttons. HTTP entry at `src/app/api/pm/active-dispatch/route.ts:78,81` dispatches the steer/abort action to the gateway.

4. **One-at-a-time send.** The chat send button (and Enter shortcut) is disabled while a dispatch is in flight; re-enables on success, error, or bounded fallback timeout.

5. **Recovery semantics.** When `sessions.abort` lands, the synth placeholder is left as-is but the chat message just says "stopped" — no misleading proposal card.

## Open: queue mode UI

OpenClaw's gateway protocol documents multiple queue modes — `interrupt`, `collect`, `followup`, `steer-backlog` — in addition to plain steer. MC's `steerSession` (`src/lib/openclaw/client.ts:636`) hard-codes the single-arg `sessions.steer` form and does not surface the mode choice in the UI.

The comment block at `src/lib/openclaw/client.ts:629-634` documents this as deliberate: per gateway validation responses, `sessions.steer` itself does NOT accept those `mode` variants — they're meant to be operator-driven via `/queue` slash modes embedded in the message text instead.

**Open question — unclear if this matches original intent.** The earlier spec draft (Decision #5 + PR-B step 5) framed the queue mode as something MC should surface as a per-button affordance. The shipped behavior delegates it to `/queue` slash modes that the operator types into the steer message. Either:
- (a) The `/queue` slash-mode delegation IS the intended design and this spec section should be closed.
- (b) MC should still expose the mode choice in the Steer button's UI (e.g. a small dropdown next to the input) and pass it through some other channel.

Decision needed from operator before any further work here.

## Decomposition output contract

(Available once `MC_PM_CONVOY_MANDATE=1` is enabled. Mirrors `agent-templates/pm/SOUL.md`; keep in lockstep. Full spec at [docs/proposals/pm-convoy-mandate.md](../proposals/pm-convoy-mandate.md).)

**When the PM decomposes a story or initiative** (`trigger_kind ∈ {decompose_story, decompose_initiative, plan_initiative}`), it emits a single `create_convoy_under_initiative` diff carrying the full slice DAG. The PM does NOT emit a flat list of `create_task_under_initiative` diffs for these triggers — that path is reserved for `notes_intake`, `manual`, and audit follow-ups. The schema rejects `create_task_under_initiative` from a decompose-flow proposal once the flag ships.

### DAG smell checklist

Before emitting a convoy diff, the PM sanity-checks the slices:

- Every slice should produce observable operator-facing behavior on its own. A bare "endpoint" or "DB column" slice without its consumer slice is a smell — fuse them, or add the consumer slice explicitly with `depends_on`.
- If a slice's acceptance criteria are all contract-shaped (status codes, type fields, function signatures) and none are feature-shaped (operator can click X → system does Y), the slice is too narrow.
- Default to fewer, broader slices. A 4-slice "endpoint + SSE + frontend + dispatcher" convoy almost always wants to be 1-2 slices owned by a builder who carries the feature end-to-end.

### Parent acceptance criteria

Each `create_convoy_under_initiative` diff must include `parent_acceptance_criteria` — the operator's observable criteria for the FEATURE being done, not per-slice contract criteria. These gate the parent task's `review → done` transition.

- Good: "Operator clicks Cancel on any in-flight proposal card → card disappears and a late agent reply doesn't resurrect it."
- Bad: "POST /api/pm/proposals/[id]/cancel returns 200 on valid input." (That's a slice-level contract AC.)

## Out of scope

- Changing how `propose_changes` itself works.
- The `notes_intake` flow (separate prompt path via `buildNotesIntakeMessage`).
- New MCP tools beyond `get_roadmap_snapshot`.
- Steer/abort UI for non-PM dispatches (workers, researchers, coordinators). The RPC infrastructure is generic; only `/pm` surfaces it today.
- PM tone / IDENTITY.md changes (lives upstream in OpenClaw).
