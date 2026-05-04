/**
 * Phase J1: subagent-dispatch primitive (skeleton).
 *
 * In Phase J2, MC's worker dispatch path (src/app/api/tasks/[id]/dispatch/route.ts)
 * will route through this primitive when MC_USE_SUBAGENT_SPAWN=1. The
 * primitive's job is to:
 *
 *   1. Build the worker briefing (role-soul + identity preamble + notetaker +
 *      task context + active-session manifest + trigger payload).
 *   2. Wrap that briefing into a META message the PM agent receives in its
 *      per-task coord session — telling the PM how to spawn (task=<briefing>,
 *      mode=run, context=<isolated|fork>, runTimeoutSeconds=<n>) and how to
 *      register the resulting runId via register_subagent_dispatch.
 *   3. Compute the per-task coord scope_key and dispatch the META message via
 *      `dispatchScope` (the PM acts on it).
 *
 * J1 ships the primitive without wiring it into the dispatch route. J2 wires
 * it. K removes the legacy fallback path and the feature flag.
 *
 * Why a primitive instead of inline construction in dispatch/route.ts:
 *  - The META envelope shape is stable contract for the PM's coord briefing.
 *    Centralizing it here keeps the PM-side instructions and MC-side
 *    construction in the same module's vicinity.
 *  - Tests can exercise primitive output without spinning up the full route
 *    handler.
 *  - The recurring-job dispatcher and the heartbeat coordinator can use the
 *    same primitive when (later) they want to spawn fan-out workers.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Agent } from '@/lib/types';
import { buildBriefing, type BriefingRole } from './briefing';
import { resolveSubagentContextMode, type SubagentContextMode } from './subagent-context';
import { computeScopeKey } from './dispatch-scope';

/**
 * Default runtime ceiling for a subagent. openclaw enforces this on its
 * end via `runTimeoutSeconds`. Conservative — most worker dispatches
 * complete in well under 30min; runaways get killed.
 */
const DEFAULT_RUN_TIMEOUT_SECONDS = 1800;

export interface DispatchSubagentInput {
  /** MC workspace UUID. */
  workspace_id: string;
  /** Worker role to spawn. */
  role: Exclude<BriefingRole, 'pm'>;
  /** The workspace's PM agent (the parent). */
  pm: Agent;
  /** Task this dispatch is for. */
  task_id: string;
  /** Optional initiative scope (some workers run against an initiative directly). */
  initiative_id?: string;
  /** Attempt number — 1 for first dispatch, 2+ for retries. */
  attempt: number;
  /**
   * The trigger-specific body the worker needs (task description,
   * acceptance criteria, prescribed commands, etc.). Caller composes
   * the same content `dispatch/route.ts` would have built for the
   * legacy worker session.
   */
  trigger_body: string;
  /** Optional per-spawn override of the context-mode role default. */
  context_mode?: SubagentContextMode;
  /** Override the runtime ceiling (default 1800s). */
  run_timeout_seconds?: number;
}

export interface DispatchSubagentResult {
  /** The full openclaw-shaped briefing the subagent will receive as `task:`. */
  worker_briefing: string;
  /** Resolved context mode after applying overrides + workspace settings. */
  context_mode: SubagentContextMode;
  /** Scope key for the PM's per-task coord session (where META lands). */
  pm_coord_scope_key: string;
  /** Suggested run_group_id for take_note grouping inside the subagent. */
  run_group_id: string;
  /** META message MC sends to the PM's coord session — drives sessions_spawn. */
  meta_message: string;
  /**
   * Length of the worker briefing in bytes — useful for the briefing-length
   * p95 metric (validation pack global gate GG8).
   */
  worker_briefing_bytes: number;
}

/**
 * Compose a subagent dispatch envelope. Pure function — no DB writes,
 * no openclaw round-trip. The caller (J2 dispatch route) takes the
 * meta_message and sends it through `dispatchScope` to the PM's coord
 * session.
 */
