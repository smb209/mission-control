/**
 * Eval runner.
 *
 * Drives each fixture through the brief orchestrator (or a canned
 * reply when fixture.cannedReply is set) and applies the rubric.
 * Writes a per-run JSON report to tmp/research-eval/<run_id>/.
 *
 * Used by:
 *   - scripts/run-research-eval.ts (yarn research:eval entry point)
 *   - validation scenarios R6.1 and R6.2
 */

import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import { createBriefWithRun, getBrief } from '@/lib/db/briefs';
import { runBrief } from '@/lib/research/run-brief';
import {
  __setSendChatClientForTests,
  type ChatEvent,
  type SendChatClient,
} from '@/lib/openclaw/send-chat';
import { FIXTURES, type BriefFixture } from './fixtures';
import { scoreRubric, type RubricResult } from './rubric';

export interface EvalRunOptions {
  /** Directory to write reports under. Defaults to tmp/research-eval. */
  outputDir?: string;
  /** Workspace to use; created if absent. Defaults to a fresh one
   *  per run so eval doesn't pollute operator workspaces. */
  workspaceId?: string;
  /** Subset of fixture ids to run. Defaults to all. */
  only?: string[];
  /** Per-brief timeout (ms). Default 5min. */
  timeoutMs?: number;
}

export interface FixtureRunResult {
  fixture_id: string;
  brief_id: string;
  agent_run_id: string;
  status: 'complete' | 'failed';
  rubric: RubricResult;
}

export interface EvalRunReport {
  run_id: string;
  started_at: string;
  completed_at: string;
  workspace_id: string;
  fixtures: FixtureRunResult[];
  aggregate: number;
}

function ensureWorkspace(workspaceId?: string): string {
  const id = workspaceId ?? `ws-eval-${uuidv4().slice(0, 8)}`;
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [id, id, id],
  );
  return id;
}

function ensureResearcher(workspaceId: string): void {
  const existing = run(
    `SELECT 1 FROM agents WHERE workspace_id = ? AND role = 'researcher' LIMIT 1`,
    [workspaceId],
  );
  // run() returns RunResult, not rows. Use a probe insert with OR IGNORE
  // pattern instead — safer than depending on a select.
  run(
    `INSERT OR IGNORE INTO agents (id, name, role, avatar_emoji, status, is_master, workspace_id, source, gateway_agent_id, session_key_prefix, model, created_at, updated_at)
     VALUES (?, 'mc-researcher-eval', 'researcher', '🔍', 'standby', 0, ?, 'gateway', 'gw-eval', 'agent:gw-eval', 'spark-lb/agent', datetime('now'), datetime('now'))`,
    [`agent-eval-${workspaceId.slice(-8)}`, workspaceId],
  );
  void existing;
}

/** Build a stub openclaw client that emits a canned reply once and
 *  resolves chat.send. Used for fixtures with a cannedReply. */
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

export async function runOneFixture(
  workspaceId: string,
  fixture: BriefFixture,
  timeoutMs: number,
): Promise<FixtureRunResult> {
  const { brief, agent_run } = createBriefWithRun({
    workspace_id: workspaceId,
    template: fixture.template,
    title: fixture.title,
    prompt: fixture.prompt,
    requested_by: 'eval',
  });

  const cannedReply = fixture.cannedReply;
  let originalClient: SendChatClient | null = null;
  if (cannedReply) {
    __setSendChatClientForTests(buildCannedClient(cannedReply));
  }

  try {
    await runBrief(brief.id, { timeoutMs, awaitCompletionForTesting: true });
  } finally {
    if (cannedReply) {
      __setSendChatClientForTests(null);
    }
    void originalClient;
  }

  const reloaded = getBrief(brief.id);
  if (!reloaded) {
    throw new Error(`Eval lost track of brief ${brief.id} after run`);
  }
  const status: 'complete' | 'failed' = reloaded.error_md ? 'failed' : 'complete';
  const rubric = scoreRubric({
    result_md: reloaded.result_md,
    citations: reloaded.citations,
    error_md: reloaded.error_md,
  });

  return {
    fixture_id: fixture.id,
    brief_id: brief.id,
    agent_run_id: agent_run.id,
    status,
    rubric,
  };
}

export async function runEval(opts: EvalRunOptions = {}): Promise<EvalRunReport> {
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[:.]/g, '-')}_${uuidv4().slice(0, 6)}`;
  const outputDir = opts.outputDir ?? path.join(process.cwd(), 'tmp', 'research-eval');
  const workspaceId = ensureWorkspace(opts.workspaceId);
  ensureResearcher(workspaceId);

  const fixtures = opts.only
    ? FIXTURES.filter(f => opts.only!.includes(f.id))
    : FIXTURES;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

  const results: FixtureRunResult[] = [];
  for (const fixture of fixtures) {
    try {
      results.push(await runOneFixture(workspaceId, fixture, timeoutMs));
    } catch (err) {
      results.push({
        fixture_id: fixture.id,
        brief_id: '',
        agent_run_id: '',
        status: 'failed',
        rubric: scoreRubric({
          result_md: null,
          citations: [],
          error_md: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  }

  const aggregate = results.length > 0
    ? results.reduce((acc, r) => acc + r.rubric.aggregate, 0) / results.length
    : 0;

  const report: EvalRunReport = {
    run_id: runId,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    workspace_id: workspaceId,
    fixtures: results,
    aggregate,
  };

  // Write the report to disk for forensic review + validation R6 evidence.
  const runDir = path.join(outputDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'report.json'),
    JSON.stringify(report, null, 2),
  );

  return report;
}
