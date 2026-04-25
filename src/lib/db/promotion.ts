/**
 * Promotion DB helpers (Phase 2 of the roadmap planning layer).
 *
 * Three operator-driven promotion edges, all atomic, all audited:
 *   1. idea  → initiative   (creates initiative, idea retained, idea.initiative_id set)
 *   2. story → task(draft)  (creates task in status='draft', writes initial audit row)
 *   3. task(draft) → task(inbox) (status flip, event emitted)
 *
 * See specs/roadmap-and-pm-spec.md §3.3 (Promotion edges) and §13 (Workflow
 * unification). Phase 1 already implemented attachTaskToInitiative and
 * moveTaskToInitiative — those are reused here, not reimplemented.
 *
 * All multi-row writes go through `transaction()` so the audit row and the
 * state change are atomic per the spec invariant in §6.1.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb, queryAll, queryOne, run } from '@/lib/db';
import type { Initiative } from './initiatives';

/**
 * Internal row shape for the JOIN we expose via getTaskInitiativeHistory.
 * The route handler returns this shape directly (callers don't need a
 * separate type — the field set is API-stable).
 */
export interface TaskInitiativeHistoryRow {
  id: string;
  task_id: string;
  from_initiative_id: string | null;
  from_initiative_title: string | null;
  to_initiative_id: string | null;
  to_initiative_title: string | null;
  reason: string | null;
  moved_by_agent_id: string | null;
  created_at: string;
}

export interface PromoteInitiativeToTaskInput {
  task_title?: string;
  task_description?: string | null;
  status_check_md?: string | null;
  created_by_agent_id?: string | null;
  reason?: string | null;
}

/**
 * Promote a story-kind initiative to a draft task. Creates one task row
 * with status='draft' and initiative_id set, plus an initial
 * task_initiative_history row (from_initiative_id=NULL).
 *
 * Throws when the initiative isn't kind='story' — the operator must convert
 * theme/milestone/epic to story first (per spec §3.3).
 */
