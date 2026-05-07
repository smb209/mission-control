/**
 * Unit tests for the subtree-audit pure helpers
 * (PR 4 of specs/initiative-investigate.md).
 *
 * Covers:
 *   - enumerateLayersBottomUp: skips terminal nodes, layers leaves
 *     first, supports unbalanced trees up to 4 levels.
 *   - boundedAll: respects concurrency cap, surfaces failures as
 *     `{ ok: false, error }` envelopes without aborting the batch.
 *
 * runSubtreeAudit itself talks to the gateway via dispatchScope — that's
 * covered by the live dogfood loop documented in the spec, not here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enumerateLayersBottomUp,
  boundedAll,
} from './subtree-audit';

type Lite = Parameters<typeof enumerateLayersBottomUp>[1][number];

function node(
  id: string,
  parent: string | null,
  status: Lite['status'] = 'in_progress',
): Lite {
  return {
    id,
    title: `node ${id}`,
    kind: 'epic',
    status,
    description: null,
    status_check_md: null,
    target_start: null,
    target_end: null,
    parent_initiative_id: parent,
    workspace_id: 'w1',
  } as unknown as Lite;
}

test('enumerateLayersBottomUp: single non-terminal root → one layer of [root]', () => {
  const all = [node('r', null)];
  const layers = enumerateLayersBottomUp('r', all);
  assert.equal(layers.length, 1);
  assert.deepEqual(layers[0].map((i) => i.id), ['r']);
});

test('enumerateLayersBottomUp: balanced 3-level tree, leaves first', () => {
  const all = [
    node('r', null),
    node('a', 'r'),
    node('b', 'r'),
    node('a1', 'a'),
    node('a2', 'a'),
    node('b1', 'b'),
  ];
  const layers = enumerateLayersBottomUp('r', all);
  assert.equal(layers.length, 3);
  assert.deepEqual(
    layers[0].map((i) => i.id).sort(),
    ['a1', 'a2', 'b1'],
  );
  assert.deepEqual(
    layers[1].map((i) => i.id).sort(),
    ['a', 'b'],
  );
  assert.deepEqual(layers[2].map((i) => i.id), ['r']);
});

test('enumerateLayersBottomUp: skips done/cancelled descendants', () => {
  const all = [
    node('r', null),
    node('a', 'r', 'done'), // skipped
    node('b', 'r'),
    node('b1', 'b'),
    node('b2', 'b', 'cancelled'), // skipped
  ];
  const layers = enumerateLayersBottomUp('r', all);
  // a is terminal — a's whole branch dropped (no descendants of a).
  // b -> b1, b2 cancelled. So leaves: b1. layer1: b. layer2: r.
  assert.equal(layers.length, 3);
  assert.deepEqual(layers[0].map((i) => i.id), ['b1']);
  assert.deepEqual(layers[1].map((i) => i.id), ['b']);
  assert.deepEqual(layers[2].map((i) => i.id), ['r']);
});

test('enumerateLayersBottomUp: unbalanced 4-level tree depth = longest path', () => {
  const all = [
    node('r', null),
    node('a', 'r'),
    node('a1', 'a'),
    node('a1x', 'a1'),
    node('a1xy', 'a1x'), // depth 4 leaf
    node('b', 'r'), // shallow
  ];
  const layers = enumerateLayersBottomUp('r', all);
  // Depths: a1xy=0, b=0, a1x=1, a1=2, a=3, r=4.
  // b is shallow but should land in layer 0 (with the deep leaf).
  assert.equal(layers.length, 5);
  assert.deepEqual(layers[0].map((i) => i.id).sort(), ['a1xy', 'b']);
  assert.deepEqual(layers[1].map((i) => i.id), ['a1x']);
  assert.deepEqual(layers[2].map((i) => i.id), ['a1']);
  assert.deepEqual(layers[3].map((i) => i.id), ['a']);
  assert.deepEqual(layers[4].map((i) => i.id), ['r']);
});

test('enumerateLayersBottomUp: throws when root is terminal', () => {
  const all = [node('r', null, 'done')];
  assert.throws(() => enumerateLayersBottomUp('r', all), /terminal status/);
});

test('enumerateLayersBottomUp: zero non-terminal descendants → just the root', () => {
  const all = [
    node('r', null),
    node('a', 'r', 'done'),
    node('b', 'r', 'cancelled'),
  ];
  const layers = enumerateLayersBottomUp('r', all);
  assert.equal(layers.length, 1);
  assert.deepEqual(layers[0].map((i) => i.id), ['r']);
});

test('boundedAll: respects concurrency cap', async () => {
  let inflight = 0;
  let peak = 0;
  const tasks = Array.from({ length: 8 }, () => async () => {
    inflight++;
    peak = Math.max(peak, inflight);
    await new Promise((r) => setTimeout(r, 10));
    inflight--;
    return 'ok';
  });
  const out = await boundedAll(tasks, 3);
  assert.equal(out.length, 8);
  assert.ok(peak <= 3, `peak inflight ${peak} exceeded cap of 3`);
  assert.ok(out.every((r) => r.ok));
});

test('boundedAll: failures surface as envelopes, batch continues', async () => {
  const tasks = [
    async () => 1,
    async () => {
      throw new Error('boom');
    },
    async () => 3,
  ];
  const out = await boundedAll(tasks, 2);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { ok: true, value: 1 });
  assert.equal(out[1].ok, false);
  if (!out[1].ok) assert.equal(out[1].error.message, 'boom');
  assert.deepEqual(out[2], { ok: true, value: 3 });
});

test('boundedAll: empty task list resolves immediately', async () => {
  const out = await boundedAll([], 4);
  assert.deepEqual(out, []);
});

test('boundedAll: cap >= task count behaves like Promise.all-ish', async () => {
  const tasks = [async () => 'a', async () => 'b'];
  const out = await boundedAll(tasks, 16);
  assert.deepEqual(
    out.map((r) => (r.ok ? r.value : null)),
    ['a', 'b'],
  );
});
