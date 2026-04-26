/**
 * Centralised `chat.send` helpers for MC → openclaw routing.
 *
 * Two surfaces:
 *
 *   1. `sendChatToAgent(...)` — fire-and-forget chat send. Resolves the
 *      sessionKey from an Agent row via `resolveAgentSessionKeyPrefix`,
 *      catches transport errors, and returns a structured result rather
 *      than throwing. Replaces the 5+ hand-rolled
 *      `client.call('chat.send', ...)` call sites (PR #55 follow-up).
 *
 *   2. `sendChatAndAwaitReply(...)` — subscribe-then-send-then-await
 *      primitive. Subscribes to the openclaw client's `chat_event` stream
 *      BEFORE sending so we never miss the first frame, then collects
 *      events until either the caller's `isDone` predicate fires or the
 *      deadline elapses. Used by `pm-dispatch.ts` to replace the
 *      polling-by-recency workaround.
 *
 * Design notes:
 *
 *   - The helper deliberately shallows the openclaw client (uses the
 *     singleton `getOpenClawClient()` by default; tests inject via
 *     `__setSendChatClientForTests`). It does NOT take a client param —
 *     that would make migration noisy at every call site.
 *
 *   - `sendChatToAgent` returns `{ sent: false, reason: 'no_session' }`
 *     when `client.isConnected()` is false. That mirrors the existing
 *     guard pattern (`if (client.isConnected()) ...`) used in every
 *     hand-rolled call site today.
 *
 *   - `sendChatAndAwaitReply` does not subscribe when the underlying send
 *     fails or there's no session — it short-circuits with the
 *     `SendChatResult` shape directly. Subscribing first only matters
 *     when we expect a reply.
 */

import { v4 as uuidv4 } from 'uuid';
import { getOpenClawClient } from './client';
import { resolveAgentSessionKeyPrefix } from './session-key';
import type { Agent } from '@/lib/types';

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Minimum agent shape needed to derive a sessionKey. Kept narrow so
 * callers can pass partial rows (e.g. mailbox loads only a few columns).
 */
export type SendChatAgent = Pick<
  Agent,
  'session_key_prefix' | 'gateway_agent_id' | 'name' | 'id'
>;

export interface SendChatInput {
  agent: SendChatAgent;
  message: string;
  /** Defaults to a fresh uuid. */
  idempotencyKey?: string;
  /** Appended to the resolved prefix. Defaults to 'main'. */
  sessionSuffix?: string;
}

export interface SendChatResult {
  sent: boolean;
  sessionKey: string;
  /** When `sent` is false, why. */
  reason?: 'no_session' | 'send_failed';
  error?: Error;
}

/**
 * Loose mirror of the `chat_event` payload emitted by `OpenClawClient`.
 * Matches `ChatEventPayload` in `chat-listener.ts` (kept compatible).
 */
export interface ChatEvent {
  runId?: string;
  sessionKey?: string;
  seq?: number;
  state?: string;
  message?: string | { role?: string; content?: unknown };
  // The gateway payload may include other fields; we don't model them here.
  [key: string]: unknown;
}

export interface SendChatAndAwaitInput extends SendChatInput {
  /** Wall-clock budget for the round-trip. Default 60_000ms. */
  timeoutMs?: number;
  /**
   * Predicate to recognise the agent's "done" frame. The default matches
   * `event.state === 'final'` — same signal the existing chat-listener
   * uses to write replies into agent_chat_messages / task_notes.
   */
  isDone?: (event: ChatEvent) => boolean;
  /** Tap for every matching event between send and done. */
  onEvent?: (event: ChatEvent) => void;
}

export interface SendChatAndAwaitResult extends SendChatResult {
  /** Events collected for this sessionKey between send and done. */
  reply?: ChatEvent[];
  doneEvent?: ChatEvent;
  /** True when the deadline elapsed before `isDone` fired. */
  timedOut?: boolean;
}

// ─── Test seam ──────────────────────────────────────────────────────

/**
 * Minimum surface we need from the openclaw client. The real
 * `OpenClawClient` satisfies this implicitly; tests inject a stub.
 */
export interface SendChatClient {
  isConnected: () => boolean;
  call: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  on: (event: 'chat_event', listener: (payload: ChatEvent) => void) => unknown;
  off: (event: 'chat_event', listener: (payload: ChatEvent) => void) => unknown;
}

let clientOverride: SendChatClient | null = null;

/** Test-only seam. Pass `null` to clear. */
export function __setSendChatClientForTests(c: SendChatClient | null): void {
  clientOverride = c;
}

function getClient(): SendChatClient {
  return clientOverride ?? (getOpenClawClient() as unknown as SendChatClient);
}

// ─── sessionKey resolution ──────────────────────────────────────────

/**
 * Resolve a sessionKey from an agent + optional suffix. Mirrors the
 * collapse logic from `pm-dispatch.buildPmSessionKey` so an agent whose
 * `session_key_prefix` already encodes `:main` doesn't end up with
 * `:main:main`.
 */
