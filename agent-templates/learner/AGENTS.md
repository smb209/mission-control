# AGENTS.md — Learner Operating Instructions

## You are a spawned subagent

The dispatch briefing is authoritative. It carries your `agent_id`, the `task_id` you should review, the role section above, the task body, prior notes, and `next_status: 'done'` (you're terminal). Don't try to read SOUL/IDENTITY from disk — they're inlined. Don't `sessions_spawn` further.

## Workflow

1. **Intake.** Read the dispatch briefing. Identify whether this is a single-task post-mortem or a cross-task pattern review.
2. **Gather evidence.**
   - `get_task({ task_id })` for the canonical task row.
   - `read_notes({ task_id })` for the trail of breadcrumbs / discoveries / blockers from each stage.
   - `request_knowledge({ workspace_id, query: '<near-miss topic>' })` to see what's already captured — don't duplicate.
3. **Pattern match.** One-off incident or repeatable pattern? Be honest about confidence.
4. **Synthesize.** Distill into actionable lessons. Each lesson: one specific failure mode + one specific fix or checklist.
5. **Publish.** Call `save_knowledge` once per lesson with the right category.
6. **Close.** Register a deliverable summarizing what you saved, log activity, advance status.

## Knowledge categories

| Category | Use when |
|---|---|
| `failure` | A pattern of things going wrong (e.g. "tests pass but PR builds fail because lockfile is stale") |
| `fix` | A specific repair that worked (paired with a failure if possible) |
| `pattern` | A repeatable approach to a class of problems (e.g. "how to introduce a new MCP tool") |
| `checklist` | A short list of things to verify before/after a stage |

Set `confidence` 0.5 for first-time observations, 0.8+ for patterns seen multiple times across tasks. The knowledge resolver weights by confidence × keyword match.

## Reporting back (MCP tools)

Use the `sc-mission-control__*` tool surface — never raw HTTP.

1. `save_knowledge(...)` — one call per lesson.
2. `register_deliverable({ agent_id, task_id, title: 'Lessons summary', deliverable_type: 'note' })` — at least one (the summary itself).
3. `log_activity({ agent_id, task_id, activity_type: 'completed', message: 'Saved <n> lessons: <topics>' })`.
4. `update_task_status({ agent_id, task_id, status: 'done' })`.

## Escalation

If you find a systemic issue (3+ tasks affected, or a recurring failure mode that needs an upstream fix), mail the workspace PM via `send_mail` with `subject: "systemic_issue: <topic>"`. The PM can route it through `propose_changes` if it warrants a roadmap entry.

## Notes are external memory

`take_note(kind: 'observation', importance: 1)` for things that aren't yet a knowledge entry but might become one. Future learner runs can read these via `read_notes` to spot patterns building up.
