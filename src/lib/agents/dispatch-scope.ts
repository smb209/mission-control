/**
 * dispatchScope — the generic scope-keyed dispatch primitive.
 *
 * Wraps `sendChatAndAwaitReply` with:
 *  - briefing composition via `buildBriefing()`
 *  - mc_sessions bookkeeping
 *  - run_group_id minting
 *  - resume detection (existing scope_key → is_resume=true)
 *
 * Phase B retrofits PM dispatch through this. Phase C+ uses it for
 * worker dispatches. See specs/scope-keyed-sessions.md §1, §2.3.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Agent } from '@/lib/types';
import type { PmProposalTriggerKind } from '@/lib/db/pm-proposals';
import {
  sendChatAndAwaitReply,
  type AgentEvent,
  type ChatEvent,
} from '@/lib/openclaw/send-chat';
import { buildBriefing, type BriefingRole } from './briefing';
import { upsertSession, type ScopeType } from '@/lib/db/mc-sessions';
import {
  startAgentRun,
  completeAgentRun,
  failAgentRun,
  scopeTypeToRunKind,
  type AgentRunSourceKind,
} from '@/lib/db/agent-runs';

/**
 * Map a PM trigger kind to its scope_type label. Worker / recurring /
 * heartbeat scopes are computed from caller context, not the trigger
 * kind, so they're not in this table.
 */
function pmTriggerToScopeType(kind: PmProposalTriggerKind | 'manual'): ScopeType {
  switch (kind) {
    case 'plan_initiative':
      return 'plan';
    case 'decompose_initiative':
      return 'decompose';
    case 'decompose_story':
      return 'decompose_story';
    case 'notes_intake':
      return 'notes_intake';
    default:
      return 'pm_chat';
  }
}

export interface DispatchScopeInput {
  /** The MC workspace this dispatch belongs to. */
  workspace_id: string;
  /** Which role's briefing to compose. */
  role: BriefingRole;
  /**
   * The gateway agent hosting the session. Today this is the PM agent
   * for PM dispatches; Phase C+ uses `mc-runner-dev` for workers.
   */
  agent: Agent;
  /**
   * Suffix appended to `agent.session_key_prefix` to form the full
   * scope key. e.g. for PM disruption: 'dispatch-main'. For workers
   * (Phase C+): a fully-qualified scope segment like
   * 'task-<uuid>:builder:1'.
   */
  session_suffix: string;
  /**
   * The trigger-specific body. For PM dispatches today this is the
   * disruption + snapshot summary built by pm-dispatch. For workers
   * (Phase C+) it's the task context + ask.
   */
  trigger_body: string;
  /** Optional task / initiative scope refs for mc_sessions bookkeeping. */
  task_id?: string | null;
  initiative_id?: string | null;
  /** Optional scope-type override; otherwise inferred from trigger_kind. */
  scope_type?: ScopeType;
  /** PM trigger kind (drives scope_type when scope_type isn't passed). */
  trigger_kind?: PmProposalTriggerKind | 'manual';
  /** Per-call timeout override (defaults to sendChatAndAwaitReply's). */
  timeoutMs?: number;
  /**
   * Idempotency key forwarded to chat.send. Caller-supplied so the
   * caller can correlate downstream rows with this dispatch.
   */
  idempotencyKey?: string;
  /**
   * When 'fresh', the caller has already incremented the attempt
   * counter in the session_suffix; the new scope_key is treated as
   * net-new. Default 'reuse' — re-dispatching with the same key
   * counts as a resume.
   */
  attempt_strategy?: 'fresh' | 'reuse';
  /** Optional event listener forwarded to sendChatAndAwaitReply. */
  onEvent?: (event: ChatEvent) => void;
  /**
   * Optional agent_event listener forwarded to sendChatAndAwaitReply.
   * Tool calls, tool results, and status transitions ride this
   * channel; pm-dispatch's PR D taps it to surface tool calls in
   * the operator's in-flight panel.
   */
  onAgentEvent?: (event: AgentEvent) => void;
  /**
   * Test seam: when set, returns the briefing without dispatching.
   * Used by unit tests that don't want to mock the gateway.
   */
  dry_run?: boolean;
  /**
   * Optional parent agent_runs.id for fan-out dispatches (subtree audit
   * leaves attribute up to the root run). Forwarded to startAgentRun.
   */
  parent_run_id?: string | null;
  /** source_kind for the agent_runs row. Defaults to 'manual'. */
  source_kind?: AgentRunSourceKind;
  /** Free-form source ref (recurring_job_id, parent run id, etc.). */
  source_ref?: string | null;
  /** Display label snapshot at dispatch time (rendered in /jobs UI). */
  label?: string | null;
  /** Optional pm_proposals.id for pm_chat dispatches — recorded on
   *  agent_runs so the cancel cascade can flip the linked proposal to
   *  `synth_only` (PR 5 of jobs-in-progress). */
  pm_proposal_id?: string | null;
  /**
   * Skip the agent_runs lifecycle bookkeeping. Used by callers (today:
   * brief dispatch via run-brief.ts) that already manage their own
   * agent_runs row externally and would otherwise double-write.
   */
  skip_run_row?: boolean;
}

export interface DispatchScopeResult {
  /** The full openclaw sessionKey this dispatch was sent to. */
  scope_key: string;
  /** UUID minted for this dispatch — pass into take_note for grouping. */
  run_group_id: string;
  /** True if the scope_key already had prior trajectory before this turn. */
  is_resume: boolean;
  /** Length of the composed briefing in bytes. */
  briefing_bytes: number;
  /** The composed briefing text (returned for tests / dry runs / logging). */
  briefing: string;
  /** The result from sendChatAndAwaitReply, or null on dry_run. */
  reply: Awaited<ReturnType<typeof sendChatAndAwaitReply>> | null;
  /**
   * agent_runs.id for the row created by this dispatch, or null when
   * dry_run / skip_run_row is set. PR 1 of jobs-in-progress.
   */
  run_id: string | null;
}

