# AGENTS.md — mc-runner Operating Instructions

## Session startup

Load: SOUL.md, IDENTITY.md, USER.md, and the role briefing (passed as
the first chat message — for task dispatches the briefing already
contains the notetaker / messaging-protocol / shared-rules addenda
inlined; for direct chat the persona-init block carries the
persona's own SOUL/USER/AGENTS).

Do **not** try to read shared addenda from disk (`_shared/*.md`,
`SHARED-RULES.md`, etc.) at session start — they're either pushed to
you in the briefing or simply not relevant for the session you're in.
Reading them eagerly will fail because the gateway workspace doesn't
mirror MC's template tree layout.

## Two contexts you might be in

### 1. With a role briefing (the common case)

The dispatch briefing opens with:

```
Your agent_id is: <UUID>
Your gateway_agent_id is: mc-runner-dev

# Role: <builder|tester|reviewer|...>

<role's SOUL.md content>

## Task / Scope context
<task or scope-specific facts>

## Notes from prior work
<notes from earlier stages>

## What you should do
<the actual ask>
```

Treat the role section as your active SOUL. Treat the task context as
your starting facts. Treat prior notes as the previous stages'
breadcrumbs — read them, ack them via
`update_note({note_id, action: 'consume', stage_slug: '<your role>'})`
when processed.

### 2. Without a role briefing (anomaly)

If a chat arrives with no role section: pause, call `whoami`, reply
with the brief diagnostic in `runner-host/SOUL.md` §"Default behavior
without a role." Do not improvise a role.

## Session continuity

You may be running in a session that has prior trajectory. If your
context contains turns about previous tasks, that's intentional —
scope-keyed sessions reuse `sessionKey` deliberately so you can build
on prior work for the same scope.

Don't "reset" or "start fresh" unless the briefing explicitly says so.
Don't pretend earlier turns didn't happen. Do call `read_notes` early
to refresh what's been observed since you last saw this scope.

## Tool discipline

- `take_note` is cheap and spammable — leave breadcrumbs aggressively.
- `update_task_status`, `register_deliverable`, `propose_changes` are
  authoritative writes — do not call them speculatively.
- `whoami` is for verifying identity once at session start. Don't
  re-call it mid-session unless something is wrong.
- `read_notes` before committing to an approach.
- `update_note({action: 'consume', stage_slug})` when you act on a prior-stage note;
  `update_note({action: 'archive'})` when a note has gone stale for everyone.

## When you finish

Whatever role you're playing, end your turn with:

1. The required terminal MCP call for that role (e.g., `propose_changes`
   for PM, `update_task_status` for builder/tester/reviewer, `take_note`
   for researcher/learner).
2. A single-line reply identifying the work — e.g.
   `Proposal {id}.` or `Task {id} → review.` or `Run {n} complete.`
3. Nothing else. Freeform summaries are discarded.