export function buildAgentSessionKey(
  agent: SendChatAgent,
  sessionSuffix: string = 'main',
): string {
  const prefix = resolveAgentSessionKeyPrefix(agent);
  // The resolver guarantees `prefix` ends with ':'. If the suffix is
  // 'main' AND the prefix is already `agent:<id>:main:` (set
  // explicitly), strip the trailing ':' so we don't double up.
  if (sessionSuffix === 'main' && /:main:$/.test(prefix)) {
    return prefix.replace(/:$/, '');
  }
  return `${prefix}${sessionSuffix}`;
}

// ─── sendChatToAgent ────────────────────────────────────────────────

/**
 * Send one chat.send frame to the agent's session. Catches transport
 * errors and returns a structured result instead of throwing — every
 * existing call site gates on `if (connected) { ... }` and either logs
 * or no-ops on failure, so non-throwing semantics simplify migration.
 *
 * Returns `{ sent: false, reason: 'no_session' }` when the openclaw
 * client reports it isn't connected. Returns
 * `{ sent: false, reason: 'send_failed', error }` when the underlying
 * call rejects (e.g. gateway timeout).
 */
export async function sendChatToAgent(input: SendChatInput): Promise<SendChatResult> {
  const sessionKey = buildAgentSessionKey(input.agent, input.sessionSuffix);
  const idempotencyKey = input.idempotencyKey ?? uuidv4();
  const client = getClient();

  if (!client.isConnected()) {
    return { sent: false, sessionKey, reason: 'no_session' };
  }

  try {
    await client.call('chat.send', {
      sessionKey,
      message: input.message,
      idempotencyKey,
    });
    return { sent: true, sessionKey };
  } catch (err) {
    return {
      sent: false,
      sessionKey,
      reason: 'send_failed',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

// ─── sendChatAndAwaitReply ──────────────────────────────────────────

const DEFAULT_AWAIT_TIMEOUT_MS = 60_000;

const DEFAULT_IS_DONE = (event: ChatEvent): boolean => event.state === 'final';

/**
 * Subscribe to the openclaw client's `chat_event` stream for the
 * resolved sessionKey, send the chat frame, then resolve when either:
 *   - `isDone(event)` returns true (default: `state === 'final'`), or
 *   - the timeout elapses.
 *
 * IMPORTANT: subscribe-before-send. If we sent first and the gateway
 * round-tripped a fast `final` frame before our listener was wired up,
 * we'd miss it and resort to timeout — exactly the failure mode this
 * primitive replaces in `pm-dispatch.ts`.
 *
 * On `no_session` / `send_failed` from the underlying send, we return
 * the SendChatResult shape WITHOUT subscribing (no point waiting for a
 * reply that can never arrive).
 */
export async function sendChatAndAwaitReply(
  input: SendChatAndAwaitInput,
): Promise<SendChatAndAwaitResult> {
  const sessionKey = buildAgentSessionKey(input.agent, input.sessionSuffix);
  const idempotencyKey = input.idempotencyKey ?? uuidv4();
  const timeoutMs = input.timeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;
  const isDone = input.isDone ?? DEFAULT_IS_DONE;
  const client = getClient();

  if (!client.isConnected()) {
    return { sent: false, sessionKey, reason: 'no_session' };
  }

  // Subscribe FIRST so we don't race the gateway's first frame.
  const collected: ChatEvent[] = [];
  let doneEvent: ChatEvent | undefined;
  let resolveDone: ((event: ChatEvent | null) => void) | null = null;
  const donePromise = new Promise<ChatEvent | null>(resolve => {
    resolveDone = resolve;
  });

  const listener = (payload: ChatEvent) => {
    if (!payload || payload.sessionKey !== sessionKey) return;
    collected.push(payload);
    try {
      input.onEvent?.(payload);
    } catch {
      // Caller's tap shouldn't break the wait.
    }
    if (isDone(payload)) {
      doneEvent = payload;
      resolveDone?.(payload);
    }
  };

  client.on('chat_event', listener);

  try {
    // Send the frame. If this fails, short-circuit with the SendChatResult
    // shape — no point waiting for a reply that can never arrive.
    let sendError: Error | undefined;
    try {
      await client.call('chat.send', {
        sessionKey,
        message: input.message,
        idempotencyKey,
      });
    } catch (err) {
      sendError = err instanceof Error ? err : new Error(String(err));
    }

    if (sendError) {
      return {
        sent: false,
        sessionKey,
        reason: 'send_failed',
        error: sendError,
      };
    }

    // Race the `done` event against the deadline.
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<null>(resolve => {
      timeoutHandle = setTimeout(() => resolve(null), timeoutMs);
    });

    const winner = await Promise.race([donePromise, timeoutPromise]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    if (winner === null && !doneEvent) {
      return {
        sent: true,
        sessionKey,
        reply: collected,
        timedOut: true,
      };
    }

    return {
      sent: true,
      sessionKey,
      reply: collected,
      doneEvent,
      timedOut: false,
    };
  } finally {
    client.off('chat_event', listener);
  }
}
