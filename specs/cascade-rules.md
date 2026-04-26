# Schema FK Cascade Rules

**Last touched:** migration 048 (`fk_cascade_safety`)
**Guardrail test:** `src/lib/db/schema-cascade.test.ts`

Mission Control's data model has a small set of "top-level" entities — workspaces, tasks, agents, initiatives, products, ideas — and a long tail of auxiliary tables that reference them. When a top-level row is deleted, every FK pointing at it must declare what happens to the dependent row.

This page is the source of truth for those decisions. The guardrail test enforces that no FK to a guarded parent is left as a plain reference — every FK gets either `ON DELETE CASCADE` or `ON DELETE SET NULL`.

## Decision rule

- **`ON DELETE CASCADE`** when the dependent row is meaningless without its parent. e.g. `task_deliverables` without a `task` is garbage; `convoy_subtasks` without a `convoy` is garbage; `agent_health` without an `agent` is garbage.
- **`ON DELETE SET NULL`** when the dependent row should survive but lose context. Audit-trail rows (`events`, `task_initiative_history`, `initiative_parent_history`), durable user-facing artifacts (`ideas`, `knowledge_entries`, `content_inventory`, `product_skills`), and rows that just happen to mention the parent for context (`tasks.assigned_agent_id`, `tasks.initiative_id`) all SET NULL.

## Cascade matrix (top-level entities)

### `workspaces`

Everything below cascades. Deleting a workspace empties it and removes the workspace row itself.

| Child table | Column | Rule |
|---|---|---|
| `agents` | `workspace_id` | CASCADE |
| `tasks` | `workspace_id` | CASCADE |
| `workflow_templates` | `workspace_id` | CASCADE |
| `knowledge_entries` | `workspace_id` | CASCADE |
| `rollcall_sessions` | `workspace_id` | CASCADE |
| `products` | `workspace_id` | CASCADE |
| `cost_events` | `workspace_id` | CASCADE |
| `cost_caps` | `workspace_id` | CASCADE |
| `initiatives` | `workspace_id` | CASCADE |
| `pm_proposals` | `workspace_id` | CASCADE |

### `tasks`

| Child table | Column | Rule | Notes |
|---|---|---|---|
| `planning_questions` | `task_id` | CASCADE | |
| `planning_specs` | `task_id` | CASCADE | |
| `task_roles` | `task_id` | CASCADE | |
| `task_activities` | `task_id` | CASCADE | |
| `task_deliverables` | `task_id` | CASCADE | |
| `work_checkpoints` | `task_id` | CASCADE | |
| `task_notes` | `task_id` | CASCADE | |
| `user_task_reads` | `task_id` | CASCADE | |
| `task_initiative_history` | `task_id` | CASCADE | |
| `workspace_ports` | `task_id` | CASCADE | |
| `workspace_merges` | `task_id` | CASCADE | |
| `convoys` | `parent_task_id` | CASCADE | |
| `convoy_subtasks` | `task_id` | CASCADE | |
| `openclaw_sessions` | `task_id` | CASCADE | session is bound to task lifetime |
| `skill_reports` | `task_id` | CASCADE | report is part of the task that produced it |
| `conversations` | `task_id` | SET NULL | chat history survives |
| `events` | `task_id` | SET NULL | audit trail survives |
| `agent_health` | `task_id` | SET NULL | last-observed health survives end-of-task |
| `agent_mailbox` | `task_id` | SET NULL | mail outlives transient task scoping |
| `knowledge_entries` | `task_id` | SET NULL | knowledge is durable |
| `ideas` | `task_id` | SET NULL | idea outlives the build task |
| `content_inventory` | `task_id` | SET NULL | content survives the task that produced it |
| `product_skills` | `created_by_task_id` | SET NULL | skill is durable |
| `cost_events` | `task_id` | SET NULL | billing rows survive |

### `agents`

