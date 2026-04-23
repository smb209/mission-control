/**
 * Tests for the URL resolution contract of internalDispatch.
 *
 * The actual fetch is not exercised here — we only verify that the loopback
 * URL is built from the server's own bind address (127.0.0.1:${PORT}),
 * NOT from MISSION_CONTROL_URL (which is the public/agent-facing URL and
 * is often the HOST port in Docker). Regressions on this rule would bring
 * back the "fetch failed" loop we just fixed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { internalDispatch } from './internal-dispatch';

// Capture every fetch the helper makes so we can assert on the URL, then
// short-circuit with a canned response so the test doesn't depend on a
// running server.
function installFetchSpy(): { urls: string[]; restore: () => void } {
  const urls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    urls.push(url);
    return Promise.resolve(new Response('ok', { status: 200 }));
  }) as typeof fetch;
  return {
    urls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function withEnv(overrides: Record<string, string | undefined>, fn: () => Promise<void>) {
  const originals: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) originals[k] = process.env[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test('internalDispatch targets 127.0.0.1:${PORT}, not MISSION_CONTROL_URL', async () => {
  const spy = installFetchSpy();
  try {
    await withEnv(
      { PORT: '4010', MISSION_CONTROL_URL: 'http://localhost:9999', INTERNAL_DISPATCH_URL: undefined },
      async () => {
        const r = await internalDispatch('task-xyz', { caller: 'test' });
        assert.equal(r.success, true);
        assert.equal(spy.urls.length, 1);
        assert.equal(spy.urls[0], 'http://127.0.0.1:4010/api/tasks/task-xyz/dispatch');
      },
    );
  } finally {
    spy.restore();
  }
});

test('internalDispatch falls back to port 4000 when PORT is unset', async () => {
  const spy = installFetchSpy();
  try {
    await withEnv(
      { PORT: undefined, MISSION_CONTROL_URL: undefined, INTERNAL_DISPATCH_URL: undefined },
      async () => {
        await internalDispatch('abc', { caller: 'test' });
        assert.equal(spy.urls[0], 'http://127.0.0.1:4000/api/tasks/abc/dispatch');
      },
    );
  } finally {
    spy.restore();
  }
});

test('internalDispatch honours INTERNAL_DISPATCH_URL override', async () => {
  const spy = installFetchSpy();
  try {
    await withEnv(
      {
        PORT: '4010',
        MISSION_CONTROL_URL: 'http://localhost:9999',
        INTERNAL_DISPATCH_URL: 'http://mc-sidecar:3000',
      },
      async () => {
        await internalDispatch('abc', { caller: 'test' });
        assert.equal(spy.urls[0], 'http://mc-sidecar:3000/api/tasks/abc/dispatch');
      },
    );
  } finally {
    spy.restore();
  }
});

test('internalDispatch surfaces the underlying cause when fetch throws', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    const err = new TypeError('fetch failed');
    (err as Error & { cause?: Record<string, unknown> }).cause = {
      name: 'AggregateError',
      code: 'ECONNREFUSED',
      syscall: 'connect',
      message: 'connect ECONNREFUSED 127.0.0.1:4010',
    };
    return Promise.reject(err);
  }) as typeof fetch;

  try {
    await withEnv({ PORT: '4010' }, async () => {
      const r = await internalDispatch('abc', { caller: 'test' });
      assert.equal(r.success, false);
      // The bare "fetch failed" has to be decorated with the cause so the
      // UI banner is actionable, not a mystery.
      assert.ok(r.error?.includes('fetch failed'), 'error should carry the original message');
      assert.ok(r.error?.includes('ECONNREFUSED'), 'error should include cause.code');
      assert.ok(
        r.error?.includes('connect ECONNREFUSED 127.0.0.1:4010'),
        'error should include cause.message so the operator sees the actual endpoint that refused',
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