export function promoteInitiativeToTask(
  initiative_id: string,
  input: PromoteInitiativeToTaskInput = {},
): { id: string } {
  const initiative = queryOne<Initiative>(
    'SELECT * FROM initiatives WHERE id = ?',
    [initiative_id],
  );
  if (!initiative) {
    throw new Error(`Initiative not found: ${initiative_id}`);
  }
  if (initiative.kind !== 'story') {
    throw new Error(
      'Only story-kind initiatives can be promoted to tasks. Convert this initiative to a story first.',
    );
  }

  const taskId = uuidv4();
  const now = new Date().toISOString();
  const title = (input.task_title ?? initiative.title).trim() || initiative.title;

  // The default workflow template, like /api/tasks POST does, so promoted
  // drafts behave consistently when later moved to inbox.
  const defaultTemplate = queryOne<{ id: string }>(
    'SELECT id FROM workflow_templates WHERE workspace_id = ? AND is_default = 1 LIMIT 1',
    [initiative.workspace_id],
  );
  const workflowTemplateId = defaultTemplate?.id ?? null;

  // Single transaction: insert task, audit row, event.
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks (
         id, title, description, status, priority, workspace_id, business_id,
         workflow_template_id, initiative_id, status_check_md,
         created_by_agent_id, created_at, updated_at
       ) VALUES (?, ?, ?, 'draft', 'normal', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      title,
      input.task_description ?? initiative.description ?? null,
      initiative.workspace_id,
      // Tasks have a NOT NULL business_id; reuse the workspace_id as the
      // legacy business_id when none is set, matching seed and existing
      // task creation defaults.
      initiative.workspace_id,
      workflowTemplateId,
      initiative_id,
      input.status_check_md ?? null,
      input.created_by_agent_id ?? null,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO task_initiative_history (
         id, task_id, from_initiative_id, to_initiative_id,
         moved_by_agent_id, reason, created_at
       ) VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    ).run(
      uuidv4(),
      taskId,
      initiative_id,
      input.created_by_agent_id ?? null,
      input.reason ?? 'initial promotion',
      now,
    );
    db.prepare(
      `INSERT INTO events (id, type, agent_id, task_id, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      uuidv4(),
      'task_promoted_from_initiative',
      input.created_by_agent_id ?? null,
      taskId,
      `Task drafted from initiative: ${initiative.title}`,
      JSON.stringify({ initiative_id }),
      now,
    );
  })();

  return { id: taskId };
}

export interface PromoteTaskToInboxInput {
  reason?: string | null;
  promoted_by_agent_id?: string | null;
}

/**
 * Transition a draft task to inbox. Throws when the current status isn't
 * 'draft' — promotion is the *only* draft → inbox edge per spec §13.2.
 * Emits a `task_promoted_to_inbox` event row in the same transaction.
 */
export function promoteTaskToInbox(
  task_id: string,
  input: PromoteTaskToInboxInput = {},
): { id: string; status: string } {
  const task = queryOne<{ id: string; title: string; status: string }>(
    'SELECT id, title, status FROM tasks WHERE id = ?',
    [task_id],
  );
  if (!task) {
    throw new Error(`Task not found: ${task_id}`);
  }
  if (task.status !== 'draft') {
    throw new Error(
      `Task is not in draft status (current: ${task.status}). Only drafts can be promoted to inbox.`,
    );
  }

  const now = new Date().toISOString();
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      "UPDATE tasks SET status = 'inbox', updated_at = ? WHERE id = ?",
    ).run(now, task_id);
    db.prepare(
      `INSERT INTO events (id, type, agent_id, task_id, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      uuidv4(),
      'task_promoted_to_inbox',
      input.promoted_by_agent_id ?? null,
      task_id,
      `Promoted draft to inbox: ${task.title}`,
      input.reason ? JSON.stringify({ reason: input.reason }) : null,
      now,
    );
  })();

  return { id: task_id, status: 'inbox' };
}

export interface PromoteIdeaToInitiativeInput {
  kind?: 'theme' | 'milestone' | 'epic' | 'story';
  parent_initiative_id?: string | null;
  copy_description?: boolean;
  created_by_agent_id?: string | null;
}

export interface PromoteIdeaResult {
  initiative: Initiative;
  alreadyPromoted: boolean;
}

/**
 * Promote an idea to an initiative. Sibling of the existing idea→task
 * autopilot path; both can coexist on the same idea.
 *
 * Idempotency: when ideas.initiative_id is already set, returns the
 * existing initiative with alreadyPromoted=true (the route handler maps
 * this to HTTP 409, per spec §10).
 */
