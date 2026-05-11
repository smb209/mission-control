/**
 * Unit tests for the Investigate-flow helpers (PR 3 of
 * docs/archive/initiative-investigate.md).
 *
 * The project doesn't ship React component tests today (no .test.tsx
 * suites), so we cover the modal's gating + body shape via these pure
 * helpers. The modal itself is exercised manually via the dogfood loop
 * documented in the PR body.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countPriorAudits,
  buildInvestigateBody,
} from './investigate-helpers';
import type { AgentNoteRecord } from '@/hooks/useAgentNotes';

function note(over: Partial<AgentNoteRecord>): AgentNoteRecord {
  return {
    id: 'n-x',
    workspace_id: 'ws-1',
    agent_id: 'a-1',
    task_id: null,
    initiative_id: 'init-1',
    scope_key: 'sk',
    role: 'researcher',
    run_group_id: 'rg',
    kind: 'observation',
    audience: 'pm',
    body: 'body',
    attached_files: [],
    importance: 2,
    archived_at: null,
    created_at: '2026-05-05T00:00:00Z',
    ...over,
  };
}

test('countPriorAudits — counts only kind=observation, audience=pm, importance>=2, not archived', () => {
  const notes: AgentNoteRecord[] = [
    note({ id: '1' }),                                         // ✓ qualifies
    note({ id: '2', kind: 'breadcrumb' }),                     // ✗ wrong kind
    note({ id: '3', audience: 'self' }),                       // ✗ wrong audience
    note({ id: '4', importance: 1 }),                          // ✗ low importance
    note({ id: '5', importance: 0 }),                          // ✗ low importance
    note({ id: '6', archived_at: '2026-05-04T00:00:00Z' }),    // ✗ archived
    note({ id: '7' }),                                         // ✓ qualifies
  ];
  assert.equal(countPriorAudits(notes), 2);
});

test('countPriorAudits — empty list returns 0', () => {
  assert.equal(countPriorAudits([]), 0);
});

test('buildInvestigateBody — fresh + no guidance omits guidance key', () => {
  const body = buildInvestigateBody({ reaudit: 'fresh', guidance: '' });
  assert.deepEqual(body, { mode: 'narrow', reaudit: 'fresh' });
  assert.equal('guidance' in body, false);
});

test('buildInvestigateBody — whitespace-only guidance is treated as empty', () => {
  const body = buildInvestigateBody({ reaudit: 'fresh', guidance: '   \n\t  ' });
  assert.deepEqual(body, { mode: 'narrow', reaudit: 'fresh' });
});

test('buildInvestigateBody — build_on with guidance trims and includes', () => {
  const body = buildInvestigateBody({
    reaudit: 'build_on',
    guidance: '  check db migrations  ',
  });
  assert.deepEqual(body, {
    mode: 'narrow',
    reaudit: 'build_on',
    guidance: 'check db migrations',
  });
});

test('buildInvestigateBody — mode is hard-coded to narrow (PR 3 scope)', () => {
  const body = buildInvestigateBody({ reaudit: 'fresh', guidance: 'x' });
  assert.equal(body.mode, 'narrow');
});
