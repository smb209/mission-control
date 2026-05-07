/**
 * take_note MCP schema regression tests.
 *
 * Locks the JSON-schema export shape that agents see for take_note. The
 * agent-facing description tells researchers what to do when their
 * audit body overflows the 3000-char cap (= register a deliverable
 * and keep the body to a summary). Without that hint, agents burn
 * retries trying to trim a structured report under the cap and
 * eventually drop the audit entirely.
 *
 * See chat-mc-runner-1778192581039.md for the failure mode this
 * regression locks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import * as z4mini from 'zod/v4-mini';

import { agentIdArg, noteKindArg, noteImportanceArg } from '../shared';
import { NOTE_BODY_MAX } from '@/lib/db/agent-notes';

// Re-declare the take_note input schema from core.ts so we can lift
// it into a JSON schema without standing up the whole MCP server.
// Keep this in sync with core.ts; the tests assert the contract
// agents have come to depend on.
const TakeNoteInput = z.object({
  agent_id: agentIdArg,
  kind: noteKindArg,
  body: z
    .string()
    .min(1)
    .max(NOTE_BODY_MAX)
    .describe(
      `REQUIRED. Concrete > aspirational. One thought per note. Hard limit ${NOTE_BODY_MAX} characters. If your finding doesn't fit (e.g. a multi-section audit report), attach the full report as a deliverable via register_deliverable and use this body for a tight summary + verdict + link only. Reference file paths in attached_files.`,
    ),
  scope_key: z.string().min(1).describe('REQUIRED.'),
  role: z.string().min(1).describe('REQUIRED.'),
  run_group_id: z.string().min(1).describe('REQUIRED.'),
  task_id: z.string().optional().describe('Optional.'),
  initiative_id: z.string().optional().describe('Optional.'),
  audience: z.string().optional().describe('Optional.'),
  attached_files: z.array(z.string()).optional().describe('Optional.'),
  importance: noteImportanceArg.optional(),
});

interface JsonSchema {
  properties?: Record<string, { description?: string; maxLength?: number }>;
  required?: string[];
}

function lift(schema: z.ZodTypeAny): JsonSchema {
  return z4mini.toJSONSchema(schema as unknown as Parameters<typeof z4mini.toJSONSchema>[0], {
    target: 'draft-7',
    io: 'input',
  }) as JsonSchema;
}

test('take_note: body, scope_key, role, run_group_id are required', () => {
  const required = new Set(lift(TakeNoteInput).required ?? []);
  for (const f of ['body', 'scope_key', 'role', 'run_group_id']) {
    assert.ok(required.has(f), `expected ${f} required, got [${[...required].join(', ')}]`);
  }
});

test('take_note: body description states the char cap explicitly (regression for audit retry loop)', () => {
  const desc = lift(TakeNoteInput).properties?.body?.description ?? '';
  assert.match(
    desc,
    new RegExp(`${NOTE_BODY_MAX}\\s*character`),
    `body description must mention the ${NOTE_BODY_MAX}-char cap so agents stop retry-looping on overflow. Got: ${desc}`,
  );
});

test('take_note: body description points at register_deliverable as the escape valve', () => {
  const desc = lift(TakeNoteInput).properties?.body?.description ?? '';
  assert.match(
    desc,
    /register_deliverable/,
    `body description must mention register_deliverable so agents know what to do when a finding exceeds the cap. Got: ${desc}`,
  );
});

test('take_note: every required field description begins with REQUIRED.', () => {
  const props = lift(TakeNoteInput).properties ?? {};
  for (const f of ['body', 'scope_key', 'role', 'run_group_id']) {
    assert.match(
      props[f]?.description ?? '',
      /^REQUIRED\./,
      `${f} description should lead with REQUIRED. so agents see the requirement at a glance. Got: ${props[f]?.description}`,
    );
  }
});

test('take_note: optional fields lead with Optional.', () => {
  const props = lift(TakeNoteInput).properties ?? {};
  for (const f of ['task_id', 'initiative_id', 'audience', 'attached_files']) {
    assert.match(
      props[f]?.description ?? '',
      /^Optional\./,
      `${f} description should lead with Optional. Got: ${props[f]?.description}`,
    );
  }
});

test('take_note: maxLength on body matches NOTE_BODY_MAX', () => {
  const props = lift(TakeNoteInput).properties ?? {};
  assert.equal(props.body?.maxLength, NOTE_BODY_MAX);
});
