/**
 * Unit tests for `sendChatToAgent` + `sendChatAndAwaitReply`.
 *
 * These exercise the helper in isolation against an in-memory client
 * stub — no network, no DB. Integration coverage (named-agent dispatch
 * path) lives in `src/lib/agents/pm.test.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sendChatToAgent,
  sendChatAndAwaitReply,
  buildAgentSessionKey,
  __setSendChatClientForTests,
  type ChatEvent,
  type SendChatClient,
} from './send-chat';

interface StubOpts {
  isConnected?: boolean;
  callImpl?: (
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>;
}

interface Stub {
  client: SendChatClient;
  emit: (event: ChatEvent) => void;
  callOrder: string[];
  sends: Array<{ method: string; params: unknown }>;
  /** True iff the listener was registered before the first send. */
  subscribedBeforeSend: () => boolean;
}

function makeStub(opts: StubOpts = {}): Stub {
  const listeners = new Set<(payload: ChatEvent) => void>();
  const callOrder: string[] = [];
  const sends: Array<{ method: string; params: unknown }> = [];
  let firstListenerAt: number | null = null;
  let firstSendAt: number | null = null;
  const client: SendChatClient = {
    isConnected: () => opts.isConnected ?? true,
    call: async (method, params) => {
      callOrder.push(`call:${method}`);
      if (firstSendAt === null) firstSendAt = callOrder.length;
      sends.push({ method, params });
      if (opts.callImpl) return opts.callImpl(method, params);
      return undefined;
    },
    on: (event, listener) => {
      callOrder.push(`on:${event}`);
      if (firstListenerAt === null) firstListenerAt = callOrder.length;
      if (event === 'chat_event') listeners.add(listener);
      return client;
    },
    off: (event, listener) => {
      if (event === 'chat_event') listeners.delete(listener);
      return client;
    },
  };
  return {
    client,
    emit: payload => {
      for (const l of listeners) l(payload);
    },
    callOrder,
    sends,
    subscribedBeforeSend: () =>
      firstListenerAt !== null &&
      firstSendAt !== null &&
      firstListenerAt < firstSendAt,
  };
}

const FAKE_AGENT = {
  id: 'agent-001',
  name: 'PM',
  gateway_agent_id: 'mc-project-manager',
  session_key_prefix: undefined,
} as const;

// ─── buildAgentSessionKey ───────────────────────────────────────────

test('buildAgentSessionKey: gateway_agent_id forms agent:<id>:main', () => {
  const sk = buildAgentSessionKey(FAKE_AGENT);
  assert.equal(sk, 'agent:mc-project-manager:main');
});

test('buildAgentSessionKey: explicit suffix is appended', () => {
  const sk = buildAgentSessionKey(FAKE_AGENT, 'task-abc');
  assert.equal(sk, 'agent:mc-project-manager:task-abc');
});

test('buildAgentSessionKey: collapses :main:main when prefix already encodes :main', () => {
  const sk = buildAgentSessionKey({
    id: 'a1',
    name: 'PM',
    gateway_agent_id: 'mc-project-manager',
    session_key_prefix: 'agent:mc-project-manager:main',
  });
  assert.equal(sk, 'agent:mc-project-manager:main');
});

// ─── sendChatToAgent ────────────────────────────────────────────────

test('sendChatToAgent: resolves the right sessionKey for a gateway agent', async () => {
  const stub = makeStub();
  __setSendChatClientForTests(stub.client);
  try {
    const result = await sendChatToAgent({
      agent: FAKE_AGENT,
      message: 'hi',
    });
    assert.equal(result.sent, true);
    assert.equal(result.sessionKey, 'agent:mc-project-manager:main');
    const params = stub.sends[0].params as Record<string, unknown>;
    assert.equal(params.sessionKey, 'agent:mc-project-manager:main');
    assert.equal(params.message, 'hi');
    assert.equal(typeof params.idempotencyKey, 'string');
  } finally {
    __setSendChatClientForTests(null);
  }
});

test('sendChatToAgent: returns no_session when client is disconnected', async () => {
  const stub = makeStub({ isConnected: false });
  __setSendChatClientForTests(stub.client);
  try {
    const result = await sendChatToAgent({
      agent: FAKE_AGENT,
      message: 'hi',
    });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'no_session');
    assert.equal(stub.sends.length, 0, 'should not call when disconnected');
  } finally {
    __setSendChatClientForTests(null);
  }
});

test('sendChatToAgent: returns send_failed when client throws', async () => {
  const stub = makeStub({
    callImpl: async () => {
      throw new Error('gateway boom');
    },
  });
  __setSendChatClientForTests(stub.client);
  try {
    const result = await sendChatToAgent({
      agent: FAKE_AGENT,
      message: 'hi',
    });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'send_failed');
    assert.ok(result.error instanceof Error);
    assert.match(result.error!.message, /gateway boom/);
  } finally {
    __setSendChatClientForTests(null);
  }
});

