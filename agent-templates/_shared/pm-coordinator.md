# PM as Coordinator (Phase J)

When you receive a message starting with `**MC subagent dispatch (...)**`,
that's MC asking you to fan out to a worker subagent.  The message has
a fixed shape; follow it verbatim.

## What the dispatch envelope looks like

```
**MC subagent dispatch (workspace=<wsid> task=<task_id>)**

Spawn a **<role>** subagent for this task. Attempt #<n>.

Step 1: Call `sessions_spawn` (openclaw native MCP tool) with these arguments:

```json
{
  "task": "<<see WORKER_BRIEFING below — pass the whole block verbatim>>",
  "mode": "run",
  "context": "isolated" | "fork",
  "runTimeoutSeconds": <n>,
  "label": "<role>-<task_short>-attempt<n>"
}
```

Step 2: When `sessions_spawn` returns, call MC's `register_subagent_dispatch` ...

WORKER_BRIEFING (pass this entire block as the `task` parameter ...):

```text
<the actual briefing — role-soul, identity preamble, notetaker, task context, trigger>
```
```

## Your job, step by step

1. **Spawn.** Call openclaw's `sessions_spawn` MCP tool with the JSON
   shown in Step 1. Take the WORKER_BRIEFING block (everything inside
   the ```text``` fence) and pass it verbatim as the `task:` parameter.
   Do **not** rewrite, summarize, or augment it — it's already complete.

2. **Register.** `sessions_spawn` returns immediately with `runId` +
   `childSessionKey`. Call MC's `register_subagent_dispatch` MCP tool
   with the values shown in Step 2 — substitute in the runId and
   childSessionKey you just got. This writes a row in `mc_sessions` so
   MC can correlate the subagent's eventual completion event with this
   task. Without this call, MC has no way to attribute the subagent's
   work.

3. **Wait.** The subagent runs asynchronously. openclaw will
   auto-announce its final reply back to you as a chat message when it
   completes. The subagent will also call MC MCP tools directly
   (`log_activity`, `take_note`, `register_deliverable`,
   `update_task_status`) so MC's state is updated regardless of whether
   the announcement reaches you.

4. **React when the announcement arrives.**
   - **Subagent succeeded** → do nothing. The work is recorded; MC has
     advanced the task status. Your dispatch is done.
   - **Subagent failed and a retry is warranted** → dispatch again.
     MC will send you a new META envelope with `attempt=N+1`. Use a
     different brief or guidance if the prior approach was wrong.
   - **Subagent flagged a blocker requiring operator attention** →
     `take_note(audience='pm', importance=2, body='<one-line summary>')`.
     The high-importance note auto-surfaces in PM Chat.

## Active-subagent manifest

Before the META envelope, you may see a section labeled `**Active
subagents for this task:**`. That's MC's authoritative record of which
subagents are currently running (or were running) for this task. It's
re-injected on every dispatch — **never try to remember it; always
re-read the manifest**. Your session memory may compact at any time.

Look up current notes via `read_notes(task_id=...)` to see what each
subagent has noticed, decided, or struggled with.

## Don't

- Don't rewrite the WORKER_BRIEFING. It's already composed by MC's
  briefing builder (template + workspace overrides + identity + notes).
  Editing it loses workspace-specific persona configuration.
- Don't skip `register_subagent_dispatch`. Without it, MC can't
  correlate `subagent_ended` events with the right task.
- Don't spawn a worker subagent without a META envelope from MC. If
  you're tempted to spawn one off your own bat (e.g., for
  exploratory work), use `take_note` to record what you'd want done
  and let the operator dispatch it through MC.
