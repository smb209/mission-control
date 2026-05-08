/**
 * DiffSchema regression tests.
 *
 * Locks the operator-vs-agent boundary on `set_initiative_status` —
 * agent-proposed status updates may NOT include `done` or `cancelled`,
 * those are operator territory. Discovered when a real PM audit run
 * autonomously closed 4 stories on its own interpretation despite the
 * SOUL forbidding it; the SOUL was advisory and the schema let it
 * through. See chat-Margaret-Maps-Hamilton-1778204006063.md.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { DiffSchema } from './shared';

test('DiffSchema: set_initiative_status accepts non-terminal statuses', () => {
  for (const status of ['planned', 'in_progress', 'at_risk', 'blocked']) {
    const result = DiffSchema.safeParse({
      kind: 'set_initiative_status',
      initiative_id: 'init-1',
      status,
    });
    assert.equal(result.success, true, `expected ${status} to validate`);
  }
});

test('DiffSchema: set_initiative_status REJECTS done', () => {
  const result = DiffSchema.safeParse({
    kind: 'set_initiative_status',
    initiative_id: 'init-1',
    status: 'done',
  });
  assert.equal(
    result.success,
    false,
    'agent-proposed set_initiative_status with status=done must be rejected; closure is operator territory',
  );
});

test('DiffSchema: set_initiative_status REJECTS cancelled', () => {
  const result = DiffSchema.safeParse({
    kind: 'set_initiative_status',
    initiative_id: 'init-1',
    status: 'cancelled',
  });
  assert.equal(
    result.success,
    false,
    'agent-proposed set_initiative_status with status=cancelled must be rejected; cancellation is operator territory',
  );
});

test('DiffSchema: set_initiative_status REJECTS unknown status', () => {
  const result = DiffSchema.safeParse({
    kind: 'set_initiative_status',
    initiative_id: 'init-1',
    status: 'rumor',
  });
  assert.equal(result.success, false);
});