test('sendChatToAgent: default idempotencyKey is a fresh uuid (unique per call)', async () => {
  const stub = makeStub();
  __setSendChatClientForTests(stub.client);
  try {
    await sendChatToAgent({ agent: FAKE_AGENT, message: 'a' });
    await sendChatToAgent({ agent: FAKE_AGENT, message: 'b' });
    const k1 = (stub.sends[0].params as { idempotencyKey: string }).idempotencyKey;
    const k2 = (stub.sends[1].params as { idempotencyKey: string }).idempotencyKey;
    assert.notEqual(k1, k2);
    // uuid v4 shape
    assert.match(k1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    __setSendChatClientForTests(null);
  }
});

test('sendChatToAgent: explicit idempotencyKey is forwarded', async () => {
  const stub = makeStub();
  __setSendChatClientForTests(stub.client);
  try {
    await sendChatToAgent({
      agent: FAKE_AGENT,
      message: 'hi',
      idempotencyKey: 'my-key',
    });
    const k = (stub.sends[0].params as { idempotencyKey: string }).idempotencyKey;
    assert.equal(k, 'my-key');
  } finally {
    __setSendChatClientForTests(null);
  }
});

// ─── sendChatAndAwaitReply ──────────────────────────────────────────

test('sendChatAndAwaitReply: resolves with reply events when done arrives', async () => {
  const expected = 'agent:mc-project-manager:main';
  // Build the stub so its callImpl can reference `stub` (closure binding).
  let stub!: Stub;
  stub = makeStub({
    callImpl: async (method) => {
      if (method === 'chat.send') {
        // Use queueMicrotask so events arrive AFTER the send promise
        // resolves but BEFORE the awaiting code times out.
        queueMicrotask(() => {
          stub.emit({ sessionKey: expected, state: 'streaming' });
          stub.emit({ sessionKey: expected, state: 'final', message: 'done' });
        });
      }
      return undefined;
    },
  });
  __setSendChatClientForTests(stub.client);
  try {
    const result = await sendChatAndAwaitReply({
      agent: FAKE_AGENT,
      message: 'hi',
      timeoutMs: 1_000,
    });
    assert.equal(result.sent, true);
    assert.equal(result.timedOut, false);
    assert.ok(result.doneEvent);
    assert.equal(result.doneEvent!.state, 'final');
    assert.ok((result.reply?.length ?? 0) >= 1);
  } finally {
    __setSendChatClientForTests(null);
  }
});

test('sendChatAndAwaitReply: timedOut when no done event arrives in time', async () => {
  const stub = makeStub();
  __setSendChatClientForTests(stub.client);
  try {
    const result = await sendChatAndAwaitReply({
      agent: FAKE_AGENT,
      message: 'hi',
      timeoutMs: 100,
    });
    assert.equal(result.sent, true);
    assert.equal(result.timedOut, true);
    assert.equal(result.doneEvent, undefined);
  } finally {
    __setSendChatClientForTests(null);
  }
});

test('sendChatAndAwaitReply: returns no_session shape without subscribing when disconnected', async () => {
  const stub = makeStub({ isConnected: false });
  __setSendChatClientForTests(stub.client);
  try {
    const result = await sendChatAndAwaitReply({
      agent: FAKE_AGENT,
      message: 'hi',
      timeoutMs: 100,
    });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'no_session');
    assert.ok(!stub.callOrder.some(s => s.startsWith('on:')), 'should not subscribe when no session');
    assert.equal(stub.sends.length, 0);
  } finally {
    __setSendChatClientForTests(null);
  }
});

test('sendChatAndAwaitReply: returns send_failed when client.call throws', async () => {
  const stub = makeStub({
    callImpl: async () => {
      throw new Error('gateway boom');
    },
  });
  __setSendChatClientForTests(stub.client);
  try {
    const result = await sendChatAndAwaitReply({
      agent: FAKE_AGENT,
      message: 'hi',
      timeoutMs: 100,
    });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'send_failed');
    assert.ok(result.error instanceof Error);
  } finally {
    __setSendChatClientForTests(null);
  }
});

test('sendChatAndAwaitReply: subscribes BEFORE sending (race protection)', async () => {
  const stub = makeStub();
  __setSendChatClientForTests(stub.client);
  try {
    await sendChatAndAwaitReply({
      agent: FAKE_AGENT,
      message: 'hi',
      timeoutMs: 50,
    });
    assert.equal(
      stub.subscribedBeforeSend(),
      true,
      'listener must be wired up before chat.send is called',
    );
  } finally {
    __setSendChatClientForTests(null);
  }
});

test('sendChatAndAwaitReply: ignores chat events for other sessionKeys', async () => {
  const stub = makeStub();
  __setSendChatClientForTests(stub.client);
  try {
    queueMicrotask(() => {
      stub.emit({ sessionKey: 'agent:other:main', state: 'final' });
    });
    const result = await sendChatAndAwaitReply({
      agent: FAKE_AGENT,
      message: 'hi',
      timeoutMs: 100,
    });
    // Should still time out — event was for a different sessionKey.
    assert.equal(result.timedOut, true);
  } finally {
    __setSendChatClientForTests(null);
  }
});

test('sendChatAndAwaitReply: custom isDone predicate fires before default state==="final"', async () => {
  const sk = 'agent:mc-project-manager:main';
  const stub = makeStub({
    callImpl: async () => {
      queueMicrotask(() => {
        stub.emit({ sessionKey: sk, state: 'streaming', message: 'partial' });
        // The custom predicate matches this — default `final` would not.
        stub.emit({ sessionKey: sk, state: 'streaming', message: 'STOP' });
      });
      return undefined;
    },
  });
  __setSendChatClientForTests(stub.client);
  try {
    const result = await sendChatAndAwaitReply({
      agent: FAKE_AGENT,
      message: 'hi',
      timeoutMs: 200,
      isDone: e => typeof e.message === 'string' && e.message.includes('STOP'),
    });
    assert.equal(result.timedOut, false);
    assert.ok(result.doneEvent);
    assert.equal(result.doneEvent!.message, 'STOP');
  } finally {
    __setSendChatClientForTests(null);
  }
});
