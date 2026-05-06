/**
 * Unit tests for buildAuditPrompt (PR 2 of initiative-investigate).
 *
 * The prompt is load-bearing on the take_note arg shape — the
 * researcher reads it verbatim. These tests guard against accidental
 * re-flowing that would change what the LLM sees.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuditPrompt } from './audit-prompt';

const baseInitiative = {
  id: 'init-abc-123',
  title: 'Roll out auth v2',
  kind: 'epic' as const,
  status: 'in_progress' as const,
  description: 'Migrate auth to OIDC.',
  status_check_md: '- IdP wired\n- Migration script TBD',
  target_start: '2026-04-01',
  target_end: '2026-05-15',
};

test('audit-prompt: includes initiative metadata + tasks block', () => {
  const out = buildAuditPrompt({
    initiative: baseInitiative,
    tasks: [
      { id: 't-1', title: 'Wire IdP', status: 'done' },
      { id: 't-2', title: 'Backfill users', status: 'in_progress' },
    ],
  });
  assert.match(out, /\*\*Initiative audit \(mode: narrow\)\*\*/);
  assert.match(out, /Roll out auth v2/);
  assert.match(out, /kind=epic/);
  assert.match(out, /status=in_progress/);
  assert.match(out, /id=init-abc-123/);
  assert.match(out, /2026-04-01 → 2026-05-15/);
  assert.match(out, /Wire IdP \(done\) \[task t-1\]/);
  assert.match(out, /Backfill users \(in_progress\) \[task t-2\]/);
});

test('audit-prompt: take_note call shape is exact (load-bearing)', () => {
  const out = buildAuditPrompt({
    initiative: baseInitiative,
    tasks: [],
  });
  // The exact arg shape researchers paste from. Re-flow at your peril.
  assert.match(
    out,
    /take_note\(\{\n {2}initiative_id: "init-abc-123",\n {2}kind: 'observation',\n {2}audience: 'pm',\n {2}importance: 2,\n {2}body: <full report>,\n\}\)/,
  );
});

test('audit-prompt: explicitly tells researcher NOT to call register_deliverable', () => {
  // PR 2 dropped register_deliverable because deliverables are
  // task-scoped today. The prompt must steer the researcher away
  // explicitly so a confused LLM doesn't try to call it on its own
  // and burn cycles on a 400.
  const out = buildAuditPrompt({
    initiative: baseInitiative,
    tasks: [],
  });
  assert.match(out, /register_deliverable/);
  assert.match(out, /deliverables system is task-scoped today/);
  // And we must NOT instruct the researcher to actually call it.
  assert.doesNotMatch(out, /register_deliverable\(\{[^}]*deliverable_type/);
});

test('audit-prompt: operator guidance flows into prompt when set', () => {
  const out = buildAuditPrompt({
    initiative: baseInitiative,
    tasks: [],
    guidance: 'Focus on the migration script — slice 3.',
  });
  assert.match(out, /## Operator focus/);
  assert.match(out, /Focus on the migration script — slice 3\./);
});

test('audit-prompt: prior findings block omitted when empty', () => {
  const out = buildAuditPrompt({
    initiative: baseInitiative,
    tasks: [],
    priorFindings: [],
  });
  assert.doesNotMatch(out, /Prior audit findings/);
});

test('audit-prompt: prior findings block rendered when present', () => {
  const out = buildAuditPrompt({
    initiative: baseInitiative,
    tasks: [],
    priorFindings: [
      {
        id: 'note-1',
        body: 'Slice 1 done. Slice 2 partial.',
        created_at: '2026-04-30T12:00:00Z',
      },
      {
        id: 'note-2',
        body: 'Slice 4 not started.',
        created_at: '2026-05-02T09:00:00Z',
      },
    ],
  });
  assert.match(out, /## Prior audit findings/);
  assert.match(out, /Prior note 1 \(2026-04-30T12:00:00Z\)/);
  assert.match(out, /Slice 1 done\. Slice 2 partial\./);
  assert.match(out, /Prior note 2 \(2026-05-02T09:00:00Z\)/);
  assert.match(out, /Slice 4 not started\./);
});

test('audit-prompt: empty tasks renders placeholder, not empty list', () => {
  const out = buildAuditPrompt({
    initiative: baseInitiative,
    tasks: [],
  });
  assert.match(out, /_\(this initiative has no direct child tasks\)_/);
});

test('audit-prompt: missing description / status_check / target window get placeholders', () => {
  const out = buildAuditPrompt({
    initiative: {
      ...baseInitiative,
      description: null,
      status_check_md: null,
      target_start: null,
      target_end: null,
    },
    tasks: [],
  });
  assert.match(out, /_\(no description\)_/);
  assert.match(out, /_\(none\)_/);
  assert.match(out, /_\(no target window set\)_/);
});

test('audit-prompt: includes the 6-section report structure + verdict enum', () => {
  const out = buildAuditPrompt({
    initiative: baseInitiative,
    tasks: [],
  });
  assert.match(out, /1\. \*\*Done with evidence\*\*/);
  assert.match(out, /2\. \*\*In-flight\*\*/);
  assert.match(out, /3\. \*\*Not started\*\*/);
  assert.match(out, /4\. \*\*Drift\*\*/);
  assert.match(out, /5\. \*\*Verdict\*\*/);
  assert.match(out, /6\. \*\*Recommended next action\*\*/);
  // Verdict enum members (the operator decision tree depends on these).
  for (const v of [
    'on track',
    'partially done',
    'stale \\(rescope\\)',
    'done in entirety',
    'never built',
    'cancelled-in-effect',
  ]) {
    assert.match(out, new RegExp(v));
  }
});

test('audit-prompt: greenfield early-exit instruction is present', () => {
  const out = buildAuditPrompt({
    initiative: baseInitiative,
    tasks: [],
  });
  assert.match(out, /early-exit/);
  assert.match(out, /never built — planned-only/);
});