| Child table | Column | Rule | Notes |
|---|---|---|---|
| `task_roles` | `agent_id` | CASCADE | NOT NULL — role assignment requires an agent |
| `work_checkpoints` | `agent_id` | CASCADE | NOT NULL |
| `agent_health` | `agent_id` | CASCADE | |
| `agent_chat_messages` | `agent_id` | CASCADE | |
| `owner_availability` | `agent_id` | CASCADE | |
| `openclaw_sessions` | `agent_id` | CASCADE | session is owned by agent |
| `agent_mailbox` | `from_agent_id`, `to_agent_id` | CASCADE | NOT NULL — see "Tradeoffs" below |
| `rollcall_sessions` | `initiator_agent_id` | CASCADE | NOT NULL |
| `rollcall_entries` | `target_agent_id` | CASCADE | NOT NULL |
| `conversation_participants` | `agent_id` | CASCADE | join row dies with member |
| `tasks` | `assigned_agent_id`, `created_by_agent_id` | SET NULL | task survives agent loss |
| `messages` | `sender_agent_id` | SET NULL | audit trail |
| `events` | `agent_id` | SET NULL | audit trail |
| `task_activities` | `agent_id` | SET NULL | activity log survives |
| `knowledge_entries` | `created_by_agent_id` | SET NULL | knowledge is durable |
| `research_cycles` | `agent_id` | SET NULL | cycle audit survives |
| `cost_events` | `agent_id` | SET NULL | billing rows survive |
| `operations_log` | `agent_id` | SET NULL | audit |
| `product_skills` | `created_by_agent_id` | SET NULL | skill is durable |
| `initiatives` | `owner_agent_id` | SET NULL | initiative survives owner change |
| `initiative_parent_history` | `moved_by_agent_id` | SET NULL | audit |
| `task_initiative_history` | `moved_by_agent_id` | SET NULL | audit |
| `pm_proposals` | `applied_by_agent_id` | SET NULL | proposal survives |

### `initiatives`

`deleteInitiative` blocks deletion when descendants exist (see `initiatives.ts`), so most of these are belt-and-suspenders, not load-bearing.

| Child table | Column | Rule |
|---|---|---|
| `initiative_dependencies` | `initiative_id`, `depends_on_initiative_id` | CASCADE |
| `initiative_parent_history` | `initiative_id` | CASCADE |
| `tasks` | `initiative_id` | SET NULL |
| `ideas` | `initiative_id` | SET NULL |
| `initiatives` | `parent_initiative_id` | SET NULL |
| `initiative_parent_history` | `from_parent_id`, `to_parent_id` | SET NULL |
| `task_initiative_history` | `from_initiative_id`, `to_initiative_id` | SET NULL |

### `products`

| Child table | Column | Rule |
|---|---|---|
| `research_cycles`, `ideation_cycles`, `autopilot_activity_log`, `ideas`, `idea_embeddings`, `idea_suppressions`, `swipe_history`, `preference_models`, `maybe_pool`, `product_feedback`, `product_schedules`, `operations_log`, `content_inventory`, `social_queue`, `seo_keywords`, `product_health_scores`, `product_program_variants`, `product_ab_tests`, `product_skills` | `product_id` | CASCADE |
| `tasks` | `product_id` | SET NULL |
| `cost_events` | `product_id` | SET NULL |
| `cost_caps` | `product_id` | SET NULL (downgrade to workspace-scope) |
| `initiatives` | `product_id` | SET NULL |

### `ideas`

| Child table | Column | Rule |
|---|---|---|
| `idea_embeddings`, `swipe_history`, `maybe_pool` | `idea_id` | CASCADE |
| `idea_suppressions` | `similar_to_idea_id` | CASCADE |
| `tasks` | `idea_id` | SET NULL |
| `ideas` | `resurfaced_from` | SET NULL |
| `product_feedback`, `content_inventory`, `social_queue` | `idea_id` | SET NULL |
| `initiatives` | `source_idea_id` | SET NULL |

## Tradeoffs worth flagging

**`agent_mailbox.from_agent_id` / `to_agent_id` are CASCADE, not SET NULL.**
The columns are NOT NULL by structural design (mail must have sender + recipient). To preserve mail across agent deletion we'd have to drop the NOT NULL constraint. We chose the simpler route: deleting an agent purges their inbox / outbox. If you later want mail to survive (e.g. for compliance auditing), drop NOT NULL on both columns and switch the FK action to SET NULL.

**`rollcall_sessions.initiator_agent_id`, `rollcall_entries.target_agent_id` are CASCADE.**
Same reasoning — NOT NULL columns, transient state, no compelling audit need.

**`work_checkpoints.agent_id` is CASCADE.**
NOT NULL. Checkpoint is meaningless without the agent that produced it; CASCADE matches the structural intent.

## Guardrail

`src/lib/db/schema-cascade.test.ts` parses the schema (compiled into a fresh in-memory DB) and asserts:

1. Every FK to a guarded parent (workspaces, tasks, agents, initiatives, products, ideas, convoys, conversations, research_cycles, rollcall_sessions, workflow_templates, product_skills, product_program_variants, pm_proposals, agent_mailbox) carries `ON DELETE CASCADE` or `ON DELETE SET NULL` — never bare `NO ACTION`.
2. Every `workspace_id` FK is `CASCADE` (workspace-scoped rows are never durable past workspace deletion).

When you add a new table, the test will tell you exactly which FK is missing its delete rule. Update both `schema.ts` and `migrations.ts` (the next pending migration), then update this page if the new entity is itself a "top-level" parent.
