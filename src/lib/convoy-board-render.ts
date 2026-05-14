/**
 * PM convoy mandate slice 7/7 — Task Board render helpers.
 *
 * The board renders convoy subtasks as first-class rows (they already had
 * `is_subtask = 1` cards before this slice). What this helper adds is the
 * "single-slice convoys are UI-collapsed" rule from the mandate spec:
 *
 *   docs/reference/pm-convoy-mandate.md (~lines 72-76):
 *   > A story that genuinely is "one builder owns this end-to-end"
 *   > decomposes to a 1-slice convoy. Convoy machinery underneath, plain-task
 *   > surface above. The Task Board renders 1-slice convoys as if they were
 *   > the parent task; the Convoy tab elides the ceremony.
 *
 * So we treat the convoy as ceremony and elide it whenever:
 *
 *   - the task is a convoy subtask (`is_subtask === 1`)
 *   - AND the owning convoy has exactly one slice (`convoy_total_subtasks === 1`)
 *
 * In that case the subtask card is hidden; the parent task in `convoy_active`
 * carries the operator-facing identity. Clicking the parent drills into the
 * convoy view where the single slice is still reachable.
 *
 * Multi-slice convoys are unchanged: parent stays visible AND the subtask
 * cards continue to render in their respective status columns. The parent
 * row gets a small "Convoy · N · M done" badge (rendered inline in
 * MissionQueue) so the operator can see progress at a glance.
 *
 * Tasks fed in here must have come from the GET /api/tasks endpoint, which
 * populates `convoy_summary` and `convoy_total_subtasks` via LEFT JOIN on
 * `convoys`. The helper has no DB access of its own — it's a pure transform
 * over the in-memory task list so the Zustand store can stay the source of
 * truth.
 */

import type { Task } from './types';

/**
 * Returns true when this subtask row should be hidden because its convoy
 * has exactly one slice (the parent task represents it instead).
 */
export function shouldHideSubtaskForCollapse(task: Task): boolean {
  if (!task.is_subtask) return false;
  return task.convoy_total_subtasks === 1;
}

/**
 * Filter a task list down to the rows the Task Board should render.
 * - Plain tasks: kept.
 * - Convoy parents: kept (badged via `task.convoy_summary` at render time).
 * - Multi-slice convoy subtasks: kept (first-class).
 * - Single-slice convoy subtasks: filtered out (collapsed under parent).
 */
export function filterTasksForBoard(tasks: Task[]): Task[] {
  return tasks.filter(t => !shouldHideSubtaskForCollapse(t));
}

/**
 * Convoy badge text for parent-task cards. NULL when the task has no active
 * convoy or the convoy is a single-slice (collapsed) convoy where the badge
 * would be redundant ceremony.
 */
export function convoyBadgeText(task: Task): string | null {
  const s = task.convoy_summary;
  if (!s) return null;
  // Single-slice convoys collapse to plain-task surface; no badge.
  if (s.total_subtasks <= 1) return null;
  const failed = s.failed_subtasks ?? 0;
  const base = `Convoy · ${s.total_subtasks} slices · ${s.completed_subtasks} done`;
  return failed > 0 ? `${base} · ${failed} failed` : base;
}
