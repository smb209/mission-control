/**
 * Scheduled-run eval scenario for research phase 2.
 *
 * Drives the recurring_jobs scheduler's research dispatch path
 * end-to-end: create workspace + researcher + runner, create a
 * topic, attach a 1-second-cadence schedule, force-fire it via
 * `dispatchRecurringJobOnce`, and assert that a brief row landed
 * and the recurring_jobs counters advanced.
 *
 * Uses the same canned-reply stubbing as `runner.ts` so the harness
 * works without a live gateway. RP2.S6.1 in
 * specs/research-phase-2-validation/02-test-plan.md.
 */

import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { run, queryOne } from '@/lib/db';
import { createTopic } from '@/lib/db/topics';
import {
  createResearchSchedule,
  getRecurringJob,
} from '@/lib/db/recurring-jobs';
import {
  __setSendChatClientForTests,
  type ChatEvent,
  type SendChatClient,
} from '@/lib/openclaw/send-chat';
import { dispatchRecurringJobOnce } from '@/lib/agents/recurring-scheduler';

export interface ScheduleEvalReport {
  run_id: string;
  started_at: string;
  completed_at: string;
  workspace_id: string;
  topic_id: string;
  schedule_id: string;
  brief_id: string | null;
  brief_status: 'complete' | 'failed' | 'missing';
  schedule_run_count_after: number;
  schedule_consecutive_failures_after: number;
  passed: boolean;
}

export interface ScheduleEvalOptions {
  outputDir?: string;
  /** Canned reply the stubbed gateway emits. Defaults to a minimal
   *  brief-shaped markdown so the rubric / parsing doesn't barf. */
  cannedReply?: string;
}

const DEFAULT_REPLY =
  '## Research Brief — schedule eval\n\n' +
  '### Executive summary\n\nScheduled brief produced by the eval harness.\n\n' +
  '### Citations\n\n- [example](https://example.com)\n';

function ensureWorkspace(): string {
  const id = `ws-sched-eval-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function ensureResearcherAndRunner(workspaceId: string): void {
  run(
    `INSERT OR IGNORE INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, source, is_active, created_at, updated_at)
     VALUES (?, 'mc-researcher-sched-eval', 'researcher', '🔍', 'standby', 0, ?, 'local', 1, datetime('now'), datetime('now'))`,
    [`agent-sched-${workspaceId.slice(-8)}`, workspaceId],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES ('default', 'default', 'default', datetime('now'))`,
  );
  run(
    `INSERT OR IGNORE INTO agents
       (id, name, role, avatar_emoji, status, is_master, workspace_id, source, gateway_agent_id, session_key_prefix, model, is_active, created_at, updated_at)
       VALUES ('runner-sched-eval', 'MC Runner Dev', 'runner', '⚙️', 'standby', 0, 'default', 'gateway', 'mc-runner-dev', 'agent:mc-runner-dev:main', 'spark-lb/agent', 1, datetime('now'), datetime('now'))`,
  );
}

function buildCannedClient(reply: string): SendChatClient {
  const listeners = new Set<(p: ChatEvent) => void>();
  return {
    isConnected: () => true,
    on: (event, listener) => {
      if (event === 'chat_event') listeners.add(listener);
      return undefined;
    },
    off: (event, listener) => {
      if (event === 'chat_event') listeners.delete(listener);
      return undefined;
    },
    call: async (method, params) => {
      if (method !== 'chat.send') return undefined;
      const sessionKey = (params as { sessionKey?: string } | undefined)?.sessionKey;
      setImmediate(() => {
        for (const listener of listeners) {
          listener({ sessionKey, state: 'final', message: reply });
        }
      });
      return {};
    },
  };
}

export async function runScheduleEval(opts: ScheduleEvalOptions = {}): Promise<ScheduleEvalReport> {
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[:.]/g, '-')}_${uuidv4().slice(0, 6)}`;
  const outputDir = opts.outputDir ?? path.join(process.cwd(), 'tmp', 'research-eval-schedule');

  const workspaceId = ensureWorkspace();
  ensureResearcherAndRunner(workspaceId);
  const topic = createTopic({
    workspace_id: workspaceId,
    name: 'Scheduled-run eval topic',
    description: 'Survey: any small, deterministic prompt for the scheduled-run harness.',
  });
  const schedule = createResearchSchedule({
    workspace_id: workspaceId,
    topic_id: topic.id,
    brief_template: 'general_brief',
    cadence_seconds: 1,
    first_run_at: new Date().toISOString(),
  });

  const reply = opts.cannedReply ?? DEFAULT_REPLY;
  __setSendChatClientForTests(buildCannedClient(reply));

  let briefId: string | null = null;
  let briefStatus: ScheduleEvalReport['brief_status'] = 'missing';
  try {
    // Force the sweep tick for this single job.
    await dispatchRecurringJobOnce(schedule);

    // Find the brief produced by this schedule.
    const briefRow = queryOne<{ id: string; result_md: string | null; error_md: string | null }>(
      `SELECT id, result_md, error_md FROM briefs WHERE workspace_id = ? AND topic_id = ? ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, topic.id],
    );
    if (briefRow) {
      briefId = briefRow.id;
      briefStatus = briefRow.error_md ? 'failed' : 'complete';
    }
  } finally {
    __setSendChatClientForTests(null);
    // Self-cleanup: the eval creates a workspace + topic + schedule
    // with cadence_seconds=1 specifically so the sweeper picks it up
    // without waiting. If we leave that schedule in place, the
    // production recurring scheduler will keep firing it every 60s
    // forever, accumulating gateway sessions for no real benefit.
    // Read counters BEFORE deleting (the schedule row is dropped in
    // cleanup below, so querying it afterward would return null).
    const after = getRecurringJob(schedule.id);
    try {
      run(`DELETE FROM recurring_jobs WHERE id = ?`, [schedule.id]);
      run(`DELETE FROM briefs WHERE workspace_id = ?`, [workspaceId]);
      run(`DELETE FROM agent_runs WHERE workspace_id = ?`, [workspaceId]);
      run(`DELETE FROM topics WHERE id = ?`, [topic.id]);
      // The eval creates a fresh workspace per run (uuid suffix) so
      // dropping it is safe. Workspace cascade-deletes the agent
      // rows we inserted; runner is in 'default' so it's untouched.
      run(`DELETE FROM workspaces WHERE id = ?`, [workspaceId]);
    } catch (err) {
      console.warn('[schedule-eval] cleanup failed:', (err as Error).message);
    }
  }

  const after = getRecurringJob(schedule.id);
  const passed =
    briefStatus === 'complete' &&
    (after?.run_count ?? 0) === 1 &&
    (after?.consecutive_failures ?? 0) === 0;

  const report: ScheduleEvalReport = {
    run_id: runId,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    workspace_id: workspaceId,
    topic_id: topic.id,
    schedule_id: schedule.id,
    brief_id: briefId,
    brief_status: briefStatus,
    schedule_run_count_after: after?.run_count ?? 0,
    schedule_consecutive_failures_after: after?.consecutive_failures ?? 0,
    passed,
  };

  const runDir = path.join(outputDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'report.json'),
    JSON.stringify(report, null, 2),
  );
  return report;
}
