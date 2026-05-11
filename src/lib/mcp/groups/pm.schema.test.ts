/**
 * pm-tools MCP schema regression tests.
 *
 * Locks the JSON-schema export shape that agents see for the PM tools.
 * Every required-vs-optional flag and every `.describe()` is part of
 * the agent-facing contract — flipping one silently sends the PM into
 * a retry loop (see fix/pm-mcp-schema-clarity).
 *
 * The MCP SDK uses zod 4's `toJSONSchema` for zod-v4 schemas (see
 * node_modules/@modelcontextprotocol/sdk/.../zod-json-schema-compat.js).
 * We invoke the same path here so the test reflects what agents see.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import * as z4mini from 'zod/v4-mini';

import { agentIdArg, DiffSchema } from '../shared';

// Re-declare the propose_changes input schema as a single z.object so we
// can lift it into a JSON schema. Keep this in sync with pm.ts; the
// tests below assert the contract operators have come to depend on.
const ProposeChangesInput = z.object({
  agent_id: agentIdArg,
  workspace_id: z
    .string()
    .min(1)
    .describe('Workspace this proposal targets. Use the id from your whoami payload.'),
  trigger_text: z.string().min(1).max(20000).describe('REQUIRED. The operator statement, audit excerpt, or freeform note that prompted this proposal. Stored on the pm_proposals row so reviewers see what you were responding to. Markdown OK.'),
  trigger_kind: z
    .enum([
      'manual',
      'scheduled_drift_scan',
      'disruption_event',
      'status_check_investigation',
      'plan_initiative',
      'decompose_initiative',
      'decompose_story',
      'notes_intake',
    ])
    .optional()
    .describe('How this proposal originated.'),
  impact_md: z.string().min(1).max(20000).describe('REQUIRED.'),
  changes: z
    .preprocess((val) => {
      if (typeof val === 'string') {
        try {
          return JSON.parse(val);
        } catch {
          return val;
        }
      }
      return val;
    }, z.array(DiffSchema))
    .describe('REQUIRED.'),
  parent_proposal_id: z.string().nullish().describe('Optional.'),
  plan_suggestions: z
    .preprocess((val) => {
      if (typeof val === 'string') {
        try {
          return JSON.parse(val);
        } catch {
          return val;
        }
      }
      return val;
    }, z.record(z.string(), z.unknown()))
    .nullish()
    .describe('Optional — only for plan_initiative proposals.'),
});

interface JsonSchema {
  properties?: Record<string, { description?: string }>;
  required?: string[];
}

function lift(schema: z.ZodTypeAny): JsonSchema {
  return z4mini.toJSONSchema(schema as unknown as Parameters<typeof z4mini.toJSONSchema>[0], {
    target: 'draft-7',
    io: 'input',
  }) as JsonSchema;
}

test('propose_changes: required fields = exactly trigger_text + workspace_id + impact_md + changes + agent_id', () => {
  const json = lift(ProposeChangesInput);
  const required = new Set(json.required ?? []);
  // The four operator-meaningful required fields plus agent_id (set by the runtime).
  for (const f of ['agent_id', 'workspace_id', 'trigger_text', 'impact_md', 'changes']) {
    assert.ok(required.has(f), `expected ${f} to be required, got: ${[...required].join(', ')}`);
  }
});

test('propose_changes: plan_suggestions is OPTIONAL (regression for the audit-driven retry loop)', () => {
  const json = lift(ProposeChangesInput);
  const required = new Set(json.required ?? []);
  assert.ok(
    !required.has('plan_suggestions'),
    `plan_suggestions must NOT be required — moving .nullish() outside z.preprocess is the fix. Currently required=[${[...required].join(', ')}]`,
  );
});

test('propose_changes: parent_proposal_id is OPTIONAL', () => {
  const json = lift(ProposeChangesInput);
  const required = new Set(json.required ?? []);
  assert.ok(!required.has('parent_proposal_id'));
});

test('propose_changes: trigger_kind is OPTIONAL', () => {
  const json = lift(ProposeChangesInput);
  const required = new Set(json.required ?? []);
  assert.ok(!required.has('trigger_kind'));
});

test('propose_changes: every operator-facing field carries a description', () => {
  const json = lift(ProposeChangesInput);
  const props = json.properties ?? {};
  // agent_id is set by the runtime — we don't require a description there.
  for (const f of [
    'workspace_id',
    'trigger_text',
    'trigger_kind',
    'impact_md',
    'changes',
    'parent_proposal_id',
    'plan_suggestions',
  ]) {
    const desc = props[f]?.description;
    assert.ok(
      desc && desc.length > 0,
      `expected ${f} to have a JSON-schema description; got: ${JSON.stringify(desc)}`,
    );
  }
});

test('propose_changes: trigger_text and impact_md descriptions begin with REQUIRED', () => {
  // The "REQUIRED." prefix is the visible cue agents pick up on. If a
  // future change rewords it, this test gives a heads-up so we keep
  // the cue word that helped Margaret recover from her misfire.
  const json = lift(ProposeChangesInput);
  const props = json.properties ?? {};
  assert.match(props.trigger_text!.description!, /^REQUIRED\./);
  assert.match(props.impact_md!.description!, /^REQUIRED\./);
});

// ─── Diff schema regressions ──────────────────────────────────────

test('create_task_under_initiative: rejects empty assigned_agent_id (regression for FK bug)', () => {
  // Pre-fix: the validator's `if (c.assigned_agent_id)` skipped empty
  // strings, then the apply pass passed "" to an INSERT and hit the
  // tasks.assigned_agent_id FK at runtime. The schema now rejects ""
  // at the MCP boundary (.min(1).nullish()).
  const result = DiffSchema.safeParse({
    kind: 'create_task_under_initiative',
    initiative_id: 'init-1',
    title: 'A task',
    assigned_agent_id: '',
  });
  assert.equal(result.success, false);
});

test('create_task_under_initiative: accepts null/undefined/omitted assigned_agent_id', () => {
  for (const value of [null, undefined]) {
    const result = DiffSchema.safeParse({
      kind: 'create_task_under_initiative',
      initiative_id: 'init-1',
      title: 'A task',
      assigned_agent_id: value,
    });
    assert.equal(result.success, true, `expected ${value} to be accepted`);
  }
  const omitted = DiffSchema.safeParse({
    kind: 'create_task_under_initiative',
    initiative_id: 'init-1',
    title: 'A task',
  });
  assert.equal(omitted.success, true);
});

test('confirm_task_done: rejects payloads missing evidence_md', () => {
  const result = DiffSchema.safeParse({
    kind: 'confirm_task_done',
    task_id: 't-1',
    commit_sha: '1234abc',
  });
  assert.equal(result.success, false);
});

test('confirm_task_done: rejects evidence_md shorter than 20 chars', () => {
  const result = DiffSchema.safeParse({
    kind: 'confirm_task_done',
    task_id: 't-1',
    evidence_md: 'too short',
    commit_sha: '1234abc',
  });
  assert.equal(result.success, false);
});

test('confirm_task_done: rejects malformed commit_sha', () => {
  const result = DiffSchema.safeParse({
    kind: 'confirm_task_done',
    task_id: 't-1',
    evidence_md: 'Audit confirms shipped — see commit log.',
    commit_sha: 'XYZ-not-hex',
  });
  assert.equal(result.success, false);
});

test('confirm_task_done: accepts valid payload with audit_proposal_id', () => {
  const result = DiffSchema.safeParse({
    kind: 'confirm_task_done',
    task_id: 't-1',
    evidence_md: 'Audit proposal confirmed all checks passed end-to-end.',
    audit_proposal_id: 'audit-uuid-here',
  });
  assert.equal(result.success, true);
});