export function promoteIdeaToInitiative(
  idea_id: string,
  input: PromoteIdeaToInitiativeInput = {},
): PromoteIdeaResult {
  const idea = queryOne<{
    id: string;
    title: string;
    description: string | null;
    product_id: string | null;
    initiative_id: string | null;
  }>(
    'SELECT id, title, description, product_id, initiative_id FROM ideas WHERE id = ?',
    [idea_id],
  );
  if (!idea) {
    throw new Error(`Idea not found: ${idea_id}`);
  }
  if (idea.initiative_id) {
    const existing = queryOne<Initiative>(
      'SELECT * FROM initiatives WHERE id = ?',
      [idea.initiative_id],
    );
    if (existing) {
      return { initiative: existing, alreadyPromoted: true };
    }
    // Stale pointer — fall through and let the operator (or this call)
    // create a fresh initiative; we don't auto-clear because that would
    // hide a data-integrity issue from the operator.
    throw new Error(
      `Idea references missing initiative ${idea.initiative_id}; resolve manually before re-promoting`,
    );
  }

  // Resolve the workspace from the product, since ideas don't carry it
  // directly. Falls back to 'default' to mirror the rest of the codebase.
  const productRow = idea.product_id
    ? queryOne<{ workspace_id: string }>(
        'SELECT workspace_id FROM products WHERE id = ?',
        [idea.product_id],
      )
    : null;
  const workspace_id = productRow?.workspace_id ?? 'default';

  const initiativeId = uuidv4();
  const now = new Date().toISOString();
  const kind = input.kind ?? 'story';
  const copyDescription = input.copy_description ?? true;

  if (input.parent_initiative_id) {
    const parent = queryOne<{ id: string }>(
      'SELECT id FROM initiatives WHERE id = ?',
      [input.parent_initiative_id],
    );
    if (!parent) {
      throw new Error(`Parent initiative not found: ${input.parent_initiative_id}`);
    }
  }

  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO initiatives (
         id, workspace_id, product_id, parent_initiative_id, kind, title,
         description, status, source_idea_id, sort_order, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', ?, 0, ?, ?)`,
    ).run(
      initiativeId,
      workspace_id,
      idea.product_id ?? null,
      input.parent_initiative_id ?? null,
      kind,
      idea.title,
      copyDescription ? idea.description : null,
      idea_id,
      now,
      now,
    );
    db.prepare(
      'UPDATE ideas SET initiative_id = ?, updated_at = ? WHERE id = ?',
    ).run(initiativeId, now, idea_id);
    db.prepare(
      `INSERT INTO events (id, type, agent_id, message, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      uuidv4(),
      'idea_promoted_to_initiative',
      input.created_by_agent_id ?? null,
      `Idea promoted to initiative (${kind}): ${idea.title}`,
      JSON.stringify({ idea_id, initiative_id: initiativeId, kind }),
      now,
    );
  })();

  const created = queryOne<Initiative>(
    'SELECT * FROM initiatives WHERE id = ?',
    [initiativeId],
  )!;
  return { initiative: created, alreadyPromoted: false };
}

/**
 * Provenance trail for one task: every task_initiative_history row in
 * chronological order, with both initiative titles joined for convenience.
 * Null initiative ids stay null in the join (LEFT JOIN), preserving the
 * "first row from_initiative_id=NULL" invariant from spec §6.1.
 */
export function getTaskInitiativeHistory(task_id: string): TaskInitiativeHistoryRow[] {
  return queryAll<TaskInitiativeHistoryRow>(
    `SELECT
       h.id,
       h.task_id,
       h.from_initiative_id,
       i_from.title AS from_initiative_title,
       h.to_initiative_id,
       i_to.title AS to_initiative_title,
       h.reason,
       h.moved_by_agent_id,
       h.created_at
     FROM task_initiative_history h
     LEFT JOIN initiatives i_from ON i_from.id = h.from_initiative_id
     LEFT JOIN initiatives i_to   ON i_to.id   = h.to_initiative_id
     WHERE h.task_id = ?
     ORDER BY h.created_at ASC, h.id ASC`,
    [task_id],
  );
}

/**
 * Emit the `initiative_kind_changed` event row that resolves spec §16 #5.
 * Phase 1's convertInitiative helper intentionally took agent/reason params
 * but did not emit an event; this is the Phase 2 follow-up that the
 * /convert route handler now calls.
 */
export function emitConvertEvent(opts: {
  initiative_id: string;
  initiative_title: string;
  from_kind: string;
  to_kind: string;
  agent_id?: string | null;
  reason?: string | null;
}): void {
  if (opts.from_kind === opts.to_kind) return;
  run(
    `INSERT INTO events (id, type, agent_id, message, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      uuidv4(),
      'initiative_kind_changed',
      opts.agent_id ?? null,
      `Initiative converted: ${opts.initiative_title} (${opts.from_kind} → ${opts.to_kind})`,
      JSON.stringify({
        initiative_id: opts.initiative_id,
        from_kind: opts.from_kind,
        to_kind: opts.to_kind,
        ...(opts.reason ? { reason: opts.reason } : {}),
      }),
      new Date().toISOString(),
    ],
  );
}

