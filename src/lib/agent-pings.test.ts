/**
 * Regression coverage for the sidebar activity-ping resolver.
 *
 * The PM agent ships with an explicit `session_key_prefix` of
 * `agent:mc-project-manager:main:` — and `buildAgentSessionKey` collapses
 * that to `agent:mc-project-manager:main` on the wire when sessionSuffix
 * is `main`. The prefix index has to mirror the collapse so the resolver
 * still maps the inbound/outbound sessionKey back to the PM's agent_id;
 * otherwise the activity dot never lights up.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { run } from '@/lib/db';
import {
  __resetPingsForTests,
  pingAgentBySessionKey,
  resolveAgentIdFromSessionKey,
  getAllAgentPings,
} from './agent-pings';

function seedAgent(opts: {
  id?: string;
  gateway?: string | null;
  prefix?: string | null;
  name?: string;
  workspace?: string;
} = {}): string {
  const id = opts.id ?? crypto.randomUUID();
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_active, gateway_agent_id, session_key_prefix, created_at, updated_at)
     VALUES (?, ?, 'builder', ?, 1, ?, ?, datetime('now'), datetime('now'))`,
    [id, opts.name ?? 'A', opts.workspace ?? 'default', opts.gateway ?? null, opts.prefix ?? null],
  );
  return id;
}

test('resolveAgentIdFromSessionKey: gateway-agent default prefix matches main + suffix forms', () => {
  __resetPingsForTests();
  const gw = `mc-builder-${crypto.randomUUID().slice(0, 8)}`;
  const id = seedAgent({ gateway: gw });

  assert.equal(resolveAgentIdFromSessionKey(`agent:${gw}:main`), id);
  assert.equal(resolveAgentIdFromSessionKey(`agent:${gw}:planning:abc`), id);
});

test('resolveAgentIdFromSessionKey: explicit `:main:` prefix resolves the COLLAPSED sessionKey (PM regression)', () => {
  __resetPingsForTests();
  const gw = `mc-pm-${crypto.randomUUID().slice(0, 8)}`;
  const id = seedAgent({
    gateway: gw,
    // Same shape as the seeded mc-project-manager: prefix already encodes
    // `:main:`, which buildAgentSessionKey collapses on send.
    prefix: `agent:${gw}:main:`,
  });

  // Outbound chat.send produces this collapsed key.
  assert.equal(
    resolveAgentIdFromSessionKey(`agent:${gw}:main`),
    id,
    'collapsed sessionKey must still resolve to the agent',
  );

  // Non-collapsed suffix still works (the longer indexed prefix wins).
  assert.equal(resolveAgentIdFromSessionKey(`agent:${gw}:main:scratch`), id);
});

test('pingAgentBySessionKey: PM-shape prefix lights up sent + received', () => {
  __resetPingsForTests();
  const gw = `mc-pm-${crypto.randomUUID().slice(0, 8)}`;
  const id = seedAgent({ gateway: gw, prefix: `agent:${gw}:main:` });
  const sessionKey = `agent:${gw}:main`;

  assert.equal(pingAgentBySessionKey(sessionKey, 'sent'), true);
  assert.equal(pingAgentBySessionKey(sessionKey, 'received'), true);

  const all = getAllAgentPings();
  assert.ok(all[id]?.sentAt, 'sentAt should be recorded');
  assert.ok(all[id]?.receivedAt, 'receivedAt should be recorded');
});

test('resolveAgentIdFromSessionKey: longer prefix wins when two agents could match', () => {
  __resetPingsForTests();
  const shortGw = `mc-svc-${crypto.randomUUID().slice(0, 8)}`;
  const longGw = `${shortGw}-2`;
  const shortId = seedAgent({ gateway: shortGw });
  const longId = seedAgent({ gateway: longGw });

  // The longer gateway-id's prefix (`agent:<short>-2:`) is more specific
  // than the shorter one's (`agent:<short>:`); both START with the short
  // prefix, but the longer should win because we sort desc by length.
  assert.equal(resolveAgentIdFromSessionKey(`agent:${longGw}:main`), longId);
  assert.equal(resolveAgentIdFromSessionKey(`agent:${shortGw}:main`), shortId);
});

test('resolveAgentIdFromSessionKey: returns null for an unknown sessionKey', () => {
  __resetPingsForTests();
  seedAgent({ gateway: `mc-known-${crypto.randomUUID().slice(0, 8)}` });
  assert.equal(resolveAgentIdFromSessionKey('agent:totally-unknown:main'), null);
  assert.equal(resolveAgentIdFromSessionKey(null), null);
  assert.equal(resolveAgentIdFromSessionKey(''), null);
});