/**
 * Compute the full scope key.
 *
 * Today: `${agent.session_key_prefix}:${session_suffix}`. Workers
 * during Phase C+ pass session_suffix in the spec's canonical shape
 * (e.g. 'task-<uuid>:builder:1') and the prefix is `agent:mc-runner-dev:main`.
 */
export function computeScopeKey(agent: Agent, sessionSuffix: string): string {
  const prefix = (agent as Agent & { session_key_prefix?: string | null }).session_key_prefix ?? '';
  return prefix ? `${prefix}:${sessionSuffix}` : sessionSuffix;
}

/**
 * Dispatch a briefing to a scope-keyed session. Returns the result
 * envelope (briefing, scope_key, reply, etc.) without taking any
 * post-reply actions — the caller decides what to do with the reply.
 */
export async function dispatchScope(input: DispatchScopeInput): Promise<DispatchScopeResult> {
  const scope_key = computeScopeKey(input.agent, input.session_suffix);
  const run_group_id = uuidv4();
  const scopeType = input.scope_type ?? pmTriggerToScopeType(input.trigger_kind ?? 'manual');

  // Bookkeeping: insert or touch the mc_sessions row before we send.
  // is_resume comes from whether we already had a row for this key.
  const { is_new } = upsertSession({
    scope_key,
    workspace_id: input.workspace_id,
    role: input.role,
    scope_type: scopeType,
    task_id: input.task_id ?? null,
    initiative_id: input.initiative_id ?? null,
  });

  // attempt_strategy='fresh' means the caller already minted a new
  // suffix; treat it as not-resume even if a row is somehow there
  // (defense-in-depth).
  const is_resume = input.attempt_strategy === 'fresh' ? false : !is_new;

  const briefing = buildBriefing({
    workspace_id: input.workspace_id,
    role: input.role,
    scope_key,
    agent_id: input.agent.id,
    gateway_agent_id: (input.agent as Agent & { gateway_agent_id?: string | null }).gateway_agent_id ?? '',
    run_group_id,
    is_resume,
    task_id: input.task_id ?? undefined,
    initiative_id: input.initiative_id ?? undefined,
    trigger_body: input.trigger_body,
  });
  const briefing_bytes = Buffer.byteLength(briefing, 'utf8');

  if (input.dry_run) {
    return {
      scope_key,
      run_group_id,
      is_resume,
      briefing_bytes,
      briefing,
      reply: null,
      run_id: null,
    };
  }

  // Jobs-in-Progress (PR 1): every non-dry-run dispatch lands in
  // agent_runs so /jobs can surface live + recently-completed work.
  // Callers that manage their own agent_runs row (today: brief
  // dispatch) opt out via `skip_run_row`.
  let run_id: string | null = null;
  if (!input.skip_run_row) {
    try {
      run_id = startAgentRun({
        workspace_id: input.workspace_id,
        kind: scopeTypeToRunKind(scopeType),
        scope_key,
        scope_type: scopeType,
        role: input.role,
        agent_id: input.agent.id,
        initiative_id: input.initiative_id ?? null,
        task_id: input.task_id ?? null,
        parent_run_id: input.parent_run_id ?? null,
        source_kind: input.source_kind ?? 'manual',
        source_ref: input.source_ref ?? null,
        label: input.label ?? null,
        // PR 5: capture the briefing as-sent so the /jobs drill-down
        // can replay what the agent saw. Composed briefing (not just
        // trigger_body) so the operator sees the full system context.
        trigger_body: briefing,
        pm_proposal_id: input.pm_proposal_id ?? null,
        // Persist the briefing's run_group_id on the agent_runs row so
        // downstream tools (take_note, …) can map a worker's
        // run_group_id back to its run and refuse writes after cancel.
        // See specs/dedupe-investigations.md.
        run_group_id,
      });
    } catch (err) {
      // Don't let an agent_runs write failure break dispatch. Log and
      // continue — the dispatch itself is the operator's primary action.
      console.warn(
        '[dispatchScope] startAgentRun failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  try {
    const reply = await sendChatAndAwaitReply({
      agent: input.agent,
      message: briefing,
      idempotencyKey: input.idempotencyKey ?? `dispatch-scope-${run_group_id}`,
      timeoutMs: input.timeoutMs,
      sessionSuffix: input.session_suffix,
      onEvent: input.onEvent,
      onAgentEvent: input.onAgentEvent,
    });

    if (run_id) {
      // sendChatAndAwaitReply's reply object doesn't expose model_used /
      // cost_cents directly today; gateway-side accounting lands those
      // on a different channel. Pass null for now; PR 2+ can backfill
      // from the gateway response shape if/when it stabilises.
      const sessionId = reply?.sessionKey ?? null;
      try {
        completeAgentRun(run_id, {
          openclaw_session_id: sessionId,
          model_used: input.agent.model ?? null,
          cost_cents: null,
        });
      } catch (err) {
        console.warn(
          '[dispatchScope] completeAgentRun failed:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return {
      scope_key,
      run_group_id,
      is_resume,
      briefing_bytes,
      briefing,
      reply,
      run_id,
    };
  } catch (err) {
    if (run_id) {
      const errorMd = err instanceof Error ? err.message : String(err);
      try {
        failAgentRun(run_id, errorMd);
      } catch (failErr) {
        console.warn(
          '[dispatchScope] failAgentRun failed:',
          failErr instanceof Error ? failErr.message : String(failErr),
        );
      }
    }
    throw err;
  }
}
