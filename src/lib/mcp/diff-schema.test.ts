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

// -----------------------------------------------------------------------------
// PM convoy mandate (slice 1/7): create_convoy_under_initiative shape checks.
// Schema-only. DAG cycle / unknown-ref validation lives at apply time and is
// out of scope here. See docs/proposals/pm-convoy-mandate.md.
// -----------------------------------------------------------------------------

function makeSlice(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'slice_a',
    slice: 'Build the cancel endpoint and wire it through',
    message: 'Implement and ship the cancel endpoint per the AC list.',
    expected_deliverables: [{ title: 'cancel route handler', kind: 'file' }],
    acceptance_criteria: ['Endpoint returns 200 on a valid cancel request.'],
    expected_duration_minutes: 60,
    ...overrides,
  };
}

function makeConvoyDiff(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'create_convoy_under_initiative',
    initiative_id: 'init-1',
    parent_acceptance_criteria: [
      'Operator clicks Cancel on any in-flight proposal card and the card disappears.',
    ],
    slices: [makeSlice()],
    ...overrides,
  };
}

test('DiffSchema: create_convoy_under_initiative accepts minimal valid diff', () => {
  const result = DiffSchema.safeParse(makeConvoyDiff());
  assert.equal(result.success, true, result.success ? '' : JSON.stringify(result.error.issues));
});

test('DiffSchema: create_convoy_under_initiative accepts multi-slice with depends_on cross-refs', () => {
  const result = DiffSchema.safeParse(
    makeConvoyDiff({
      slices: [
        makeSlice({ id: 'slice_a' }),
        makeSlice({ id: 'slice_b', depends_on: ['slice_a'] }),
        makeSlice({ id: 'slice_c', depends_on: ['slice_a', 'slice_b'] }),
      ],
    }),
  );
  assert.equal(result.success, true, result.success ? '' : JSON.stringify(result.error.issues));
});

test('DiffSchema: create_convoy_under_initiative REJECTS empty slices array', () => {
  const result = DiffSchema.safeParse(makeConvoyDiff({ slices: [] }));
  assert.equal(result.success, false, 'empty slices array must be rejected');
});

test('DiffSchema: create_convoy_under_initiative REJECTS empty parent_acceptance_criteria', () => {
  const result = DiffSchema.safeParse(makeConvoyDiff({ parent_acceptance_criteria: [] }));
  assert.equal(result.success, false, 'empty parent_acceptance_criteria must be rejected');
});

test('DiffSchema: create_convoy_under_initiative REJECTS slice id containing a space', () => {
  const result = DiffSchema.safeParse(
    makeConvoyDiff({ slices: [makeSlice({ id: 'bad id' })] }),
  );
  assert.equal(result.success, false, 'slice id must match /^[a-zA-Z0-9_-]+$/');
});

test('DiffSchema: create_convoy_under_initiative REJECTS > 12 slices', () => {
  const slices = Array.from({ length: 13 }, (_, i) => makeSlice({ id: `slice_${i}` }));
  const result = DiffSchema.safeParse(makeConvoyDiff({ slices }));
  assert.equal(result.success, false, 'slices.max(12) must reject 13');
});

test('DiffSchema: create_convoy_under_initiative REJECTS parent AC shorter than 10 chars', () => {
  const result = DiffSchema.safeParse(makeConvoyDiff({ parent_acceptance_criteria: ['short'] }));
  assert.equal(result.success, false, 'parent_acceptance_criteria items must be >= 10 chars');
});
