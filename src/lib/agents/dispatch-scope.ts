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
  type ChatEvent,
} from '@/lib/openclaw/send-chat';
import { buildBriefing, type BriefingRole } from './briefing';
import { upsertSession, type ScopeType } from '@/lib/db/mc-sessions';

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
   * Test seam: when set, returns the briefing without dispatching.
   * Used by unit tests that don't want to mock the gateway.
   */
  dry_run?: boolean;
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
    };
  }

  const reply = await sendChatAndAwaitReply({
    agent: input.agent,
    message: briefing,
    idempotencyKey: input.idempotencyKey ?? `dispatch-scope-${run_group_id}`,
    timeoutMs: input.timeoutMs,
    sessionSuffix: input.session_suffix,
    onEvent: input.onEvent,
  });

  return {
    scope_key,
    run_group_id,
    is_resume,
    briefing_bytes,
    briefing,
    reply,
  };
}
