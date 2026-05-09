/**
 * Audit review-stage tasks before flipping MC_REVIEW_AUTOBOUNCE.
 *
 * Lists every `status='review'` task that:
 *   - has no reviewer assigned (no task_roles row with role='reviewer'),
 *   - has no task_evidence rows (no real verification ran), or
 *   - has been idle past the review SLA threshold.
 *
 * Operator runs this once before turning on MC_REVIEW_AUTOBOUNCE so the
 * stall scanner doesn't surprise them by bouncing legitimate in-flight
 * reviews. Output is plain text for easy paste into PR / verdict docs.
 *
 * Usage:
 *   yarn ts-node scripts/audit-review-stalls.ts
 *   STALL_DETECTION_MINUTES_REVIEW=20 yarn ts-node scripts/audit-review-stalls.ts
 */

import { queryAll, queryOne } from '../src/lib/db';

interface ReviewRow {
  id: string;
  title: string;
  workspace_id: string;
  updated_at: string;
  status_reason: string | null;
  last_activity_at: string | null;
  has_reviewer: number;
  evidence_count: number;
}

function thresholdMinutes(): number {
  const raw = process.env.STALL_DETECTION_MINUTES_REVIEW;
  if (!raw) return 20;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

function main() {
  const threshold = thresholdMinutes();
  const rows = queryAll<ReviewRow>(
    `SELECT
       t.id,
       t.title,
       t.workspace_id,
       t.updated_at,
       t.status_reason,
       (SELECT MAX(created_at) FROM task_activities WHERE task_id = t.id) AS last_activity_at,
       (SELECT COUNT(*) FROM task_roles WHERE task_id = t.id AND role = 'reviewer') AS has_reviewer,
       (SELECT COUNT(*) FROM task_evidence WHERE task_id = t.id) AS evidence_count
       FROM tasks t
      WHERE t.status = 'review'
      ORDER BY t.updated_at ASC`,
  );

  console.log(`# Review-stage audit (threshold ${threshold}m)\n`);
  console.log(`Total review-status tasks: ${rows.length}\n`);

  if (rows.length === 0) {
    console.log('No review-stage tasks. Safe to flip MC_REVIEW_AUTOBOUNCE.');
    return;
  }

  const nowMs = Date.now();
  const noReviewer: ReviewRow[] = [];
  const noEvidence: ReviewRow[] = [];
  const overSla: Array<ReviewRow & { idle_minutes: number }> = [];

  for (const row of rows) {
    if (Number(row.has_reviewer) === 0) noReviewer.push(row);
    if (Number(row.evidence_count) === 0) noEvidence.push(row);
    const lastTick = row.last_activity_at || row.updated_at;
    const idle = (nowMs - new Date(lastTick).getTime()) / 60_000;
    if (idle >= threshold) overSla.push({ ...row, idle_minutes: Math.round(idle) });
  }

  const print = (label: string, list: ReviewRow[]) => {
    console.log(`## ${label} (${list.length})`);
    if (list.length === 0) {
      console.log('(none)\n');
      return;
    }
    for (const r of list.slice(0, 50)) {
      const idle = (nowMs - new Date(r.last_activity_at || r.updated_at).getTime()) / 60_000;
      console.log(`- ${r.id} · ${r.workspace_id} · idle=${Math.round(idle)}m · ${r.title}`);
    }
    if (list.length > 50) console.log(`(${list.length - 50} more not shown)`);
    console.log('');
  };

  print('No reviewer assigned', noReviewer);
  print('No evidence rows', noEvidence);
  print(`Over SLA threshold (${threshold}m)`, overSla);

  console.log('---');
  console.log(`Recommendation: address every "Over SLA threshold" row before flipping MC_REVIEW_AUTOBOUNCE — otherwise the next scan will bounce ${overSla.length} task(s) automatically.`);

  // Cross-check: how many lack BOTH reviewer and evidence (highest risk).
  const bothMissing = rows.filter(r => Number(r.has_reviewer) === 0 && Number(r.evidence_count) === 0);
  if (bothMissing.length > 0) {
    console.log(`\n${bothMissing.length} task(s) lack BOTH reviewer and evidence — these are the highest-risk parking-lot rows.`);
  }
}

main();