export function dispatchSubagent(input: DispatchSubagentInput): DispatchSubagentResult {
  const run_group_id = uuidv4();
  const context_mode = resolveSubagentContextMode({
    workspace_id: input.workspace_id,
    role: input.role,
    override: input.context_mode ?? null,
  });

  // The subagent itself receives this as `sessions_spawn({ task: … })`.
  // Same content shape `buildBriefing` produces for any worker today.
  const worker_briefing = buildBriefing({
    workspace_id: input.workspace_id,
    role: input.role,
    scope_key: '(child session — assigned by openclaw at spawn time)',
    agent_id: input.pm.id,
    gateway_agent_id:
      (input.pm as Agent & { gateway_agent_id?: string | null }).gateway_agent_id ?? '',
    run_group_id,
    is_resume: false,
    task_id: input.task_id,
    initiative_id: input.initiative_id,
    trigger_body: input.trigger_body,
  });

  const pm_coord_scope_key = computeScopeKey(input.pm, `coord-task-${input.task_id}`);
  const run_timeout = input.run_timeout_seconds ?? DEFAULT_RUN_TIMEOUT_SECONDS;

  // META message addressed to the PM. Documents:
  //  1) The exact sessions_spawn parameters MC wants applied.
  //  2) The follow-up call to register_subagent_dispatch with the runId.
  //  3) What the subagent's brief is (verbatim — no PM rewriting).
  // The PM's coord briefing template (Phase J2) trains the agent to
  // recognize this shape and act on it.
  const meta_message = [
    `**MC subagent dispatch (workspace=${input.workspace_id} task=${input.task_id})**`,
    '',
    `Spawn a **${input.role}** subagent for this task. Attempt #${input.attempt}.`,
    '',
    'Step 1: Call `sessions_spawn` (openclaw native MCP tool) with these arguments:',
    '',
    '```json',
    JSON.stringify(
      {
        task: '<<see WORKER_BRIEFING below — pass the whole block verbatim>>',
        mode: 'run',
        context: context_mode,
        runTimeoutSeconds: run_timeout,
        label: `${input.role}-${input.task_id.slice(0, 8)}-attempt${input.attempt}`,
      },
      null,
      2,
    ),
    '```',
    '',
    'Step 2: When `sessions_spawn` returns (it returns immediately with `runId` + `childSessionKey`), call MC\'s `register_subagent_dispatch` so MC can correlate `subagent_ended` events with this task:',
    '',
    '```json',
    JSON.stringify(
      {
        agent_id: '<your MC agent_id>',
        run_id: '<runId from sessions_spawn>',
        child_session_key: '<childSessionKey from sessions_spawn>',
        role: input.role,
        scope_type: 'task_role',
        task_id: input.task_id,
        ...(input.initiative_id ? { initiative_id: input.initiative_id } : {}),
        attempt: input.attempt,
      },
      null,
      2,
    ),
    '```',
    '',
    'Step 3: Wait for the subagent. openclaw will auto-announce the subagent\'s final reply back to you as a chat message when it completes. The subagent will also call MCP tools directly (`log_activity`, `take_note`, `register_deliverable`, `update_task_status`) so MC\'s state is updated regardless of whether the announcement reaches you.',
    '',
    'Step 4: When the announcement lands:',
    `- If the subagent succeeded and completed the work cleanly, do nothing — the work is recorded.`,
    `- If the subagent failed and you judge a retry is warranted, dispatch again with attempt=${input.attempt + 1}. Use a different brief if the prior approach was wrong.`,
    `- If the subagent flagged a blocker that needs the operator, take_note(audience='pm', importance=2, body='<one-line summary>').`,
    '',
    '---',
    '',
    'WORKER_BRIEFING (pass this entire block as the `task` parameter to `sessions_spawn`):',
    '',
    '```text',
    worker_briefing,
    '```',
  ].join('\n');

  return {
    worker_briefing,
    context_mode,
    pm_coord_scope_key,
    run_group_id,
    meta_message,
    worker_briefing_bytes: Buffer.byteLength(worker_briefing, 'utf8'),
  };
}
